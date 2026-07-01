// Shared merchant-identity + anchor-quote logic. The buyer wallet and the
// merchant register MUST derive the same merchant id from the same inputs, so
// the on-chain SpendEvent (merchant, payout) is what links an invoice to a
// payment — nothing else.

import { DENOMINATIONS } from "./config";

// MOCK FX rate — the SINGLE source of truth for NGN/USDC across the app (invoice
// quote, buyer pay screen, anchor settle, mock-anchor page, README). Exposed in
// the UI, never hidden. In production this comes from a Stellar anchor RFQ
// (SEP-38), not a constant. ~₦1,388 mid-market / ~₦1,400 parallel (July 2026).
export const ANCHOR_RATE_NGN_PER_USDC = 1400;
export const ANCHOR_NAME = "Cowrie Anchor (MOCK)";
export const RATE_LABEL = `₦${ANCHOR_RATE_NGN_PER_USDC.toLocaleString()} / $1`;

/** Derived fiat (NGN) estimate for a whole-USDC amount, at the mock rate. USDC is
 * the authoritative invoice amount; fiat is display-only (Phase R-refine). */
export function fiatFromUsdc(usdc: number): number {
  return Math.round(usdc * ANCHOR_RATE_NGN_PER_USDC);
}

/** Deterministic merchant id (BN254 field element, decimal). Bound in the proof
 * via extDataHash; both wallet and register compute it identically. */
export function merchantToField(name: string): string {
  let h = 0n;
  for (const ch of name.trim()) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 200n);
  return (h === 0n ? 12648430n : h).toString();
}

/** Snap a USDC amount to the nearest supported note denomination. */
export function snapDenomination(usdc: number): number {
  return DENOMINATIONS.reduce((best, d) => (Math.abs(d - usdc) < Math.abs(best - usdc) ? d : best), DENOMINATIONS[0]);
}

export interface Quote {
  ngn: number; // effective NGN the buyer's note settles to
  usdc: number; // USDC denomination the buyer must pay
  rate: number; // NGN per USDC (exposed)
  rateLabel: string;
  sep: string;
}

/** Given a requested NGN amount, quote the USDC to charge at the (exposed) rate.
 * Payments are arbitrary-amount (Phase R1+), so we charge whole USDC dollars —
 * the buyer's wallet covers it with 1–2 notes and returns change. */
export function quoteFromNgn(ngnRequested: number): Quote {
  const usdc = Math.max(1, Math.round(ngnRequested / ANCHOR_RATE_NGN_PER_USDC));
  return {
    usdc,
    ngn: usdc * ANCHOR_RATE_NGN_PER_USDC,
    rate: ANCHOR_RATE_NGN_PER_USDC,
    rateLabel: `₦${ANCHOR_RATE_NGN_PER_USDC.toLocaleString()} / $1`,
    sep: "SEP-38 (quote)",
  };
}

export const fmtNGN = (n: number) => `₦${n.toLocaleString()}`;
