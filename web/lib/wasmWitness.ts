// Loader for the Rust-compiled witness builder (Poseidon2/merkle/SMT).
// One source of truth shared with the circuit + contracts — no JS Poseidon2.
import init, * as wasm from "./cowrie_wasm/cowrie_wasm.js";

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready) ready = init({ module_or_path: "/circuits/cowrie_wasm_bg.wasm" }).then(() => {});
  return ready;
}

export interface SpendBuild {
  input: Record<string, unknown>;
  root: string;
  public_amount: string;
  ext_data_hash: string;
  input_nullifiers: [string, string];
  output_commitments: [string, string];
  asp_membership_root: string;
  asp_non_membership_root: string;
  merchant: string;
  payout: number;
  real_nullifier: string;
}

export async function noteCommitment(amount: number, privDec: string, blindingDec: string): Promise<string> {
  await ensure();
  return wasm.note_commitment(amount, privDec, blindingDec);
}
export async function aspLeafFor(privDec: string): Promise<string> {
  await ensure();
  return wasm.asp_leaf_for(privDec);
}
export async function dummyAspLeaf(): Promise<string> {
  await ensure();
  return wasm.dummy_asp_leaf();
}
export async function dummyNullifier(): Promise<string> {
  await ensure();
  return wasm.dummy_nullifier();
}
export async function blocklistRoot(): Promise<string> {
  await ensure();
  return wasm.blocklist_root();
}
export async function merkleRootOf(leaves: string[]): Promise<string> {
  await ensure();
  return wasm.merkle_root_of(JSON.stringify(leaves));
}
export async function noteNullifier(amount: number, privDec: string, blindingDec: string, pathIndices: number): Promise<string> {
  await ensure();
  return wasm.note_nullifier(amount, privDec, blindingDec, pathIndices);
}
export async function derivePubkey(privDec: string): Promise<string> {
  await ensure();
  return wasm.derive_pubkey(privDec);
}

// ---- arbitrary-amount spend with change (Phase R1) ----
// Mirrors build_spend_change in the Rust crate: EXACTLY 2 inputs + 2 outputs.
// Slot 0/1 inputs are each a real note or the canonical dummy. outputs[0] is the
// change note owned by the payer, outputs[1] is a zero note. Value conservation
// is enforced by the circuit, not here.
export interface ChangeInSlot {
  priv_dec: string;
  blinding_dec: string;
  amount: number;
  pool_index: number;
  asp_index: number;
}
export interface ChangeOutSlot {
  pubkey_dec: string;
  blinding_dec: string;
  amount: number;
}
export interface SpendChangeBuild {
  input: Record<string, unknown>;
  root: string;
  public_amount: string;
  ext_data_hash: string;
  input_nullifiers: [string, string];
  output_commitments: [string, string];
  asp_membership_root: string;
  asp_non_membership_root: string;
  merchant: string;
  payout: number;
  input_real_nullifiers: string[];
}
export async function buildSpendChange(cfg: {
  inputs: [ChangeInSlot, ChangeInSlot];
  outputs: [ChangeOutSlot, ChangeOutSlot];
  pool_leaves: string[];
  asp_leaves: string[];
  merchant_dec: string;
  payout: number;
}): Promise<SpendChangeBuild> {
  await ensure();
  return JSON.parse(wasm.build_spend_change(JSON.stringify(cfg))) as SpendChangeBuild;
}

export async function buildSpend(args: {
  walletPriv: string;
  blinding: string;
  amount: number;
  poolIndex: number;
  poolLeaves: string[];
  aspLeaves: string[];
  noteAspIndex: number;
  dummyAspIndex: number;
  merchant: string;
  payout: number;
}): Promise<SpendBuild> {
  await ensure();
  const out = wasm.build_spend(
    args.walletPriv,
    args.blinding,
    args.amount,
    args.poolIndex,
    JSON.stringify(args.poolLeaves),
    JSON.stringify(args.aspLeaves),
    args.noteAspIndex,
    args.dummyAspIndex,
    args.merchant,
    args.payout
  );
  return JSON.parse(out) as SpendBuild;
}
