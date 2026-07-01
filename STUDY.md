# STUDY.md — How Nethermind's `stellar-private-payments` Works

This is a plain-language study of the reference implementation we are forking
([NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments),
cloned to `./reference-stellar-private-payments`). It is a **reference implementation of Privacy
Pools for Stellar**: deposit/transfer/withdraw a token while hiding amounts and the sender↔receiver
link, with an **Association Set Provider (ASP)** layer that lets an operator enforce "clean funds"
controls without de-anonymizing users.

Cowrie reuses this crypto machinery and builds a stablecoin wallet, merchant checkout, clean-funds
gate, and a mock anchor on top.

---

## 0. Platform & protocol context (verified against live sources, June 2026)

The ZK host functions are new, so this is verified against the Stellar software-versions page and CAP specs:

| Protocol | Name | Mainnet | ZK-relevant additions |
|---|---|---|---|
| 23 | Whisk | Sep 3 2025 | Unified Events, State Archival |
| 25 | X-Ray | Jan 22 2026 | **BN254 curve ops** (`bn254_g1_add`, `bn254_g1_mul`, `bn254_multi_pairing_check`), **Poseidon/Poseidon2** hash host functions |
| 26 | Yardstick | **May 6 2026 (current mainnet)** | Host functions for **efficient ZK BN254 use cases**, muxed-address strkey, checked 256-bit int arithmetic |
| 27 | Zipper | Jun 18 2026 (testnet) | Auth delegation / address-bound Soroban credentials |

**Takeaways for Cowrie:**
- Groth16 over **BN254** is verifiable **natively on-chain** since Protocol 25, and made efficient in Protocol 26. We target **Protocol 26 (Yardstick)**.
- The three BN254 host functions are exposed in `soroban-sdk` v26 via `env.crypto().bn254()` → `.g1_add()`, `.g1_mul()`, `.pairing_check()`.
- Poseidon2 is available as a host function, but the reference also ships its own Rust `poseidon2` crate (for tests / non-host contexts).

---

## 1. The Circom circuits — what each proves

Location: `reference-stellar-private-payments/circuits/src/`. Hash primitive throughout is
**Poseidon2** with domain-separation tags.

### Note / UTXO model (Tornado-Nova / JoinSplit style)
A "note" (UTXO) is `(amount, publicKey, blinding)`. Two derived values matter:

```
publicKey  = Poseidon2(privateKey, 0)                          // domain 0x03
commitment = Poseidon2(amount, publicKey, blinding)            // domain 0x01  → inserted into the pool tree
signature  = Poseidon2(privateKey, commitment, merklePath)     // domain 0x04
nullifier  = Poseidon2(commitment, merklePath, signature)      // domain 0x02  → revealed on spend
```
The nullifier is tied to *where the commitment sits in the tree*, so spending it twice is detectable, but it leaks nothing about amount or owner.

