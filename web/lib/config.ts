// Cowrie testnet config. Contract IDs are the post-fix Phase-2 deployment
// (deployments/testnet/phase2.json is the source of truth).
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

// REAL USDC rail (canonical). The pool pulls real USDC on deposit
// (from.require_auth rooted at deposit) and sends real USDC to the merchant on
// payout; change stays a private note. Change-enabled + arbitrary payout
// (deposits stay fixed-denom). Verifier + USDC SAC reused.
//
// Fresh small-tree redeploy (pre-demo reset): the prior pool/ASP accumulated
// enough leaves that early leaf events aged out of the public RPC's ~8000-ledger
// event window, making tree reconstruction impossible (unknown-pool-root /
// ASP-root-mismatch). These are freshly deployed + seeded (pool empty-tree root,
// ASP dummy@0 + blocklist), verified on-chain BEFORE this rewire. See
// deployments/testnet/r7-redeploy.json.
export const POOL_ID = "CBWVWCZI2CN7PIC7UR7AHJFD4GT3UVCGLWDW3B63W6AWVTE2IMTHUZ5B";
export const ASP_ID = "CCD33Z46QFHZOA4FCUM6DND7H6WGUK5VSX2YUZV5PUVXRKY3QB3F3UPL";
export const VERIFIER_ID = "CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T";

// USDC Stellar Asset Contract (testnet) — the real rail the pool pulls/sends.
// `stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
export const USDC_SAC_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC_ASSET_CODE = "USDC";
export const USDC_DECIMALS = 7; // $1 = 10_000_000 stroops
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
