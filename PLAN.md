# PLAN.md — Building Cowrie

Cowrie is a private USDC wallet on Stellar. We fork Nethermind's privacy-pools crypto (see
[STUDY.md](./STUDY.md)) and build a wallet, merchant checkout, clean-funds gate, and a mock anchor
on top. This file restates the build phases. **Nothing below is built yet** — the repo is scaffold +
stubs only.

## §0. Environment (verified)

| Tool | Required | Status |
|---|---|---|
| Rust | 1.94 | ✅ `rustc 1.94.0` |
| Soroban VM target | `wasm32v1-none` | ✅ installed |
| stellar CLI | ≥ 23 | ✅ `27.0.0` |
| circom | ≥ 2.1 | ✅ `2.2.3` (binary in `~/.local/bin`, amd64 via Rosetta) |
| snarkjs | ≥ 0.7 | ✅ `0.7.6` (global) |
| Node | ≥ 20 | ✅ `24.14.0` |

**Target chain:** Protocol 26 "Yardstick" (current mainnet, May 6 2026). BN254 host functions
(`g1_add`, `g1_mul`, `pairing_check`) + Poseidon2 are live since Protocol 25 "X-Ray" and made
efficient in 26. Dev/test on **testnet** (currently Protocol 27 "Zipper", backward compatible).

> Note: `circom` only ships an x86-64 macOS binary; it runs under Rosetta on this arm64 machine.
> If proving/compile perf matters later, build circom from source for native arm64.

## Architecture (target)

```
            ┌──────────── web (Next.js) ────────────┐
            │  wallet  │  merchant checkout  │ admin │
            │   snarkjs in-browser proving (WASM)    │
            └───┬──────────────┬───────────────┬─────┘
                │ Wallets Kit   │ proof+publics │ settle
                ▼               ▼               ▼
          Stellar acct     pool contract    mock-anchor
                            ├─ verifier (BN254 Groth16)
                            └─ asp (allowlist + blocklist)
```

---

## Phase 1 — Circuits (fork + setup)
**Goal:** a working `policyTransaction` (2-in/2-out) circuit + Groth16 keys.
1. Port reference circuits into `circuits/src`: `poseidon2/*`, `merkleProof`, `smt/*`, `transaction`, `policyTransaction`, `selectiveDisclosure`, `keypair`. Pin `pragma circom 2.2`.
2. `circuits/scripts/compile.sh`: circom → `policyTransaction.r1cs` + `.wasm` witness generator.
3. `circuits/scripts/setup.sh`: Powers-of-Tau (bn128) + Groth16 phase-2 → `circuit_final.zkey`, `verification_key.json`.
4. Verify with a witness via snarkjs CLI before touching contracts.
**Deliverable:** committed circuits; `verification_key.json` + `.wasm` + `.zkey` artifacts. **Crypto unchanged from reference.**

## Phase 2 — Verifier contract
**Goal:** on-chain Groth16 verification on BN254.
1. Port `circom-groth16-verifier` into `contracts/verifier`; embed `verification_key.json` at build time (`build.rs` → `vk.rs`).
2. Implement `verify_proof`: fold publics into `vk_x` via `bn254().g1_mul`/`g1_add`, then 4-term `pairing_check`.
3. Unit tests with a real proof from Phase 1. `stellar contract build` to `wasm32v1-none`.
**Deliverable:** `cowrie-verifier.wasm` that verifies a Phase-1 proof.

## Phase 3 — Pool + ASP contracts
**Goal:** state machine for private USDC + clean-funds gate.
1. `contracts/pool`: commitment Merkle tree w/ root history, nullifier set, `transact(proof, ext_data, sender)` (deposit/withdraw/transfer), wired to verifier + ASP + USDC SAC.
2. `contracts/asp`: incremental Poseidon2 allowlist tree (`insert_leaf`, admin-gated, `get_root`) + Sparse-Merkle blocklist (non-membership).
3. Constructors wiring token/verifier/asp addresses; double-spend + root + ASP-root checks.
**Deliverable:** deployable `pool` + `asp`; contract tests for deposit→spend→double-spend-reject.

## Phase 4 — Web wallet + in-browser proving
**Goal:** a user can hold USDC privately and prove a spend.
1. Stellar Wallets Kit connect; USDC balance + note (UTXO) management in browser (encrypted local store).
2. `web/lib/prover.ts`: `snarkjs.groth16.fullProve(input, policyTransaction.wasm, circuit_final.zkey)`; map snarkjs proof → Soroban A/B/C bytes (G2 c1‖c0). Serve artifacts from `web/public/circuits/`.
3. Deposit + transfer/withdraw flows building witness inputs (notes, Merkle paths, nullifiers) and submitting `transact`.
**Deliverable:** working deposit + private transfer in the browser on testnet.
> Divergence from reference (custom arkworks Rust prover) — see STUDY.md §4. Rust prover kept as fallback.

## Phase 5 — Merchant checkout
**Goal:** pay a merchant privately; they get paid.
1. Checkout page: merchant requests amount; wallet builds a withdraw-to-merchant `transact` (ext_data recipient = merchant payout address).
2. Prove ability-to-pay + clean-funds; submit; show merchant a confirmation tied to the on-chain settlement.
**Deliverable:** end-to-end "scan → prove → pay" demo.

## Phase 6 — Mock anchor
**Goal:** USDC → local currency settlement (faked).
1. `mock-anchor`: verify the pool withdrawal on-chain via RPC, apply an FX quote, record a payout reference (SEP-24/31-shaped API).
2. Merchant checkout calls `/settle`; display local-currency payout.
**Deliverable:** merchant sees local-currency payout for a private USDC payment.

## Phase 7 — Clean-funds gate, deploy & e2e
**Goal:** glue + the allowlist story + repeatable deploy.
1. ASP admin UI / script to populate the approved allowlist; enforce membership + non-membership in proofs.
2. `scripts/deploy.sh`: build+deploy verifier (VK embedded), asp, pool; init; write `deployments/<network>.json`.
3. `scripts/e2e.sh`: compile → setup → deploy → start anchor → deposit → pay → settle; assertions.
**Deliverable:** one-command testnet deploy + green e2e.

---

## Cross-cutting
- **Security:** reference is unaudited/WIP — Cowrie is a demo, not production. Trusted-setup ceremony is single-contributor for the demo; document this.
- **USDC:** use the testnet USDC SAC (or a mock SAC) as the pool token.
- **Out of scope (demo):** real anchor/KYC, multi-asset pools, mobile, relayer/fee abstraction.

## Immediate next step
Awaiting your go-ahead. On approval, start **Phase 1** (port circuits + run trusted setup) — it unblocks Phases 2 and 4.
