"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as chain from "@/lib/contracts";
import { ANCHOR_RATE_NGN_PER_USDC, fmtNGN, merchantToField, quoteFromNgn } from "@/lib/merchant";

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
  const [merchantName, setMerchantName] = useState("Buka Express");
  const [ngnInput, setNgnInput] = useState("8500");
  const [description, setDescription] = useState("Jollof + drink");
  const [state, setState] = useState<State>("new");

  const [invoice, setInvoice] = useState<{ ngn: number; usdc: number; merchant: string } | null>(null);
  const [sinceLedger, setSinceLedger] = useState(0);
  const [paidEvent, setPaidEvent] = useState<chain.SpendEvent | null>(null);
  const [settle, setSettle] = useState<Settlement | null>(null);
  const [note, setNote] = useState<string>("");

  const quote = quoteFromNgn(Number(ngnInput) || 0);
  const merchantId = merchantToField(merchantName);
  const payLink = invoice ? `/?pay=${encodeURIComponent(merchantName)}&amt=${invoice.usdc}` : "/";

  // generate the charge
  function generate() {
    if (!quote.usdc) return;
    setInvoice({ ngn: quote.ngn, usdc: quote.usdc, merchant: merchantId });
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
  }, [state, invoice, sinceLedger, merchantName]);

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
          <span className="reg-loc">· LAGOS / ONLINE</span>
        </div>
        <div className="reg-status">
          <span className="dot" /> {state === "paid" ? "SETTLED" : "OPEN"}
        </div>
      </div>

      <div className="reg-grid">
        {/* charge column */}
        <div className="reg-card">
          {state === "new" && (
            <>
              <span className="label">New charge</span>
              <div className="field">
                <label>Amount (NGN)</label>
                <input className="reg-input big" value={ngnInput} onChange={(e) => setNgnInput(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
              </div>
              <div className="field">
                <label>For</label>
                <input className="reg-input" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="field">
                <label>Merchant</label>
                <input className="reg-input" value={merchantName} onChange={(e) => setMerchantName(e.target.value)} />
              </div>
              <div className="quote-line">
                buyer pays <b>${quote.usdc}.00 USDC</b> · settles to <b>{fmtNGN(quote.ngn)}</b>
                <span className="rate"> @ {quote.rateLabel} · {quote.sep}</span>
              </div>
              <button className="reg-btn" onClick={generate} disabled={!quote.usdc}>
                Generate charge
              </button>
            </>
          )}

          {state === "awaiting" && invoice && (
            <>
              <span className="label awaiting">● Awaiting payment</span>
              <div className="charge-amt">{fmtNGN(invoice.ngn)}</div>
              <div className="charge-sub">${invoice.usdc}.00 USDC · {description}</div>
              <div className="charge-meta">
                <div><span className="k">merchant</span><span className="v">{merchantName}</span></div>
                <div><span className="k">merchant id</span><span className="v mono">{merchantId.slice(0, 14)}…</span></div>
              </div>
              <div className="paylink">
                <span className="label">Buyer pay-link</span>
                <a className="link" href={payLink} target="_blank" rel="noreferrer">{payLink}</a>
                <p className="hint">Open the Cowrie wallet and pay this charge. The register flips only when the verified on-chain spend event appears.</p>
              </div>
              <div className="watching"><span className="spin" /> watching the chain for a verified payment…</div>
            </>
          )}

          {state === "paid" && invoice && (
            <div className="paidwrap">
              <div className="shield"><ShieldBig /></div>
              <h2>Paid. Verified clean.</h2>
              <div className="settled">{settle ? fmtNGN(settle.ngn) : fmtNGN(invoice.usdc * ANCHOR_RATE_NGN_PER_USDC)} settled</div>
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
          <div id="privacy" className="reg-card sm">
            <span className="label">What the register learns</span>
            <ul className="seelist good">
              <li>paid: {state === "paid" ? "yes" : "—"}</li>
              <li>clean (ASP-verified on-chain): {state === "paid" ? "yes" : "—"}</li>
              <li>amount: {invoice ? `$${invoice.usdc} → ${fmtNGN(invoice.usdc * ANCHOR_RATE_NGN_PER_USDC)}` : "—"}</li>
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

          <div className="reg-card sm anchor">
            <span className="label">Mock anchor</span>
            <p className="hint">
              <b>⚠ MOCK — not real fiat rails.</b> In production this is a Stellar anchor: <b>/quote → SEP-38</b>,
              <b> /settle → SEP-31</b> (interactive off-ramp would be SEP-24).
            </p>
            {settle && (
              <div className="settle-out">
                <div>{settle.message}</div>
                <div className="rate">rate {fmtNGN(settle.rate)} / $1 · {settle.anchor}</div>
              </div>
            )}
          </div>
        </div>
      </div>
      {note && <div className="reg-note">{note}</div>}
      <a className="reg-back" href="/">← buyer wallet</a>
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