### Circuit files
| File | What it proves |
|---|---|
| `transaction.circom` | **Main JoinSplit.** For `nIns` inputs / `nOuts` outputs: ownership of each input (knows private key → signature → nullifier), each input commitment is in the Merkle tree (`root`), output commitments are well-formed, and **balance**: `sum(inAmount) + publicAmount == sum(outAmount)`. |
| `policyTransaction.circom` | **`transaction` + ASP policy.** For each input also proves ASP **membership** (commitment's owner key is in the approved Merkle tree) and **non-membership** (not in the blocked Sparse-Merkle-Tree). This is the "clean funds" proof. The deployed key is `policy_tx_2_2` = 2-in/2-out. |
| `selectiveDisclosure.circom` | Proves ownership of a commitment (knows amount+blinding) **without revealing the secrets** — used for audits / proving a balance to a third party. |
| `keypair.circom` | Derives `publicKey = Poseidon2(privateKey,0)`. |
| `merkleProof.circom` / `merkleTree.circom` / `merkleTreeUpdater.circom` | Binary Merkle membership + tree update. |
| `smt/smtverifier.circom`, `smtverifierlevel.circom`, `smthash_poseidon2.circom` | **Sparse Merkle Tree** verifier — used for ASP **non-membership** (prove a key is *absent* from the blocklist). |
| `poseidon2/poseidon2_hash.circom`, `_compress.circom`, `_perm.circom` | Poseidon2 hash / 2-to-1 compression / permutation primitives. |

### Public signals of the main (`policyTransaction`) circuit
`root`, `publicAmount` (external amount − fee, in the field), `extDataHash` (binds recipient/fee/etc.),
`inputNullifier[nIns]`, `outputCommitment[nOuts]`, and the ASP `membershipRoots` / `nonMembershipRoots`.
Everything else (amounts, keys, blindings, Merkle paths) is **private**.

---

## 2. The on-chain Groth16 verifier and which BN254 host functions it calls

Location: `contracts/circom-groth16-verifier/src/lib.rs`. Built on **`soroban-sdk` v26**.

The verification key is **embedded at compile time**: `build.rs` reads a snarkjs `verification_key.json`
(path via env var) and emits `vk.rs` with constants `VK_ALPHA_G1`, `VK_BETA_G2`, `VK_GAMMA_G2`,
`VK_DELTA_G2`, `VK_IC[]`, pulled in via `include!(concat!(env!("OUT_DIR"), "/vk.rs"))`.

Proof type (`contracts/types/src/lib.rs`) — 256 bytes total:
```rust
pub struct Groth16Proof { pub a: Bn254G1Affine,   // G1, 64B (x‖y)
                          pub b: Bn254G2Affine,   // G2, 128B (Soroban c1‖c0 ordering)
                          pub c: Bn254G1Affine }  // G1, 64B
```

The verification itself calls the **three BN254 host functions** via `env.crypto().bn254()`:
```rust
let bn = env.crypto().bn254();
// Fold public inputs into vk_x:  vk_x = IC[0] + Σ input_i · IC[i+1]
let prod = bn.g1_mul(&v, &s);           // bn254_g1_mul
vk_x = bn.g1_add(&vk_x, &prod);         // bn254_g1_add
// Final check:  e(-A,B)·e(alpha,beta)·e(vk_x,gamma)·e(C,delta) == 1
let g1 = vec![env, neg_a, vk.alpha, vk_x, proof.c];
let g2 = vec![env, proof.b, vk.beta, vk.gamma, vk.delta];
if bn.pairing_check(g1, g2) { Ok(true) } else { Err(Groth16Error::InvalidProof) }   // bn254_multi_pairing_check
```
So: `g1_mul` + `g1_add` to build the public-input commitment `vk_x`, then a single
4-term `pairing_check`. This is the standard Groth16 verification equation.

---

## 3. The pool, nullifier, and ASP membership contracts

Location: `contracts/`. Each is a Soroban contract crate.

### `pool` — the privacy pool (`pool/src/pool.rs`, `merkle_with_history.rs`)
State (`DataKey`): `Admin`, `Token`, `Verifier` (verifier contract addr), `MaximumDepositAmount`,
`Nullifiers` (`Map<U256,bool>`), `ASPMembership` + `ASPNonMembership` (the two ASP contract addrs),
plus a **`MerkleTreeWithHistory`** of commitments (current root + a ring buffer of recent roots so
in-flight proofs against a slightly-stale root still verify).

The single entry point is `transact(proof, ext_data, sender)` — deposit/withdraw/transfer are all the
same JoinSplit with different external amounts:
1. `ext_amount > 0` → pull tokens in (deposit). `< 0` → pay tokens out (withdraw). `== 0` → pure transfer.
2. Check `proof.root` is a known/recent root (`is_known_root`).
3. Reject if any `input_nullifier` is already spent.
4. Recompute `extDataHash` from `ext_data`, must equal `proof.ext_data_hash`.
5. Recompute expected `public_amount` from `ext_amount`+fee, must equal `proof.public_amount`.
6. ASP roots in the proof must equal the live membership/non-membership roots.
7. Build public inputs, call the **verifier contract** → `pairing_check`.
8. Mark nullifiers spent (emit `NewNullifierEvent`), move tokens, insert the two output commitments into the tree.

Double-spend prevention = the `Nullifiers` map; a nullifier flips to `true` on spend and step 3 blocks reuse.

### `asp-membership` — approved-set Merkle tree (`asp-membership/src/lib.rs`)
An incremental binary Merkle tree (Poseidon2 2-to-1 compression). State: `FilledSubtrees(level)`,
`Zeroes(level)`, `Levels`, `NextIndex`, `Root`, `AdminInsertOnly`. Interface: `insert_leaf(leaf: U256)`
— gated by `admin.require_auth()` when `AdminInsertOnly` (default on). Emits `LeafAddedEvent{leaf,index,root}`.
This is the **allowlist** the clean-funds proof checks membership against.

### `asp-non-membership` — blocklist Sparse Merkle Tree (`asp-non-membership/src/lib.rs`)
A **Sparse Merkle Tree** stored as `Node(hash) -> value`. Provides `FindResult{found, siblings,
is_old0, ...}` so a caller can build a circuit-checkable non-membership proof (prove a key is absent).
This is the **blocklist** the clean-funds proof checks non-membership against.

### `public-key-registry` (`public-key-registry/src/lib.rs`)
Lets a user `register(Account{owner, encryption_key /*X25519*/, note_key /*BN254*/})` and emits
`PublicKeyEvent` for off-chain discovery (so others can encrypt notes to them). Not required for pool ops.

### `types`, `soroban-utils`
Shared `#[contracttype]` structs (proof, ext-data, BN254 points) and Poseidon2/hashing helpers.

---

## 4. How proofs are generated client-side (the part Cowrie will replace)

Location: `app/`. **Important divergence:** the reference does **not** use snarkjs in the browser. It
ships a **custom arkworks-based Rust→WASM prover** because `ark_circom`'s default prover depends on
`wasmer` in a way that doesn't fit browser WASM. The pipeline:

- `app/crates/core/witness` — wraps `ark-circom`'s witness calculator. Loads the circuit `.wasm` +
  `.r1cs`, takes inputs, produces **witness bytes**.
- `app/crates/core/prover` — loads the **proving key** (`policy_tx_2_2_proving_key.bin`), replays
  constraints, and runs **`ark-groth16`** `prove()` to produce a 256-byte Soroban-format proof.
- `app/crates/platforms/web` — the `wasm-bindgen` crate; `mainThread(config)` is the only Rust API
  exposed to JS. It spawns a **Prover Worker** (heavy proving off the UI thread) and a Storage Worker
  (SQLite over OPFS) and an Indexer that polls Stellar RPC for commitment/nullifier events.
- `app/js/wasm-facade.js` (`initializeWasm` → `init()` + `mainThread(config)`), `app/js/wallet.js`
  (Freighter), `app/js/ui/` (UI). Bundled with **`trunk`** (`make serve`).
- Circuit artifacts live in `deployments/testnet/circuit_keys/`: `policy_tx_2_2_proving_key.bin` (8.1MB),
  `policy_tx_2_2_vk.json`, `..._vk_const.rs` (for the verifier), `..._vk_soroban.bin`,
  plus `selectiveDisclosure_1_*`.

**Cowrie's choice:** our `/web` spec uses **snarkjs in-browser proving** (load `circuit.wasm` +
`circuit_final.zkey`, call `snarkjs.groth16.fullProve(input, wasm, zkey)`), which is simpler to wire
than the custom Rust prover and is the more common path. The on-chain verifier and circuits are
unchanged — only the client proving stack differs. We keep the reference's Rust prover available as a
fallback if snarkjs proves too slow/large in the browser.

