"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addNote,
  balance as calcBalance,
  loadWallet,
  markSpent,
  newBlinding,
  saveWallet,
  stellarKeypair,
  type Note,
  type Payment,
  type WalletState,
} from "@/lib/wallet";
import { DENOMINATIONS, type Denom } from "@/lib/config";
import * as wit from "@/lib/wasmWitness";
import * as chain from "@/lib/contracts";
import { prove, proofToSorobanHex } from "@/lib/prover";
import { merchantToField } from "@/lib/merchant";
import { encodeReceipt, proveReceipt, receiptPublicHex } from "@/lib/receiptProver";
import { selectCoins, type SelectionResult } from "@/lib/coinSelection";
import { getMerchant, merchantKeypair } from "@/lib/merchantWallet";
import { isValidHandle, slugifyHandle } from "@/lib/names";
import { parsePayLink, fmtFiat, cleanMerchant, type PayLinkData } from "@/lib/paylink";

// The canonical dummy input (slot 0 of a single-note spend): value-less, fixed
// nullifier the pool ignores. Matches DUMMY_PRIV/DUMMY_BLIND in the Rust crate.
const DUMMY_PRIV = "9001";
const DUMMY_BLIND = "9002";

type Screen = "home" | "receive" | "pay" | "claim";
type ProveStep = "idle" | "vouch" | "build" | "witness" | "prove" | "submit" | "done";

