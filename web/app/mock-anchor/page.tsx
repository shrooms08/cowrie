import { ANCHOR_NAME, ANCHOR_RATE_NGN_PER_USDC, fmtNGN } from "@/lib/merchant";

export const metadata = { title: "Cowrie — Mock Anchor" };

export default function MockAnchor() {
  return (
    <div className="reg-root" style={{ maxWidth: 720 }}>
      <div className="reg-head">
        <div className="reg-brand">
          <span>{ANCHOR_NAME}</span>
        </div>
        <div className="reg-status">
          <span className="dot" style={{ background: "#ff8a80" }} /> MOCK
        </div>
      </div>

      <div className="reg-card">
        <p className="hint" style={{ marginBottom: 16 }}>
          <b style={{ color: "#ff8a80" }}>⚠ MOCK — not real fiat rails.</b> This stands in for a Stellar anchor that
          off-ramps USDC to local currency. In production these endpoints are Stellar Ecosystem Proposals (SEPs); no
          real money moves here.
        </p>

        <span className="label">Endpoints &amp; SEP mapping</span>
        <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 12 }}>
          <tbody>
            <Row a="POST /api/anchor/quote" b="SEP-38 — Anchor RFQ / quotes" c="NGN → USDC at the exposed rate" />
            <Row a="POST /api/anchor/settle" b="SEP-31 — direct payment to a receiving merchant" c="verifies the on-chain spend, then 'delivers' NGN" />
            <Row a="(interactive off-ramp)" b="SEP-24 — interactive deposit/withdraw" c="the alternative UX for the same off-ramp" />
          </tbody>
        </table>

        <span className="label" style={{ marginTop: 20, display: "block" }}>Quoted rate (exposed, not hidden)</span>
        <div className="charge-amt" style={{ fontSize: 28 }}>{fmtNGN(ANCHOR_RATE_NGN_PER_USDC)} / $1</div>
        <p className="hint">
          e.g. $5 USDC → {fmtNGN(5 * ANCHOR_RATE_NGN_PER_USDC)}, $10 → {fmtNGN(10 * ANCHOR_RATE_NGN_PER_USDC)}. <code>/settle</code>{" "}
          independently confirms the pool <code>SpendEvent(merchant, amount)</code> on-chain before delivering — it never
          trusts a &quot;paid&quot; claim from the caller.
        </p>
      </div>
      <a className="reg-back" href="/merchant">← merchant register</a>
    </div>
  );
}

function Row({ a, b, c }: { a: string; b: string; c: string }) {
  return (
    <tr style={{ borderTop: "1px solid var(--border)" }}>
      <td style={{ padding: "10px 8px 10px 0", color: "var(--green)", whiteSpace: "nowrap" }}>{a}</td>
      <td style={{ padding: "10px 8px", color: "var(--text)" }}>{b}</td>
      <td style={{ padding: "10px 0", color: "var(--muted)" }}>{c}</td>
    </tr>
  );
}
