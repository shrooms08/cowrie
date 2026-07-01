// Cowrie pay-link (Phase R6). Everything a buyer needs rides IN the link — there
// is NO server-side resolver. The merchant register builds it; the buyer wallet
// parses it and auto-fills the Pay screen. A QR of this link is the two-device
// story; the clickable link is the one-laptop story.
//
// Params: pay=<merchant name>, amt=<USDC>, addr=<G… receiving address>,
//         fiat=<local amount>, cur=<currency code>, id=<display pay-ID>.
// (`pay`, `amt`, `addr` are the pre-R6 params — kept for compatibility.)

export interface PayLinkData {
  merchantName: string;
  usdc: number;
  addr: string;
  fiat?: number; // local-currency amount (e.g. NGN)
  currency?: string; // e.g. "NGN"
  payId?: string; // display id, e.g. "COWRIE-7F3A"
}

/** Build the relative pay-link (`/?…`). Encodes everything; no lookup needed. */
export function buildPayLink(d: PayLinkData): string {
  const p = new URLSearchParams();
  p.set("pay", d.merchantName);
  p.set("amt", String(d.usdc));
  p.set("addr", d.addr);
  if (d.fiat != null) p.set("fiat", String(d.fiat));
  if (d.currency) p.set("cur", d.currency);
  if (d.payId) p.set("id", d.payId);
  return `/?${p.toString()}`;
}

/** Absolute URL (for the QR code / copy). Falls back to the relative link on SSR. */
export function absolutePayLink(link: string): string {
  if (typeof window === "undefined") return link;
  return window.location.origin + link;
}

/** Parse a pay-link query string into its fields (buyer side). */
export function parsePayLink(search: string): PayLinkData | null {
  const q = new URLSearchParams(search);
  const merchantName = q.get("pay");
  const amt = q.get("amt");
  const addr = q.get("addr");
  if (!merchantName || !amt || !addr) return null;
  const fiat = q.get("fiat");
  return {
    merchantName,
    usdc: Number(amt),
    addr,
    fiat: fiat != null ? Number(fiat) : undefined,
    currency: q.get("cur") ?? undefined,
    payId: q.get("id") ?? undefined,
  };
}

/** A short human-readable display pay-ID, e.g. "COWRIE-7F3A". Display/label only
 * — the real data rides in the link. */
export function makePayId(): string {
  let hex = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const b = new Uint8Array(2);
    crypto.getRandomValues(b);
    hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } else {
    hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  }
  return `COWRIE-${hex.toUpperCase()}`;
}

/** Format a fiat amount with its currency symbol/code (NGN for the demo). */
export function fmtFiat(amount: number, currency = "NGN"): string {
  if (currency === "NGN") return `₦${amount.toLocaleString()}`;
  return `${amount.toLocaleString()} ${currency}`;
}