const Bean = ({ s = 20 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
    <ellipse cx="12" cy="12" rx="7" ry="10" fill="#b7f24a" />
    <path d="M12 3c-2 4-2 14 0 18" stroke="#0a0f08" strokeWidth="1.4" />
  </svg>
);

function fmtUSD(n: number) {
  const [d, c] = n.toFixed(2).split(".");
  return { dollars: `$${Number(d).toLocaleString()}`, cents: c };
}

export default function Page() {
  const [w, setW] = useState<WalletState | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [funded, setFunded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Onboarding to the REAL USDC rail (Phase R2-1): XLM + trustline + DEX swap.
  const [onboard, setOnboard] = useState<"provisioning" | "ready" | "dex-dry">("provisioning");
  const [onboardMsg, setOnboardMsg] = useState<string>("provisioning wallet…");
  const [usdcBal, setUsdcBal] = useState<number | null>(null);
  const [merchantAddr, setMerchantAddr] = useState<string | null>(null);

  const [depDenom, setDepDenom] = useState<Denom>(5);
  const [depositing, setDepositing] = useState(false);

  const [merchant, setMerchant] = useState("");
  const [claimInput, setClaimInput] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [step, setStep] = useState<ProveStep>("idle");
  const [paid, setPaid] = useState<{ amount: number; change: number; merchant: string; hash: string; payment: Payment } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // ---- receipt (selective disclosure) ----
  const [receiptFor, setReceiptFor] = useState<Payment | null>(null);
  const [receiptRecipient, setReceiptRecipient] = useState("");
  const [receiptStep, setReceiptStep] = useState<"idle" | "proving" | "verifying" | "done">("idle");
  const [receiptBlob, setReceiptBlob] = useState<string | null>(null);
  const [receiptVerifyTx, setReceiptVerifyTx] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  const [recipientCopied, setRecipientCopied] = useState(false);

  const update = (next: WalletState) => {
    setW(next);
    saveWallet(next);
  };

  // Claim a custom "<name>.cowrie" identity (local-only; no name registry).
  function claimName() {
    if (!w || !isValidHandle(claimInput)) return;
    update({ ...w, handle: slugifyHandle(claimInput) });
    setClaimInput("");
    setScreen("home");
  }

  function resetDemo() {
    // Fresh seedless wallet (new key + identity + empty notes). Handy to re-run
    // the demo on camera. Persisted notes are wiped intentionally.
    if (typeof window !== "undefined") {
      localStorage.removeItem("cowrie.wallet.v1");
      window.location.href = "/";
    }
  }

  const [prefillUsdc, setPrefillUsdc] = useState<number | null>(null);
  // An invoice loaded from a merchant pay-link/QR. When set, the Pay screen is
  // LOCKED to it — the buyer pays exactly this amount to exactly this address.
  const [payInvoice, setPayInvoice] = useState<PayLinkData | null>(null);

  // Onboard to the real USDC rail: friendbot XLM, then USDC trustline + a DEX
  // swap for a starting balance. Resilient: on dry DEX liquidity we surface a
  // clear "dex-dry" state with a Retry rather than a half-onboarded wallet.
  const onboardWallet = useCallback(async (wallet: WalletState) => {
    setOnboard("provisioning");
    setErr(null);
    try {
      const kp = stellarKeypair(wallet);
      setOnboardMsg("funding testnet XLM…");
      await chain.ensureFunded(kp.publicKey());
      setFunded(true);
      const bal = await chain.ensureUsdc(kp, { min: 1, target: 100, onStatus: setOnboardMsg });
      setUsdcBal(bal);
      setOnboard("ready");
    } catch (e) {
      if (e instanceof chain.DexDryError) {
        setOnboard("dex-dry");
        setOnboardMsg(e.message);
      } else {
        setErr(`onboarding: ${e instanceof Error ? e.message : e}`);
        setOnboard("dex-dry"); // recoverable via Retry
        setOnboardMsg(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    const wallet = loadWallet();
    setW(wallet);
    onboardWallet(wallet);
    // Pay-link from the merchant register — everything rides in the link:
    // /?pay=<merchant>&amt=<usdc>&addr=<G…>&fiat=<local>&cur=<code>&id=<pay-ID>
    const inv = parsePayLink(window.location.search);
    if (inv) {
      setPayInvoice(inv);
      setMerchant(inv.merchantName);
      setMerchantAddr(inv.addr);
      setPrefillUsdc(inv.usdc);
      setScreen("pay");
    }
  }, [onboardWallet]);

  const balance = w ? calcBalance(w) : 0;
  const unspent = useMemo(() => (w ? w.notes.filter((n) => !n.spent) : []), [w]);

  useEffect(() => {
    if (prefillUsdc) setPayAmount(String(prefillUsdc));
  }, [prefillUsdc]);
  const poolLeaves = useMemo(
    () => (w ? [...w.notes].sort((a, b) => a.leafIndex - b.leafIndex).map((n) => n.commitment) : []),
    [w]
  );
  // Coin selection preview for the typed amount: which note(s) cover it, and how
  // much change comes back. Recomputed live as the user types.
  const parsedAmount = Number(payAmount);
  const selection: SelectionResult | null = useMemo(() => {
    if (!w || !payAmount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
    return selectCoins(w.notes, parsedAmount);
  }, [w, payAmount, parsedAmount]);

  if (!w) return null;
  const usd = fmtUSD(w.hideBalance ? 0 : balance);
  const kp = stellarKeypair(w);

  async function doDeposit() {
    if (!w || depositing) return;
    setErr(null);
    setDepositing(true);
    try {
      const blinding = newBlinding();
      const commitment = await wit.noteCommitment(depDenom, w.walletPriv, blinding);
      const expectedRoot = await wit.merkleRootOf([...poolLeaves, commitment]);
      setWorking("depositing real USDC on-chain…");
      const res = await chain.deposit(kp, depDenom, commitment, expectedRoot, setWorking);
      const leafIndex = typeof res.returnValue === "number" ? res.returnValue : poolLeaves.length;
      const note: Note = {
        id: crypto.randomUUID(),
        amount: depDenom,
        blinding,
        leafIndex,
        commitment,
        spent: false,
        createdAt: Date.now(),
      };
      update(addNote(w, note));
      // Real USDC left the wallet. Horizon lags the Soroban tx by a moment, so
      // poll until the public balance reflects the decrease.
      const prevUsdc = usdcBal ?? 0;
      (async () => {
        for (let i = 0; i < 10; i++) {
          const b = await chain.usdcBalance(kp.publicKey()).catch(() => null);
          if (b !== null) {
            setUsdcBal(b);
            if (b <= prevUsdc - depDenom + 0.001) break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      })();
      setScreen("home");
    } catch (e) {
      setErr(`deposit failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setDepositing(false);
      setWorking(null);
    }
  }

  async function doPay() {
    if (!w) return;
    const amount = Number(payAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setErr("Enter a whole-dollar amount.");
      return;
    }
    // Coin selection: cover `amount` with at most 2 notes (the circuit is 2-input).
    const sel = selectCoins(w.notes, amount);
    if (!sel.ok) {
      setErr(
        sel.reason === "empty"
          ? "No notes yet — receive one first."
          : `Largest payable now is $${sel.largestPayable} (at most 2 notes). Top up or use a smaller amount.`
      );
      return;
    }
    setErr(null);
    try {
      // ASP vouch (mock service) ensures this wallet identity is allowlisted.
      setStep("vouch");
      const aspLeaf = await wit.aspLeafFor(w.walletPriv);
      const dummyLeaf = await wit.dummyAspLeaf();
      const vouch = await fetch("/api/asp-vouch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaf: aspLeaf }),
      }).then((r) => r.json());
      if (vouch.error) throw new Error(`ASP vouch: ${vouch.error}`);

      setStep("build");
      // ASP: trust the vouch service's AUTHORITATIVE leaf list (canonical order),
      // not RPC-event reconstruction — immune to event-aging. Pool: still
      // reconstruct from events + overlay our own notes (no authoritative store;
      // known production-needs item — a real indexer).
      const myAspIndex: number = typeof vouch.index === "number" ? vouch.index : -1;
      const vouchLeaves: string[] = Array.isArray(vouch.leaves) ? vouch.leaves.map(String) : [];
      const [aspLeaves, fullPool] = await Promise.all([
        chain.resolveAspLeavesAuthoritative(vouchLeaves),
        chain.resolvePoolLeaves(w.notes),
      ]);
      const noteAspIndex = myAspIndex >= 0 ? myAspIndex : aspLeaves.indexOf(aspLeaf);
      const dummyAspIndex = Math.max(0, aspLeaves.indexOf(dummyLeaf));
      // Always bind/store the clean merchant NAME — never a raw pay-link URL that
      // may have leaked into the field. merchantToField must match the register's.
      const merchantName = cleanMerchant(merchant);
      const merchantId = merchantToField(merchantName);

      // Build EXACTLY 2 inputs. Slot 1 is always a real note (it backs the
      // SpendEvent nullifier + the receipt). Single-note spend: slot0 = dummy.
      // Two-note spend: both slots real (combine).
      const noteSlot = (n: Note) => ({
        priv_dec: w.walletPriv,
        blinding_dec: n.blinding,
        amount: n.amount,
        pool_index: n.leafIndex,
        asp_index: noteAspIndex,
      });
      const dummySlot = {
        priv_dec: DUMMY_PRIV,
        blinding_dec: DUMMY_BLIND,
        amount: 0,
        pool_index: 0,
        asp_index: dummyAspIndex,
      };
      // slot1Note = the note whose nullifier the SpendEvent carries / receipt uses.
      const slot1Note = sel.notes[sel.notes.length - 1];
      const inputs: [ReturnType<typeof noteSlot> | typeof dummySlot, ReturnType<typeof noteSlot>] =
        sel.notes.length === 2
          ? [noteSlot(sel.notes[0]), noteSlot(sel.notes[1])]
          : [dummySlot, noteSlot(slot1Note)];

      // Outputs: [0] = change note owned by the payer (the remainder), [1] = zero.
      const change = sel.change;
      const changeBlind = newBlinding();
      const payerPubkey = await wit.derivePubkey(w.walletPriv);
      const outputs: [wit.ChangeOutSlot, wit.ChangeOutSlot] = [
        { pubkey_dec: payerPubkey, blinding_dec: changeBlind, amount: change },
        { pubkey_dec: "0", blinding_dec: "0", amount: 0 },
      ];

      const built = await wit.buildSpendChange({
        inputs: inputs as [wit.ChangeInSlot, wit.ChangeInSlot],
        outputs,
        pool_leaves: fullPool,
        asp_leaves: aspLeaves,
        merchant_dec: merchantId,
        payout: amount,
      });

      setStep("witness");
      await new Promise((r) => setTimeout(r, 30));
      const { proof } = await prove(built.input);
      setStep("prove");
      const proofHex = proofToSorobanHex(proof);

      setStep("submit");
      // Resolve the merchant's Stellar address that receives the real USDC
      // payout: from the pay-link when present, else a merchant created locally
      // via the merchant sign-in. There is NO hardcoded/default merchant — if no
      // address is available, the payment cannot route.
      setWorking("preparing merchant payout address…");
      let payTo = merchantAddr;
      if (!payTo) {
        const localMerchant = getMerchant();
        if (!localMerchant) {
          throw new Error("No merchant to pay — open a merchant invoice link, or create a merchant on /merchant.");
        }
        const mkp = merchantKeypair(localMerchant);
        await chain.ensureFunded(mkp.publicKey());
        await chain.establishUsdcTrustline(mkp);
        payTo = mkp.publicKey();
      }
      setWorking("submitting spend (with change) on-chain…");
      const slot1Nullifier = built.input_nullifiers[1]; // SpendEvent + receipt
      const res = await chain.spend(kp, {
        proofHex,
        root: built.root,
        public_amount: built.public_amount,
        ext_data_hash: built.ext_data_hash,
        input_nullifiers: built.input_nullifiers,
        output_commitments: built.output_commitments,
        asp_membership_root: built.asp_membership_root,
        asp_non_membership_root: built.asp_non_membership_root,
        merchant: merchantId,
        payout: amount,
        merchantAddr: payTo,
        realNullifier: slot1Nullifier,
      }, setWorking);

      // Burn the spent note(s) locally and mint the change note (if any). Find
      // the change leaf index from the ChangeNote event so it is spendable later.
      let next = w;
      for (const n of sel.notes) next = markSpent(next, n.id);
      let changeNote: Note | null = null;
      if (change > 0) {
        setWorking("recording your change note…");
        const changeCommit = built.output_commitments[0];
        const idx = await chain.findLeafIndex(changeCommit);
        changeNote = {
          id: crypto.randomUUID(),
          amount: change,
          blinding: changeBlind,
          leafIndex: idx >= 0 ? idx : poolLeaves.length, // fallback; event should resolve it
          commitment: changeCommit,
          spent: false,
          createdAt: Date.now(),
          kind: "change",
        };
        next = addNote(next, changeNote);
      }

      setStep("done");
      const payment: Payment = {
        merchant: merchantName,
        amount,
        txHash: res.hash,
        at: Date.now(),
        noteId: slot1Note.id,
        merchantField: merchantId,
        nullifier: slot1Nullifier,
        change,
        spentNoteIds: sel.notes.map((n) => n.id),
      };
      update({
        ...next,
        aspIndex: noteAspIndex,
        payments: [payment, ...w.payments],
      });
      setPaid({ amount, change, merchant: merchantName, hash: res.hash, payment });
      setPayAmount("");
    } catch (e) {
      setStep("idle");
      setErr(spendError(e));
    } finally {
      setWorking(null);
    }
  }

  // Generate a proof-of-payment receipt for a real past payment, disclosed to a
  // single named recipient R. Real in-browser proving + a real on-chain verify.
  function openReceipt(p: Payment) {
    setReceiptFor(p);
    setReceiptRecipient(cleanMerchant(p.merchant));
    setReceiptStep("idle");
    setReceiptBlob(null);
    setReceiptVerifyTx(null);
    setErr(null);
  }
  async function doGenerateReceipt() {
    if (!w || !receiptFor) return;
    const p = receiptFor;
    const note = w.notes.find((n) => n.id === p.noteId);
    if (!note || !p.merchantField || !p.nullifier) {
      setErr("This payment predates receipts — make a fresh payment to share one.");
      return;
    }
    setErr(null);
    try {
      const recipientField = merchantToField(receiptRecipient);
      // The receipt circuit folds the NOTE amount into the nullifier, so the
      // proof's public `amount` must be the spent note's value (note.amount),
      // not the merchant payout. The payout is carried separately for display +
      // the on-chain cross-check (they're equal only for a full-note spend).
      const noteAmount = note.amount;
      setReceiptStep("proving");
      const proofHex = await proveReceipt({
        nullifier: p.nullifier,
        amount: String(noteAmount),
        merchant: p.merchantField,
        recipient: recipientField,
        privateKey: w.walletPriv,
        blinding: note.blinding,
        pathIndices: String(note.leafIndex),
      });
      // Prove it verifies on-chain right now (gives a tx hash).
      setReceiptStep("verifying");
      const pubHex = receiptPublicHex({ nullifier: p.nullifier, amount: String(noteAmount), merchant: p.merchantField, recipient: recipientField });
      const vres = await chain.verifyReceiptTx(kp, proofHex, pubHex);
      setReceiptVerifyTx(vres.hash || "(verified)");
      const blob = encodeReceipt({
        v: 1,
        proof: proofHex,
        nullifier: p.nullifier,
        amount: noteAmount,
        payout: p.amount,
        merchant: p.merchantField,
        merchantName: cleanMerchant(p.merchant),
        recipient: recipientField,
        recipientName: receiptRecipient,
      });
      setReceiptBlob(blob);
      setReceiptStep("done");
    } catch (e) {
      setReceiptStep("idle");
      setErr(`receipt failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const activity = buildActivity(w);

  // Buyer wallet nav — wallet tools only. The Merchant register is a SEPARATE
  // role, reached via a deliberate, out-of-the-way role switch (below), not a
  // wallet feature mixed into this nav.
  const walletNav = [
    { key: "HOME", label: "Home", icon: <HomeIcon /> },
    { key: "PAY", label: "Pay", icon: <SendIcon stroke="currentColor" /> },
  ];
  // Start a fresh MANUAL pay (clears any loaded invoice so the buyer can type).
  function startManualPay() {
    setPayInvoice(null);
    setMerchant("");
    setPayAmount("");
    setScreen("pay");
  }
  function goTab(t: string) {
    if (t === "HOME") setScreen("home");
    if (t === "PAY") startManualPay();
  }
  const goMerchant = () => { window.location.href = "/merchant"; };
  const isActive = (t: string) =>
    (t === "HOME" && screen === "home") || (t === "PAY" && (screen === "pay" || screen === "receive"));

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <Bean />
          <span className="word">cowrie</span>
        </div>
        <nav className="sidenav">
          {walletNav.map((it) => (
            <button key={it.key} className={"sideitem" + (isActive(it.key) ? " active" : "")} onClick={() => goTab(it.key)}>
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-role">
          <span className="side-role-label">switch role</span>
          <button className="sideitem role-switch" onClick={goMerchant}>
            <StoreIcon />
            <span>Merchant register</span>
          </button>
        </div>
        <div className="side-foot">testnet · Protocol 27</div>
      </aside>

      <main className="main">
        <div className="surface">
          <div className="app">
            <div className="topbar">
              <div className="avatar">
                <Bean s={16} />
              </div>
              <button className="iconbtn" onClick={() => setScreen("receive")} aria-label="scan">
                <ScanIcon />
              </button>
            </div>

            <div className="balance-row">
              <span className="label">Cowrie private balance</span>
              <button
                className="iconbtn"
                style={{ width: 22, height: 22, border: "none", background: "none" }}
                onClick={() => update({ ...w, hideBalance: !w.hideBalance })}
                aria-label="toggle balance"
              >
                <EyeIcon off={w.hideBalance} />
              </button>
            </div>
            <div className="balance">
              {w.hideBalance ? "••••" : usd.dollars}
              <span className="cents">{w.hideBalance ? "" : "." + usd.cents}</span>
            </div>
            <div className="sub">
              <span className="usdc">{w.hideBalance ? "•••• USDC" : `${balance.toFixed(4)} USDC`}</span>
              <span className="pill">
                <ShieldIcon /> PRIVATE
              </span>
            </div>

            {/* Wallet panel (Level A): the account that already exists + its REAL
                on-chain USDC — public, BEFORE it enters the private pool. */}
            <div className="wallet-card">
              <div className="wc-top">
                <span className="wc-label">Wallet · public USDC</span>
                <span className="wc-bal">{usdcBal === null ? "…" : `$${usdcBal.toFixed(2)}`}</span>
              </div>
              <div className="wc-addr">
                <span className="wc-k">{w.handle}.cowrie</span>
                <button
                  className="wc-copy"
                  onClick={() => {
                    navigator.clipboard?.writeText(kp.publicKey());
                    setAddrCopied(true);
                    setTimeout(() => setAddrCopied(false), 1500);
                  }}
                  title={kp.publicKey()}
                >
                  {addrCopied ? "copied ✓" : `${kp.publicKey().slice(0, 6)}…${kp.publicKey().slice(-4)} ⧉`}
                </button>
              </div>
            </div>

            <div className="actions">
              <div className="action dark" onClick={() => setScreen("receive")}>
                <ArrowDown />
                <span className="t">Receive</span>
              </div>
              <div
                className="action green"
                onClick={startManualPay}
              >
                <SendIcon />
                <span className="t">Send</span>
              </div>
            </div>

            <div className="idcard">
              <span className="label">Cowrie ID</span>
              <button
                className="claim-link"
                onClick={() => { setClaimInput(w.handle); setScreen("claim"); }}
              >
                Claim
              </button>
              <div className="handle">
                {w.handle}
                <span className="suffix">.cowrie</span>
              </div>
            </div>

            <div className="section-head">
              <span className="label">Recent activity</span>
              <span className="viewall">
                View all <Chevron />
              </span>
            </div>
            <div className="activity">
              {activity.length === 0 && (
                <p className="hint" style={{ padding: "8px 0" }}>
                  No activity yet. Tap Receive to top up a private note.
                </p>
              )}
              {activity.map((a, i) => (
                <div className="act" key={i}>
                  <div className="ava">{a.initial}</div>
                  <div className="mid">
                    <div className="name">{a.name}</div>
                    <div className="meta">
                      {a.meta}
                      {a.payment && (
                        <button className="reclink" onClick={() => openReceipt(a.payment!)}>· receipt</button>
                      )}
                    </div>
                  </div>
                  <div className="right">
                    <div className={"amt" + (a.positive ? " pos" : "")}>{a.amount}</div>
                    <div className="status">{a.status}</div>
                  </div>
                </div>
              ))}
            </div>

          </div>

          {screen === "claim" && (
            <div className="sheet">
              <button className="back" onClick={() => setScreen("home")}>← back</button>
              <h2>Claim your name</h2>
              <p className="hint" style={{ marginBottom: 18 }}>
                Choose your Cowrie name. It becomes your <b>&lt;name&gt;.cowrie</b> identity, stored on this
                device. In this demo a name is a <b>local claim</b> — a production version would use an on-chain
                name registry for global uniqueness.
              </p>
              <div className="field">
                <label>Your name</label>
                <div className="claim-entry">
                  <input
                    className="input"
                    value={claimInput}
                    onChange={(e) => setClaimInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && claimName()}
                    placeholder="yourname"
                    autoFocus
                  />
                  <span className="claim-suffix">.cowrie</span>
                </div>
              </div>
              <div className="claim-preview">
                {claimInput.trim() && isValidHandle(claimInput) ? (
                  <>you’ll be <b>{slugifyHandle(claimInput)}.cowrie</b></>
                ) : (
                  <span className="muted">2–20 letters, digits or hyphens</span>
                )}
              </div>
              <button className="btn" disabled={!isValidHandle(claimInput)} onClick={claimName}>
                {isValidHandle(claimInput) ? `Claim ${slugifyHandle(claimInput)}.cowrie` : "Enter a name"}
              </button>
            </div>
          )}

          {screen === "receive" && (
            <div className="sheet">
              <button className="back" onClick={() => setScreen("home")}>
                ← back
              </button>
              <h2>Move USDC into Cowrie</h2>
              <p className="hint" style={{ marginBottom: 14 }}>
                Deposit moves <b>real testnet USDC</b> from your wallet into your private Cowrie balance and mints
                a private note. The chain sees only the commitment, never an amount or identity.
              </p>
              <div className="move-row">
                <div className="move-box">
                  <span className="mk">Wallet · public</span>
                  <span className="mv">{usdcBal === null ? "…" : `$${usdcBal.toFixed(2)}`}</span>
                </div>
                <span className="move-arrow">→</span>
                <div className="move-box priv">
                  <span className="mk">Cowrie · private</span>
                  <span className="mv">${balance.toFixed(2)}</span>
                </div>
              </div>
              {onboard === "ready" && <div className="usdc-avail"><span className="ok">rail live ✓</span></div>}
              {onboard === "dex-dry" && (
                <div className="plan cant" style={{ marginBottom: 12 }}>
                  Couldn’t get testnet USDC: {onboardMsg}. The DEX may be dry.
                  <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => w && onboardWallet(w)}>
                    Retry onboarding
                  </button>
                </div>
              )}
              <div className="field">
                <label>Denomination (USDC)</label>
                <div className="denoms">
                  {DENOMINATIONS.map((d) => (
                    <button key={d} className={"denom" + (depDenom === d ? " sel" : "")} onClick={() => setDepDenom(d)} disabled={onboard !== "ready"}>
                      ${d}
                    </button>
                  ))}
                </div>
              </div>
              {onboard === "provisioning" && <div className="working-line"><span className="spin" /> {onboardMsg}</div>}
              {working && <div className="working-line"><span className="spin" /> {working}</div>}
              {err && <div className="err">{err}</div>}
              <button className="btn" disabled={onboard !== "ready" || depositing || (usdcBal !== null && usdcBal < depDenom)} onClick={doDeposit}>
                {depositing
                  ? "Depositing…"
                  : onboard !== "ready"
                  ? "Onboarding to USDC rail…"
                  : usdcBal !== null && usdcBal < depDenom
                  ? `Need $${depDenom} USDC (have $${usdcBal.toFixed(2)})`
                  : `Deposit $${depDenom} USDC`}
              </button>
            </div>
          )}

          {screen === "pay" && step === "idle" && (
            <div className="sheet">
              <button className="back" onClick={() => setScreen("home")}>
                ← back
              </button>
              <h2>{payInvoice ? "Confirm payment" : "Pay a merchant"}</h2>
              {payInvoice ? (
                /* Loaded from a merchant invoice — LOCKED to its amount + address. */
                <div className="invoice-card">
                  <div className="inv-row">
                    <span className="inv-k">Merchant</span>
                    <span className="inv-v">{payInvoice.merchantName}</span>
                  </div>
                  <div className="inv-amount">
                    Pay <b>${payInvoice.usdc.toFixed(2)} USDC</b>
                    {payInvoice.fiat != null && (
                      <span className="inv-fiat"> ≈ {fmtFiat(payInvoice.fiat, payInvoice.currency)}</span>
                    )}
                  </div>
                  {payInvoice.fiat != null && payInvoice.usdc > 0 && (
                    <div className="inv-rate">
                      {fmtFiat(Math.round(payInvoice.fiat / payInvoice.usdc), payInvoice.currency)} / $1 · anchor quote (SEP-38, mock)
                    </div>
                  )}
                  <div className="inv-meta">
                    <span>Pay ID {payInvoice.payId ?? "—"}</span>
                    <span className="mono">→ {payInvoice.addr.slice(0, 6)}…{payInvoice.addr.slice(-4)}</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>Merchant</label>
                    <input
                      className="input"
                      value={merchant}
                      onChange={(e) => {
                        const v = e.target.value;
                        // If a full pay-link is pasted, load it as an invoice
                        // (so the raw URL is never stored as the merchant name).
                        const inv = /[?&]pay=/.test(v) ? parsePayLink(v.includes("?") ? v.slice(v.indexOf("?")) : v) : null;
                        if (inv) {
                          setPayInvoice(inv);
                          setMerchant(inv.merchantName);
                          setMerchantAddr(inv.addr);
                          setPayAmount(String(inv.usdc));
                        } else {
                          setMerchant(cleanMerchant(v));
                        }
                      }}
                      placeholder="open a merchant invoice link, or type a name"
                    />
                  </div>
                  <div className="field">
                    <label>Amount (USDC)</label>
                    <div className="amount-entry">
                      <span className="cur">$</span>
                      <input
                        className="input amount-input"
                        inputMode="numeric"
                        placeholder="0"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value.replace(/[^0-9]/g, ""))}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Coin-selection preview — show what will happen BEFORE paying. */}
              {unspent.length === 0 ? (
                <p className="hint">No notes yet — tap Receive to top up first.</p>
              ) : selection ? (
                selection.ok ? (
                  <div className="plan">
                    <div className="plan-line">
                      <span>
                        Paying <b>${parsedAmount}</b> from your{" "}
                        <b>
                          {selection.notes.length === 1
                            ? `$${selection.notes[0].amount} note`
                            : selection.notes.map((n) => `$${n.amount}`).join(" + ") + " notes"}
                        </b>
                      </span>
                    </div>
                    {selection.change > 0 ? (
                      <div className="plan-change">
                        <Bean s={14} /> <b>${selection.change}</b> change returned to you, privately — as a new note
                        you can spend.
                      </div>
                    ) : (
                      <div className="plan-change exact">Exact amount — no change.</div>
                    )}
                  </div>
                ) : (
                  <div className="plan cant">
                    {selection.reason === "empty"
                      ? "No notes yet — receive one first."
                      : `Can't cover $${parsedAmount} with 2 notes. Largest payable now is $${selection.largestPayable} — top up or use a smaller amount.`}
                  </div>
                )
              ) : (
                <p className="hint">
                  Type any amount. We pick the right note(s) automatically and return change to you as a private
                  note — without revealing which notes or who you are.
                </p>
              )}

              {err && <div className="err">{err}</div>}
              <button
                className="btn"
                disabled={!funded || !selection || !selection.ok || !merchant.trim()}
                onClick={doPay}
              >
                {!merchant.trim()
                  ? "Enter a merchant"
                  : selection && selection.ok
                  ? `Pay $${parsedAmount}`
                  : payInvoice
                  ? `Pay $${payInvoice.usdc}`
                  : "Enter an amount"}
              </button>
            </div>
          )}

          {screen === "pay" && step !== "idle" && step !== "done" && (
            <div className="proving">
              <div className="ring">
                <Bean s={40} />
              </div>
              <h2>Proving funds &amp; clean</h2>
              <p className="ptag">zero-knowledge · on-chain verify</p>
              <div className="steps">
                <StepRow label="Requesting ASP attestation" me="vouch" cur={step} />
                <StepRow label="Building witness (Poseidon2)" me="build" cur={step} />
                <StepRow label="Generating Groth16 proof" me="witness" cur={step} done2="prove" />
                <StepRow label="Verifying on-chain (BN254)" me="submit" cur={step} />
              </div>
              {working && <p className="ptag" style={{ marginTop: 18, color: "var(--green)" }}>{working}</p>}
            </div>
          )}

          {screen === "pay" && step === "done" && paid && (
            <div className="paid">
              <div className="check">
                <CheckIcon />
              </div>
              <h2>Paid</h2>
              <div className="amt">${paid.amount}.00</div>
              <span className="label">to {cleanMerchant(paid.merchant)} · clean</span>
              {paid.change > 0 && (
                <div className="change-chip">
                  <Bean s={14} /> ${paid.change}.00 change returned privately
                </div>
              )}
              <p className="txt">
                tx{" "}
                <a href={`https://stellar.expert/explorer/testnet/tx/${paid.hash}`} target="_blank" rel="noreferrer">
                  {paid.hash.slice(0, 10)}…{paid.hash.slice(-6)}
                </a>
              </p>
              <button className="btn" style={{ marginTop: 28 }} onClick={() => { setScreen("home"); openReceipt(paid.payment); }}>
                Share a receipt
              </button>
              <button
                className="btn ghost"
                style={{ marginTop: 10 }}
                onClick={() => {
                  setStep("idle");
                  setPaid(null);
                  setPayInvoice(null);
                  setScreen("home");
                }}
              >
                Done
              </button>
            </div>
          )}

          {/* RECEIPT sheet — selective disclosure to ONE named recipient */}
          {receiptFor && (
            <div className="sheet">
              {receiptStep === "idle" && (
                <>
                  <button className="back" onClick={() => setReceiptFor(null)}>← back</button>
                  <h2>Share a receipt</h2>
                  <p className="hint" style={{ marginBottom: 18 }}>
                    Prove you paid <b>${receiptFor.amount}.00 to {cleanMerchant(receiptFor.merchant)}</b> — to one party you
                    choose. The receipt reveals only that payment. It is valid <b>only</b> for the recipient you
                    name, and discloses nothing about your wallet, balance, identity, or other payments.
                  </p>
                  <div className="field">
                    <label>Disclose to (recipient)</label>
                    <input className="input" value={receiptRecipient} onChange={(e) => setReceiptRecipient(e.target.value)} placeholder="e.g. a merchant name or an auditor id" />
                  </div>
                  {err && <div className="err">{err}</div>}
                  <button className="btn" disabled={!funded} onClick={doGenerateReceipt}>Generate receipt</button>
                </>
              )}
              {(receiptStep === "proving" || receiptStep === "verifying") && (
                <div className="proving" style={{ position: "static", height: "100%" }}>
                  <div className="ring"><Bean s={40} /></div>
                  <h2>Building your receipt</h2>
                  <p className="ptag">zero-knowledge · proof of payment</p>
                  <div className="steps">
                    <StepRow2 label="Generating Groth16 proof" active={receiptStep === "proving"} done={receiptStep === "verifying"} />
                    <StepRow2 label="Verifying on-chain (BN254)" active={receiptStep === "verifying"} done={false} />
                  </div>
                </div>
              )}
              {receiptStep === "done" && receiptBlob && (
                <>
                  <button className="back" onClick={() => setReceiptFor(null)}>← back</button>
                  <h2>Receipt ready</h2>
                  <div className="recipient-row">
                    <span className="rr-k">Recipient</span>
                    <button
                      className="rr-copy"
                      onClick={() => { navigator.clipboard?.writeText(receiptRecipient); setRecipientCopied(true); setTimeout(() => setRecipientCopied(false), 1500); }}
                      title="copy the recipient this receipt is scoped to"
                    >
                      {recipientCopied ? "copied ✓" : `${receiptRecipient} ⧉`}
                    </button>
                  </div>
                  <p className="hint" style={{ marginBottom: 14 }}>
                    Verified on-chain{" "}
                    {receiptVerifyTx && receiptVerifyTx.length > 12 ? (
                      <a style={{ color: "var(--green)" }} href={`https://stellar.expert/explorer/testnet/tx/${receiptVerifyTx}`} target="_blank" rel="noreferrer">(tx)</a>
                    ) : "✓"}. Only <b>{receiptRecipient}</b> can verify it — handed to anyone else it is rejected.
                  </p>
                  <textarea className="input" readOnly rows={5} style={{ fontFamily: "var(--mono)", fontSize: 11, resize: "none", wordBreak: "break-all" }} value={receiptBlob} />
                  <button className="btn" style={{ marginTop: 12 }} onClick={() => { navigator.clipboard?.writeText(receiptBlob); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                    {copied ? "Copied ✓" : "Copy receipt"}
                  </button>
                  <p className="hint" style={{ marginTop: 10 }}>Send this to <b>{receiptRecipient}</b> — they verify it from their register.</p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="foot-controls">
          <button className="reset-btn" onClick={resetDemo}>reset demo</button>
        </div>

        <nav className="bottom-tabs">
          {walletNav.map((it) => (
            <button key={it.key} className={"tab" + (isActive(it.key) ? " active" : "")} onClick={() => goTab(it.key)}>
              {it.label}
            </button>
          ))}
          <button className="tab role-switch" onClick={goMerchant} title="switch to the merchant register">
            Merchant
          </button>
        </nav>
      </main>
    </div>
  );
}

function spendError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("#7")) return "Rejected: this note isn't on the ASP allowlist (clean-funds gate).";
  if (msg.includes("#6")) return "Rejected: note already spent (double-spend).";
  if (msg.includes("Assert") || msg.includes("Not enough values"))
    return "Couldn't build a proof — this note isn't allowlisted as clean funds.";
  return `Pay failed: ${msg}`;
}

type ActivityRow = { initial: string; name: string; meta: string; amount: string; status: string; positive: boolean; at: number; payment?: Payment };
function buildActivity(w: WalletState): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const p of w.payments) {
    const mName = cleanMerchant(p.merchant);
    rows.push({ initial: mName[0]?.toUpperCase() ?? "?", name: mName, meta: timeAgo(p.at), amount: `−$${p.amount}.00`, status: "paid · clean", positive: false, at: p.at, payment: p.noteId ? p : undefined });
  }
  for (const n of w.notes)
    rows.push({ initial: "+", name: "Top up", meta: `note · leaf #${n.leafIndex}`, amount: `+$${n.amount}.00`, status: n.spent ? "spent" : "private", positive: true, at: n.createdAt });
  return rows.sort((a, b) => b.at - a.at).slice(0, 6);
}
function timeAgo(t: number) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function StepRow2({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={"step" + (active ? " active" : done ? " done" : "")}>
      <span className="sdot" />
      {label}
    </div>
  );
}

function StepRow({ label, me, cur, done2 }: { label: string; me: ProveStep; cur: ProveStep; done2?: ProveStep }) {
  const order: ProveStep[] = ["vouch", "build", "witness", "prove", "submit", "done"];
  const ci = order.indexOf(cur);
  const mi = order.indexOf(me);
  const active = cur === me || cur === done2;
  const done = ci > mi && !active;
  return (
    <div className={"step" + (active ? " active" : done ? " done" : "")}>
      <span className="sdot" />
      {label}
    </div>
  );
}

const HomeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 11l9-7 9 7M5 10v10h14V10" />
  </svg>
);
const StoreIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M4 9h16M9 20v-6h6v6" />
  </svg>
);
const ScanIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#eef2e6" strokeWidth="2">
    <path d="M4 8V5a1 1 0 011-1h3M20 8V5a1 1 0 00-1-1h-3M4 16v3a1 1 0 001 1h3M20 16v3a1 1 0 01-1 1h-3" />
  </svg>
);
const EyeIcon = ({ off }: { off: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.6">
    {off ? (
      <>
        <path d="M3 3l18 18" />
        <path d="M10.6 10.6a2 2 0 002.8 2.8M9.4 5.2A9 9 0 0121 12a9 9 0 01-2 2.8M6.1 6.1A9 9 0 003 12a9 9 0 0011 6.3" />
      </>
    ) : (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    )}
  </svg>
);
const ShieldIcon = ({ nav }: { nav?: boolean }) => (
  <svg width={nav ? 18 : 11} height={nav ? 18 : 12} viewBox="0 0 24 24" fill="none" stroke={nav ? "currentColor" : "#b7f24a"} strokeWidth="2">
    <path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z" />
  </svg>
);
const ArrowDown = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#eef2e6" strokeWidth="2">
    <path d="M12 4v14M6 12l6 6 6-6" />
  </svg>
);
const SendIcon = ({ stroke = "#0a0f08" }: { stroke?: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2">
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);
const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 6l6 6-6 6" />
  </svg>
);
const CheckIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#0a0f08" strokeWidth="3">
    <path d="M5 12l5 5L20 6" />
  </svg>
);
