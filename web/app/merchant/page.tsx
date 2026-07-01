"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as chain from "@/lib/contracts";
import { fiatFromUsdc, fmtNGN, merchantToField, RATE_LABEL } from "@/lib/merchant";
import { absolutePayLink, buildPayLink, makePayId } from "@/lib/paylink";
import { QRCodeSVG } from "qrcode.react";
import {
  clearMerchant,
  createMerchant,
  getMerchant,
  merchantKeypair,
  type MerchantWallet,
} from "@/lib/merchantWallet";
import { isValidBusinessName, normalizeBusinessName } from "@/lib/names";

type State = "new" | "awaiting" | "paid";
interface Settlement {
  message: string;
  ngn: number;
  usdc: number;
  rate: number;
  sep: string;
  anchor: string;
}

export default function MerchantRegister() {
  // Seedless merchant identity (Phase R3). Null until the user "signs in" by
  // claiming a business name; then a real receiving account is provisioned.
  const [merchant, setMerchant] = useState<MerchantWallet | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const [usdcInput, setUsdcInput] = useState("5"); // USDC is the authoritative amount typed
  const [description, setDescription] = useState("Jollof + drink");
  const [state, setState] = useState<State>("new");

  const [invoice, setInvoice] = useState<{ ngn: number; usdc: number; merchant: string; payId: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sinceLedger, setSinceLedger] = useState(0);
  const [paidEvent, setPaidEvent] = useState<chain.SpendEvent | null>(null);
  const [settle, setSettle] = useState<Settlement | null>(null);
  const [note, setNote] = useState<string>("");

  // The merchant's receiving account (real USDC payout target).
  const [merchantAddr, setMerchantAddr] = useState<string | null>(null);
  const [merchantReady, setMerchantReady] = useState(false);
  const [merchantMsg, setMerchantMsg] = useState("");
  const [merchantUsdc, setMerchantUsdc] = useState<number | null>(null);
  const [addrCopied, setAddrCopied] = useState(false);

  const merchantName = merchant?.name ?? "";
  const merchantId = merchantName ? merchantToField(merchantName) : "";

  // Onboard a merchant identity: fund XLM + a USDC trustline so it can RECEIVE.
  const onboardMerchant = useCallback(async (m: MerchantWallet) => {
    const kp = merchantKeypair(m);
    setMerchantAddr(kp.publicKey());
    setMerchantReady(false);
    try {
      setMerchantMsg("funding merchant XLM…");
      await chain.ensureFunded(kp.publicKey());
      setMerchantMsg("establishing USDC trustline…");
      await chain.establishUsdcTrustline(kp); // needed to RECEIVE the payout
      setMerchantReady(true);
      setMerchantMsg("ready to receive USDC");
      chain.usdcBalance(kp.publicKey()).then(setMerchantUsdc).catch(() => {});
    } catch (e) {
      setMerchantMsg(`merchant onboarding failed: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  // On mount: resume an existing merchant identity (persisted across reload).
  useEffect(() => {
    const m = getMerchant();
    if (m) {
      setMerchant(m);
      onboardMerchant(m);
    }
  }, [onboardMerchant]);

  // "Sign in": claim a name -> provision a receiving account for it.
  async function doSignIn() {
    if (signingIn || !isValidBusinessName(nameInput)) return;
    setSigningIn(true);
    const m = createMerchant(normalizeBusinessName(nameInput));
    setMerchant(m);
    await onboardMerchant(m);
    setSigningIn(false);
  }

  // "Switch merchant": forget this identity (demo re-run).
  function switchMerchant() {
    clearMerchant();
    setMerchant(null);
    setMerchantAddr(null);
    setMerchantReady(false);
    setMerchantUsdc(null);
    setState("new");
    setInvoice(null);
    setPaidEvent(null);
    setSettle(null);
  }

  function copyAddr() {
    if (!merchantAddr) return;
    navigator.clipboard?.writeText(merchantAddr);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 1500);
  }

  // USDC-primary: the merchant types whole USDC; NGN is a DERIVED estimate.
  const usdcAmount = Math.max(0, Math.floor(Number(usdcInput) || 0));
  const derivedNgn = fiatFromUsdc(usdcAmount);
  // Pay-link carries EVERYTHING the buyer needs — USDC amount, receiving address,
  // merchant name, local-currency amount + code, and the display pay-ID. No
  // server lookup: the buyer parses it straight off the link/QR.
  const payLink =
    invoice && merchantAddr
      ? buildPayLink({
          merchantName,
          usdc: invoice.usdc,
          addr: merchantAddr,
          fiat: invoice.ngn,
          currency: "NGN",
          payId: invoice.payId,
        })
      : "/";
  const payUrl = absolutePayLink(payLink);

  // generate the charge (mints a fresh display pay-ID for this invoice)
  function generate() {
    if (!usdcAmount) return;
    setInvoice({ ngn: derivedNgn, usdc: usdcAmount, merchant: merchantId, payId: makePayId() });
    setState("awaiting");
    setPaidEvent(null);
    setSettle(null);
  }

  // record the ledger when we start awaiting (so we never accept an OLD spend)
  useEffect(() => {
    if (state === "awaiting") {
      chain.getLatestLedger().then((l) => setSinceLedger(l - 1)).catch(() => setSinceLedger(0));
    }
  }, [state]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detect = useCallback(async () => {
    if (state !== "awaiting" || !invoice || !sinceLedger) return;
    try {
      const events = await chain.getSpendEvents(sinceLedger);
      // ONLY accept this invoice's own spend: exact merchant id AND amount.
      const match = events.find((e) => e.merchant === invoice.merchant && e.payout === invoice.usdc);
      if (match) {
        setPaidEvent(match);
        setState("paid");
        // the payout landed in the merchant's REAL account — refresh its balance.
        if (merchantAddr) chain.usdcBalance(merchantAddr).then(setMerchantUsdc).catch(() => {});
        // mock anchor settles ONLY after independently verifying the spend.
        const s = await fetch("/api/anchor/settle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txHash: match.txHash, merchant: invoice.merchant, payout: invoice.usdc, merchantName }),
        }).then((r) => r.json());
        if (!s.error) setSettle(s);
      }
    } catch (e) {
      setNote(`watching… (${e instanceof Error ? e.message.slice(0, 40) : e})`);
    }
  }, [state, invoice, sinceLedger, merchantName, merchantAddr]);

  useEffect(() => {
    if (state === "awaiting" && sinceLedger) {
      detect();
      pollRef.current = setInterval(detect, 4000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
  }, [state, sinceLedger, detect]);

  return (
    <div className="reg-root">
      <div className="reg-head">
        <div className="reg-brand">
          <Bean />
          <span>COWRIE REGISTER</span>
          {merchant && <span className="reg-loc">· {merchantName}</span>}
        </div>
        <div className="reg-status">
          <a className="reg-role-switch" href="/" title="switch to the buyer wallet">← Buyer wallet</a>
          {/* Verify a buyer's receipt — the merchant is the recipient who verifies. */}
          <a className="reg-verify-link" href="/verify" title="verify a customer's payment receipt">Verify receipt</a>
          {merchant && (
            <button className="switch-merch" onClick={switchMerchant} title="forget this merchant (demo re-run)">
              switch merchant
            </button>
          )}
          <span className="dot" /> {state === "paid" ? "SETTLED" : merchant ? "OPEN" : "SIGNED OUT"}
        </div>
      </div>

      {/* Seedless merchant sign-in: claim a name -> get a receiving account. */}
      {!merchant ? (
        <div className="reg-grid">
          <div className="reg-card signin-card">
            <span className="label">Sign in as a merchant</span>
            <p className="hint" style={{ margin: "8px 0 18px" }}>
              Claim a business name — Cowrie provisions a real <b>receiving account</b> (a Stellar address with a
              USDC trustline) for it. Payouts land there. No password, no seed phrase — this is <b>reveal + provision</b>,
              not sign-up.
            </p>
            <div className="field">
              <label>Business name</label>
              <input
                className="reg-input"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSignIn()}
                placeholder="your business name"
                autoFocus
              />
              {nameInput.trim() && !isValidBusinessName(nameInput) && (
                <p className="hint" style={{ marginTop: 6 }}>2–40 characters (letters, digits, spaces).</p>
              )}
            </div>
            {merchantMsg && signingIn && <div className="merch-acct"><span className="mdot" /> {merchantMsg}</div>}
            <button className="reg-btn" onClick={doSignIn} disabled={signingIn || !isValidBusinessName(nameInput)}>
              {signingIn ? "Provisioning account…" : "Create merchant account"}
            </button>
          </div>
        </div>
      ) : (
      <div className="reg-grid">
        {/* charge column */}
        <div className="reg-card">
          {state === "new" && (
            <>
              <span className="label">New charge</span>
              <div className="field">
                <label>Amount (USDC)</label>
                <div className="usdc-charge">
                  <span className="uc-cur">$</span>
                  <input className="reg-input big uc-input" value={usdcInput} onChange={(e) => setUsdcInput(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="0" />
                </div>
              </div>
              <div className="field">
                <label>For</label>
                <input className="reg-input" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="quote-line">
                buyer pays <b>${usdcAmount}.00 USDC</b> · ≈ <b>{fmtNGN(derivedNgn)}</b>
                <span className="rate"> @ {RATE_LABEL} · anchor quote (SEP-38, mock)</span>
              </div>
              <div className="merch-acct">
                <span className={"mdot" + (merchantReady ? " ok" : "")} />
                {merchantReady && merchantAddr ? (
                  <>as <b>{merchantName}</b> · receiving at <span className="mono">{merchantAddr.slice(0, 6)}…{merchantAddr.slice(-4)}</span></>
                ) : (
                  <>{merchantMsg || "setting up merchant account…"}</>
                )}
              </div>
              <button className="reg-btn" onClick={generate} disabled={!usdcAmount || !merchantReady}>
                {merchantReady ? "Generate charge" : "Setting up merchant account…"}
              </button>
            </>
          )}

          {state === "awaiting" && invoice && (
            <>
              <span className="label awaiting">● Awaiting payment · Pay ID {invoice.payId}</span>
              <div className="charge-amt">{fmtNGN(invoice.ngn)}</div>
              <div className="charge-sub">${invoice.usdc}.00 USDC · {description}</div>
              <div className="charge-meta">
                <div><span className="k">merchant</span><span className="v">{merchantName}</span></div>
                <div><span className="k">receiving</span><span className="v mono">{merchantAddr ? `${merchantAddr.slice(0, 6)}…${merchantAddr.slice(-4)}` : "…"}</span></div>
              </div>
              <div className="qr-block">
                <div className="qr-frame">
                  <QRCodeSVG value={payUrl} size={148} bgColor="#0c0f08" fgColor="#e9f5d8" level="M" includeMargin />
                </div>
                <div className="qr-side">
                  <span className="label">Scan to pay</span>
                  <p className="hint">Scan with the Cowrie wallet, or open the link below on this device.</p>
                  <div className="payid-chip">{invoice.payId}</div>
                </div>
              </div>
              <div className="paylink">
                <span className="label">Buyer pay-link</span>
                <a className="link" href={payLink} target="_blank" rel="noreferrer">{payUrl}</a>
                <button
                  className="switch-merch"
                  style={{ marginTop: 8 }}
                  onClick={() => { navigator.clipboard?.writeText(payUrl); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); }}
                >
                  {linkCopied ? "copied ✓" : "copy link"}
                </button>
                <p className="hint">The register flips only when the verified on-chain spend event appears.</p>
              </div>
              <div className="watching"><span className="spin" /> watching the chain for a verified payment…</div>
            </>
          )}

          {state === "paid" && invoice && (
            <div className="paidwrap">
              <div className="shield"><ShieldBig /></div>
              <h2>Paid. Verified clean.</h2>
              <div className="settled">{settle ? fmtNGN(settle.ngn) : fmtNGN(fiatFromUsdc(invoice.usdc))} settled</div>
              <div className="charge-sub">${invoice.usdc}.00 USDC · {description}</div>
              {paidEvent && (
                <p className="txt">
                  spend tx{" "}
                  <a href={`https://stellar.expert/explorer/testnet/tx/${paidEvent.txHash}`} target="_blank" rel="noreferrer">
                    {paidEvent.txHash.slice(0, 10)}…{paidEvent.txHash.slice(-6)}
                  </a>
                </p>
              )}
              <button className="reg-btn ghost" onClick={() => { setState("new"); setInvoice(null); }}>New charge</button>
            </div>
          )}
        </div>

        {/* privacy + anchor column */}
        <div className="reg-side">
          {/* Merchant account panel — the real receiving account + its USDC. */}
          <div className="reg-card sm merch-panel">
            <span className="label">Merchant account</span>
            <div className="mp-name">{merchantName}</div>
            <div className="mp-row">
              <span className="mp-k">receiving USDC</span>
              <span className="mp-v">{merchantUsdc === null ? "…" : `$${merchantUsdc.toFixed(2)}`}</span>
            </div>
            <div className="mp-row">
              <span className="mp-k">address</span>
              {merchantAddr ? (
                <button className="wc-copy" onClick={copyAddr} title={merchantAddr}>
                  {addrCopied ? "copied ✓" : `${merchantAddr.slice(0, 6)}…${merchantAddr.slice(-4)} ⧉`}
                </button>
              ) : (
                <span className="mp-v">…</span>
              )}
            </div>
            <div className="merch-acct" style={{ marginTop: 4 }}>
              <span className={"mdot" + (merchantReady ? " ok" : "")} /> {merchantReady ? "ready to receive" : merchantMsg}
            </div>
          </div>

          <div id="privacy" className="reg-card sm">
            <span className="label">What the register learns</span>
            <ul className="seelist good">
              <li>paid: {state === "paid" ? "yes" : "—"}</li>
              <li>clean (ASP-verified on-chain): {state === "paid" ? "yes" : "—"}</li>
              <li>amount: {invoice ? `$${invoice.usdc} ≈ ${fmtNGN(fiatFromUsdc(invoice.usdc))}` : "—"}</li>
            </ul>
            <span className="label" style={{ marginTop: 14 }}>What stays private</span>
            <ul className="seelist bad">
              <li>buyer identity — never revealed</li>
              <li>buyer balance — never revealed</li>
              <li>which note / its source deposit — never revealed</li>
            </ul>
            {paidEvent && (
              <>
                <span className="label" style={{ marginTop: 14 }}>On-chain explorer · this tx</span>
                <div className="explorer">
                  <div className="erow"><span className="ek">status</span><span className="ev reveal">SUCCESS</span></div>
                  <div className="erow"><span className="ek">event</span><span className="ev reveal">SpendEvent(merchant, amount)</span></div>
                  <div className="erow"><span className="ek">buyer address</span><span className="ev red redact">— nothing identifying —</span></div>
                  <div className="erow"><span className="ek">balance</span><span className="ev red redact">— nothing identifying —</span></div>
                  <div className="erow"><span className="ek">amount source / note</span><span className="ev red redact">— nothing identifying —</span></div>
                </div>
                <p className="hint">
                  Verify it yourself:{" "}
                  <a className="reveal" href={`https://stellar.expert/explorer/testnet/tx/${paidEvent.txHash}`} target="_blank" rel="noreferrer" style={{ color: "var(--green)" }}>open the real tx</a>{" "}
                  — a confirmed contract call + a public <code>SpendEvent(merchant, amount)</code>, and nothing that links to the buyer.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      )}
      {note && <div className="reg-note">{note}</div>}
    </div>
  );
}

const Bean = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <ellipse cx="12" cy="12" rx="7" ry="10" fill="#b7f24a" />
    <path d="M12 3c-2 4-2 14 0 18" stroke="#0a0f08" strokeWidth="1.4" />
  </svg>
);
const ShieldBig = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#0a0f08" strokeWidth="2">
    <path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z" fill="#0a0f08" stroke="#0a0f08" />
    <path d="M8.5 12l2.5 2.5 5-5" stroke="#b7f24a" strokeWidth="2.2" />
  </svg>
);
