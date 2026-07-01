"use client";
import { useEffect, useState } from "react";
import { decodeReceipt, receiptPublicHex, type ReceiptBlob } from "@/lib/receiptProver";
import * as chain from "@/lib/contracts";
import { merchantToField } from "@/lib/merchant";
import { getMerchant } from "@/lib/merchantWallet";

type Result =
  | { kind: "ok"; amount: number; merchant: string; spendTx: string | null }
  | { kind: "wrong-recipient"; intended: string }
  | { kind: "invalid"; reason: string };

export default function VerifyPage() {
  const [blobText, setBlobText] = useState("");
  const [identity, setIdentity] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [signedInMerchant, setSignedInMerchant] = useState<string | null>(null);

  // Pre-fill the recipient with the signed-in merchant identity, so the merchant
  // verifies with no typing (they're the recipient the receipt is scoped to).
  useEffect(() => {
    const m = getMerchant();
    if (m?.name) {
      setIdentity(m.name);
      setSignedInMerchant(m.name);
    }
  }, []);

  async function verify() {
    setErr(null);
    setResult(null);
    let blob: ReceiptBlob;
    try {
      blob = decodeReceipt(blobText);
    } catch (e) {
      setErr(`Not a Cowrie receipt: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setBusy(true);
    try {
      // CRITICAL: verify with OUR OWN identity as the recipient R, never the
      // value the blob claims. A receipt bound to someone else fails here.
      // The proof binds the NOTE amount (blob.amount); the merchant payout is a
      // separate display/cross-check value (blob.payout) — equal only for a
      // full-note spend, smaller when the payment minted change (Phase R1).
      const myR = merchantToField(identity);
      const payout = blob.payout ?? blob.amount; // legacy receipts: payout == amount
      setWorking("verifying proof on-chain (BN254)…");
      const pubHex = receiptPublicHex({
        nullifier: blob.nullifier,
        amount: String(blob.amount),
        merchant: blob.merchant,
        recipient: myR,
      });
      const ok = await chain.verifyReceiptSim(blob.proof, pubHex);
      if (!ok) {
        // Distinguish "not addressed to you" from "garbage": re-verify with the
        // blob's own R. If THAT passes, the proof is valid but bound to another.
        const okIntended = await chain.verifyReceiptSim(
          blob.proof,
          receiptPublicHex({ nullifier: blob.nullifier, amount: String(blob.amount), merchant: blob.merchant, recipient: blob.recipient })
        );
        setResult(okIntended ? { kind: "wrong-recipient", intended: blob.recipientName } : { kind: "invalid", reason: "proof did not verify" });
        return;
      }
      // Cross-check the payment really happened on-chain. The SpendEvent is the
      // authoritative source for the payout; the receipt's claimed payout must
      // match it (and the merchant). The note amount stays private to the proof.
      setWorking("cross-checking on-chain payment…");
      const ev = await chain.findSpendEvent(blob.nullifier);
      const merchantOk = !ev || ev.merchant === blob.merchant;
      const payoutOk = !ev || ev.payout === payout;
      if (ev && (!merchantOk || !payoutOk)) {
        setResult({ kind: "invalid", reason: "receipt claims do not match the on-chain payment" });
        return;
      }
      setResult({ kind: "ok", amount: ev?.payout ?? payout, merchant: blob.merchantName, spendTx: ev?.txHash ?? null });
    } catch (e) {
      setErr(`verify failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
      setWorking(null);
    }
  }

  return (
    <div className="reg-root">
      <div className="reg-head">
        <span className="brand"><Bean /> <b style={{ fontWeight: 600 }}>cowrie</b> · VERIFY RECEIPT</span>
        <a className="reg-link" href="/merchant">← register</a>
      </div>

      <div className="verify-grid">
        <div className="reg-card">
          <span className="label">Proof of payment</span>
          <p className="hint" style={{ margin: "8px 0 16px" }}>
            Paste a Cowrie receipt. It is verified on-chain against the receipt verifier, and the payment is
            cross-checked against its on-chain event. A receipt is valid <b>only</b> for the recipient it was
            issued to — verify as yourself.
          </p>
          <div className="field">
            <label>Receipt</label>
            <textarea className="input" rows={5} style={{ fontFamily: "var(--mono)", fontSize: 11, resize: "none", wordBreak: "break-all" }} value={blobText} onChange={(e) => setBlobText(e.target.value)} placeholder="cowrie-receipt:…" />
          </div>
          <div className="field">
            <label>Verify as (your recipient id)</label>
            <input className="input" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="your merchant / recipient id" />
            {signedInMerchant && identity === signedInMerchant && (
              <p className="hint" style={{ marginTop: 6 }}>signed in as <b>{signedInMerchant}</b> — pre-filled</p>
            )}
          </div>
          {err && <div className="err">{err}</div>}
          <button className="btn" disabled={busy || !blobText.trim()} onClick={verify}>
            {busy ? working ?? "Verifying…" : "Verify receipt"}
          </button>
        </div>

        <div className="reg-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 280 }}>
          {!result && !busy && <p className="hint" style={{ textAlign: "center" }}>The result appears here.</p>}
          {busy && (
            <div style={{ textAlign: "center" }}>
              <div className="ring" style={{ margin: "0 auto 18px" }}><Bean s={36} /></div>
              <p className="ptag">{working}</p>
            </div>
          )}
          {result?.kind === "ok" && (
            <div style={{ textAlign: "center" }}>
              <div className="check" style={{ margin: "0 auto 18px" }}><CheckIcon /></div>
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>Verified</h2>
              <p className="amt" style={{ fontSize: 34, fontWeight: 700, margin: "6px 0" }}>${result.amount}.00</p>
              <span className="label">to {result.merchant} · clean</span>
              {result.spendTx && (
                <p className="hint" style={{ marginTop: 12 }}>
                  on-chain payment{" "}
                  <a style={{ color: "var(--green)" }} href={`https://stellar.expert/explorer/testnet/tx/${result.spendTx}`} target="_blank" rel="noreferrer">{result.spendTx.slice(0, 10)}…</a>
                </p>
              )}
              <div className="redact">
                <div className="rline">payer identity <span>— never revealed</span></div>
                <div className="rline">wallet · balance <span>— never revealed</span></div>
                <div className="rline">other payments · source note <span>— never revealed</span></div>
              </div>
            </div>
          )}
          {result?.kind === "wrong-recipient" && (
            <div style={{ textAlign: "center" }}>
              <div className="xmark">✕</div>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>Not addressed to you</h2>
              <p className="hint" style={{ marginTop: 10 }}>
                This receipt is a valid proof of payment, but it was issued to <b>{result.intended}</b> — not to{" "}
                <b>{identity}</b>. The recipient is bound into the proof, so it cannot be replayed to anyone else.
              </p>
            </div>
          )}
          {result?.kind === "invalid" && (
            <div style={{ textAlign: "center" }}>
              <div className="xmark">✕</div>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>Invalid receipt</h2>
              <p className="hint" style={{ marginTop: 10 }}>{result.reason}.</p>
            </div>
          )}
        </div>
      </div>

      <p className="honesty" style={{ paddingLeft: 0 }}>
        <b>How it works:</b> the receipt is a Groth16 proof that the holder knows the secret behind a specific
        on-chain <code>SpendEvent</code> (payer + amount), bound to the named recipient. Every public input is
        bound, so changing the recipient breaks verification — that is what makes it non-replayable. Trusted
        setup is <b>dev-only</b> for the demo.
      </p>
    </div>
  );
}

const Bean = ({ s = 20 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 64 64" fill="none" aria-hidden>
    <ellipse cx="32" cy="33" rx="19" ry="25" fill="#b7f24a" />
    <rect x="27.5" y="16" width="9" height="34" rx="4.5" fill="#0a0f08" />
    <g fill="#b7f24a">
      <rect x="24.5" y="19.8" width="15" height="2.4" rx="1.2" />
      <rect x="24.5" y="24.8" width="15" height="2.4" rx="1.2" />
      <rect x="24.5" y="29.8" width="15" height="2.4" rx="1.2" />
      <rect x="24.5" y="34.8" width="15" height="2.4" rx="1.2" />
      <rect x="24.5" y="39.8" width="15" height="2.4" rx="1.2" />
      <rect x="24.5" y="44.8" width="15" height="2.4" rx="1.2" />
    </g>
  </svg>
);
const CheckIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#0a0f08" strokeWidth="3">
    <path d="M5 12l5 5L20 6" />
  </svg>
);
