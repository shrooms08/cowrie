// In-browser proving for the payment-receipt (selective disclosure) circuit.
// Same two-step path as the spend: circom witness_calculator -> groth16.prove
// (NEVER fullProve). Reuses the proven Soroban serialization.
import { RECEIPT_WASM, RECEIPT_ZKEY } from "./config";

let builderPromise: Promise<(wasm: ArrayBuffer) => Promise<WitnessCalc>> | null = null;
let wasmBufPromise: Promise<ArrayBuffer> | null = null;
let zkeyPromise: Promise<Uint8Array> | null = null;

interface WitnessCalc {
  calculateWTNSBin(input: Record<string, unknown>, sanityCheck: number): Promise<Uint8Array>;
}

function loadBuilder() {
  if (!builderPromise) {
    builderPromise = fetch("/circuits/receipt/witness_calculator.js")
      .then((r) => r.text())
      .then((src) => {
        const mod = { exports: {} as unknown as (wasm: ArrayBuffer) => Promise<WitnessCalc> };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function("module", "exports", src)(mod, mod.exports);
        return mod.exports;
      });
  }
  return builderPromise;
}
function loadWasm() {
  if (!wasmBufPromise) wasmBufPromise = fetch(RECEIPT_WASM).then((r) => r.arrayBuffer());
  return wasmBufPromise;
}
function loadZkey() {
  if (!zkeyPromise) zkeyPromise = fetch(RECEIPT_ZKEY).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
  return zkeyPromise;
}

export interface ReceiptInput {
  nullifier: string; // public
  amount: string; // public
  merchant: string; // public (field)
  recipient: string; // public (field) — the named recipient R
  privateKey: string; // private (payer identity)
  blinding: string; // private (note)
  pathIndices: string; // private (note leaf index)
}

function be32(dec: string): Uint8Array {
  let x = BigInt(dec);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Real receipt proof. Returns the 256-byte Soroban proof hex. */
export async function proveReceipt(input: ReceiptInput): Promise<string> {
  const [builder, wasmBuf, zkey] = await Promise.all([loadBuilder(), loadWasm(), loadZkey()]);
  const wc = await builder(wasmBuf);
  const wtns = await wc.calculateWTNSBin(input as unknown as Record<string, unknown>, 0);
  const snarkjs = await import("snarkjs");
  const { proof } = await snarkjs.groth16.prove(zkey, wtns);
  const parts = [
    be32(proof.pi_a[0]), be32(proof.pi_a[1]),
    be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]), be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]),
    be32(proof.pi_c[0]), be32(proof.pi_c[1]),
  ];
  const out = new Uint8Array(256);
  parts.forEach((p, i) => out.set(p, i * 32));
  return hex(out);
}

// Public-input order the receipt circuit + verifier expect.
export function receiptPublicHex(pubs: { nullifier: string; amount: string; merchant: string; recipient: string }): string {
  const buf = new Uint8Array(128);
  [pubs.nullifier, pubs.amount, pubs.merchant, pubs.recipient].forEach((d, i) => buf.set(be32(d), i * 32));
  return hex(buf);
}

// Shareable receipt blob. Carries the proof + public values + display names.
// The intended recipient is shown for context, but verification always uses the
// VERIFIER'S OWN identity as R — a receipt is only valid for the named party.
export interface ReceiptBlob {
  v: 1;
  proof: string; // 256-byte hex
  nullifier: string;
  amount: number; // the SPENT NOTE's value — folded into the nullifier, so the
  // proof binds it; equals payout for a full-note (no-change) spend.
  payout?: number; // the merchant payout (Phase R1). For change spends this is
  // < amount; it is the authoritative figure, cross-checked vs the SpendEvent.
  // Absent on legacy receipts (then payout == amount).
  merchant: string; // field
  merchantName: string;
  recipient: string; // field R it was bound to
  recipientName: string;
}

export function encodeReceipt(b: ReceiptBlob): string {
  return "cowrie-receipt:" + btoa(JSON.stringify(b));
}
export function decodeReceipt(s: string): ReceiptBlob {
  const raw = s.trim().replace(/^cowrie-receipt:/, "");
  const b = JSON.parse(atob(raw)) as ReceiptBlob;
  if (b.v !== 1 || !b.proof || !b.nullifier) throw new Error("not a Cowrie receipt");
  return b;
}