---

## 5. Build / deploy glue

- **`Makefile`**: `make install` (npm in `app/`, `rustup target add wasm32v1-none`, `cargo install trunk`),
  `make circuits-build` (`cargo build -p circuits`), `make serve` / `make build` (trunk).
- **`rust-toolchain.toml`** pins the toolchain; Soroban contracts compile to **`wasm32v1-none`** (the
  Protocol-23+ Soroban target — not the old `wasm32-unknown-unknown`).
- **Workspace** `Cargo.toml` members: `circuits`, `poseidon2`, `circuit-keys`, `contracts/*`,
  `app/crates/core/*`, `app/crates/platforms/web`, `e2e-tests`, `tools/ceremony-cli`.
- **Trusted setup**: `tools/ceremony-cli` + `circuit-keys` produce the proving/verification keys;
  artifacts are committed under `deployments/<network>/circuit_keys/`.
- **`deployments/scripts/deploy.sh <network> --deployer … --asp-levels N --pool-levels N --max-deposit …
  --vk-file …json --pool native:<XLM id> --pool classic:CODE:ISSUER:<id>`**: loads the VK, builds the
  verifier with the VK embedded, builds + deploys pool / asp-membership / asp-non-membership, runs
  constructors, writes `deployments/<network>/deployments.json`. Supports multiple token pools.
- The **VK→contract** path: snarkjs `verification_key.json` → `build.rs` → `vk.rs` constants compiled
  into the verifier Wasm. Re-running the trusted setup means rebuilding+redeploying the verifier.

---

## What Cowrie keeps vs. builds

**Fork / keep (the crypto):** the Circom circuits (`transaction` / `policyTransaction` / SMT / Poseidon2),
the `circom-groth16-verifier` contract and its BN254 host-function calls, the `pool` + `asp-membership` +
`asp-non-membership` + `public-key-registry` contracts, the trusted-setup tooling.

**Build new (the product):** USDC stablecoin wallet UX, **merchant checkout** flow, the **clean-funds
gate** (drive ASP membership/non-membership for an approved allowlist), a **mock anchor** service that
fakes USDC→local-currency settlement, snarkjs-based in-browser proving, and Stellar Wallets Kit
integration (instead of raw Freighter).
