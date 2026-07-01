/* tslint:disable */
/* eslint-disable */

export function __wasm_start(): void;

export function asp_leaf_for(priv_dec: string): string;

export function blocklist_root(): string;

/**
 * Build the full circom input.json + the structured spend() params for a spend
 * of the wallet's note (slot 1) plus the global canonical dummy (slot 0).
 */
export function build_spend(wallet_priv_dec: string, note_blinding_dec: string, note_amount: number, note_pool_index: number, pool_leaves_json: string, asp_leaves_json: string, note_asp_index: number, dummy_asp_index: number, merchant_dec: string, payout: number): string;

/**
 * Build a spend witness with EXPLICIT 2 inputs and 2 outputs. Supports
 * arbitrary payout + a change note (outputs[0]) owned by the payer, and two
 * real inputs (combine notes). Value conservation is enforced by the circuit
 * (`sumIns + publicAmount === sumOuts`), not here — a non-balancing config
 * simply fails witness generation downstream.
 */
export function build_spend_change(config_json: string): string;

export function derive_pubkey(priv_dec: string): string;

export function dummy_asp_leaf(): string;

export function dummy_nullifier(): string;

/**
 * Pool/ASP Merkle root for a populated leaf prefix (decimal JSON array),
 * padding with the Poseidon2("XLM") zero-leaf. Matches the contracts exactly —
 * used for deposit-resilience checks (did my deposit land?).
 */
export function merkle_root_of(leaves_json: string): string;

export function note_commitment(amount: number, priv_dec: string, blinding_dec: string): string;

/**
 * Nullifier of a note at a given pool path (pathIndices == leaf index). Used to
 * bind a payment-receipt proof to a specific spent note.
 */
export function note_nullifier(amount: number, priv_dec: string, blinding_dec: string, path_indices: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wasm_start: () => void;
    readonly asp_leaf_for: (a: number, b: number) => [number, number];
    readonly blocklist_root: () => [number, number];
    readonly build_spend: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number];
    readonly build_spend_change: (a: number, b: number) => [number, number];
    readonly derive_pubkey: (a: number, b: number) => [number, number];
    readonly dummy_asp_leaf: () => [number, number];
    readonly dummy_nullifier: () => [number, number];
    readonly merkle_root_of: (a: number, b: number) => [number, number];
    readonly note_commitment: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly note_nullifier: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
