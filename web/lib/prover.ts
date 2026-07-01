// Cowrie in-browser Groth16 proving. snarkjs, TWO SEPARATE STEPS:
//   1) witness via the circom-generated witness_calculator (handles bus inputs)
//   2) snarkjs.groth16.prove(zkey, wtns)
// NEVER snarkjs.groth16.fullProve — it mis-parses this circuit's bus inputs
// (membershipProofs / nonMembershipProofs). See PHASE1.md.
import { CIRCUIT_WASM, CIRCUIT_ZKEY } from "./config";

let builderPromise: Promise<(wasm: ArrayBuffer) => Promise<WitnessCalc>> | null = null;
let wasmBufPromise: Promise<ArrayBuffer> | null = null;
let zkeyPromise: Promise<Uint8Array> | null = null;

interface WitnessCalc {
  calculateWTNSBin(input: Record<string, unknown>, sanityCheck: number): Promise<Uint8Array>;
}

// The circom witness_calculator.js is CommonJS; load it without webpack by
// evaluating its source with a synthetic module object.
function loadBuilder() {
  if (!builderPromise) {
    builderPromise = fetch("/circuits/witness_calculator.js")
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
  if (!wasmBufPromise) wasmBufPromise = fetch(CIRCUIT_WASM).then((r) => r.arrayBuffer());
  return wasmBufPromise;
}
function loadZkey() {
  if (!zkeyPromise) zkeyPromise = fetch(CIRCUIT_ZKEY).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
  return zkeyPromise;
}

export interface Groth16Result {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  publicSignals: string[];
}

/** Real proof: compute witness (circom), then groth16.prove. Returns proof + publics. */
export async function prove(input: Record<string, unknown>): Promise<Groth16Result> {
  const [builder, wasmBuf, zkey] = await Promise.all([loadBuilder(), loadWasm(), loadZkey()]);
  const wc = await builder(wasmBuf);
  const wtns = await wc.calculateWTNSBin(input, 0);
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, wtns);
  return { proof, publicSignals };
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
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert a snarkjs proof to the proven Soroban 256-byte layout:
 *   A = x||y, B = x.c1||x.c0||y.c1||y.c0 (imaginary first), C = x||y. 32B BE each.
 */
export function proofToSorobanHex(p: Groth16Result["proof"]): string {
  const parts = [
    be32(p.pi_a[0]), be32(p.pi_a[1]),
    be32(p.pi_b[0][1]), be32(p.pi_b[0][0]), be32(p.pi_b[1][1]), be32(p.pi_b[1][0]),
    be32(p.pi_c[0]), be32(p.pi_c[1]),
  ];
  const out = new Uint8Array(256);
  parts.forEach((part, i) => out.set(part, i * 32));
  return hex(out);
}
