// Cowrie testnet config. Contract IDs are the post-fix Phase-2 deployment
// (deployments/testnet/phase2.json is the source of truth).
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

// R1 (Phase R1): change-enabled pool — spend() inserts change-note leaves and
// emits ChangeNote events; arbitrary payout allowed (deposits stay fixed-denom).
// Fresh canonical pair deployed for the type-an-amount Pay UI. Verifier unchanged.
export const POOL_ID = "CCTBEMP4XHVOKMDV4YV7UUFFV4AC3BR4SS53GAUX3AY4AJI6KM33RJO2";
export const ASP_ID = "CA2PDO76B534G6UNM57POD6UKM4S254TNX75SXGRDUMJXTJ5UB4UWQAU";
export const VERIFIER_ID = "CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T";
// Receipt (selective-disclosure / proof-of-payment) verifier — same Groth16
// verifier code, embeds the paymentReceipt circuit VK (4 public inputs).
export const RECEIPT_VERIFIER_ID = "CA6BDTDPO6ARRTHVFQ6LTJLP255JZDEPAPISXDAM5P7PF7FYBXRAGCXI";

// Receipt circuit artifacts served from /public/circuits/receipt.
export const RECEIPT_WASM = "/circuits/receipt/paymentReceipt.wasm";
export const RECEIPT_ZKEY = "/circuits/receipt/receipt_final.zkey";

// Fixed denominations for DEPOSITS (top-ups). Spends are arbitrary-amount and
// mint a change note for the remainder (Phase R1).
export const DENOMINATIONS = [1, 5, 10, 50] as const;
export type Denom = (typeof DENOMINATIONS)[number];

// Circuit artifacts served from /public/circuits.
export const CIRCUIT_WASM = "/circuits/policy_tx_2_2.wasm";
export const CIRCUIT_ZKEY = "/circuits/policy_final.zkey";
export const VK_JSON = "/circuits/verification_key.json";
