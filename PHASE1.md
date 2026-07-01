# Phase 1 — Real circuits + trusted setup (PASSED ✅)

**Goal:** a single Groth16 proof that proves spend **and** clean-funds together —
generated and verified HEADLESS, on Stellar testnet, before any UI.

**Result:** the ported `policy_tx_2_2` circuit (2-in/2-out, pool-Merkle membership +
ASP-allowlist membership + blocklist non-membership + nullifier + amount binding)
produces ONE Groth16/BN254 proof that:
- verifies locally (`snarkjs groth16 verify` → `OK!`), and
- verifies **on testnet** via the BN254 host functions (`verify_bytes(...)` → `true`),
- is rejected when tampered, and
- **cannot be produced at all for a non-allowlisted note** (clean-funds is load-bearing).

The proof simultaneously attests to all four required statements:
(a) ownership of an unspent note that is a leaf in the pool commitment tree,
(b) that same note's membership in the ASP allowlist tree (clean funds),
(c) a revealed nullifier hash (double-spend prevention),
(d) binding to the public inputs `publicAmount` + `extDataHash` (recipient/amount).

## Circuit (ported from reference, crypto unchanged)

`circuits/src/policy_tx_2_2.circom` = `PolicyTransaction(2, 2, 1, 1, 10, 10)`
(2 in, 2 out, 1 membership proof, 1 non-membership proof, 10-level pool/ASP trees,
10-level SMT blocklist). Poseidon2 (vendored `zkhash` params), iden3 circomlib pinned
at `35e54ea2…` (vendored at `circuits/src/circomlib`). `pragma circom 2.2.2`.

| Metric | Value |
|---|---|
| Constraints (r1cs) | **37,616** (19,842 non-linear + 17,774 linear) |
| Public inputs | **11** (→ 12 IC points) |
| Private inputs | 88 |
| Wires | 37,679 · template instances 228 |

Public input order (= circom declaration order = snarkjs `public.json` order, used
verbatim by the verifier's IC folding — **no reordering needed**):
`root, publicAmount, extDataHash, inputNullifier[0..1], outputCommitment[0..1],
membershipRoots[0..1], nonMembershipRoots[0..1]`.

## Trusted setup — **DEV ONLY** (throwaway, single-contributor)

snarkjs Powers of Tau `bn128`, 2^16 (min domain for 37,616 constraints) + Groth16
phase-2, throwaway entropy. **Not a real ceremony — must be redone before mainnet.**

| Artifact | Size |
|---|---|
| `pot16_final.ptau` | 75,498,926 B (verified `Powers of Tau Ok!`) |
| `policy_final.zkey` (proving key) | **18,096,375 B (~17.3 MB)**, verified `ZKey Ok!` |
| `verification_key.json` | **4,761 B**, 12 IC points |

## Witness + proof (headless)

Witness inputs are built by a standalone, crates.io-only Rust generator
(`scratchpad/zk/wgen`) that re-uses the reference's *pure* modules (Poseidon2 via
vendored `zkhash`, Merkle, SMT/`smt.js` port, keypair, transaction) — **no `ark-circom`,
no git deps**. It emits a circom/snarkjs `input.json` for a real spend: one dummy input
+ one real note (amount 13) at pool leaf 7, its ASP-allowlist membership leaf
`H(pubKey, 0, dom=1)`, and its blocklist SMT non-membership proof.

- Witness: circom `generate_witness.js` → `snarkjs wtns check` → **WITNESS IS CORRECT**.
- Prove: `snarkjs groth16 prove` → `proof.json` + `public.json`.
- **Local verify: `snarkjs groth16 verify` → `OK!`**

## On-chain verification (testnet, Protocol 27)

Verifier = reference Nethermind `circom-groth16-verifier` (BN254 `g1_mul`/`g1_add` +
4-term `pairing_check`), VK embedded at build time from `verification_key.json`. Built
in a minimal crates.io+path workspace (`scratchpad/verifier-build`: verifier +
`contract-types` + `circuit-keys`) — **no `ark-circom`, no reference workspace**. A
CLI-friendly `verify_bytes(proof: Bytes, public_inputs: Bytes)` entrypoint was added
(proof 256 B = A‖B‖C with B in c1‖c0; publics = 11×32 B big-endian) alongside the
original `verify`. snarkjs→Soroban conversion reused from Phase 0.

- **WASM hash:** `253c5b37a72206990c281aacf72c891ebd6f4a2727c118ba2ac7d124c8dcbacd`
  (11,309 B optimized / 15,604 B unopt)
- **Contract ID (testnet):** `CCFRFYK4QEHQCCSQQ3W3HBD2NOOM67JDTC2Z2PJSDVCBPTZVR53D3PHE`
- **Passing run (valid proof → TRUE):** `verify_bytes(...)` → `true`
  on-chain tx `88fbe268a99a896a2b917a73689fd6330be8c993df20da261c886c2f160a0213`
- **Rejection on tamper:**
  - flip a byte of point C → `HostError: Error(Crypto, InvalidInput)` —
    "escalating error to VM trap from failed host function call:
    `bn254_multi_pairing_check`" / "bn254 G1: point not on curve".
  - flip a byte of a **public input** (proof structurally valid) →
    `Error(Contract, #0)` = `Groth16Error::InvalidProof` (pairing product ≠ 1).
    This confirms the verifier binds the public inputs, not just the proof points.

## Cost (the real circuit's verify)

From RPC `simulateTransaction` (SorobanTransactionData resources) + on-chain charge:

| Metric | Value |
|---|---|
| **CPU instructions** | **40,019,012** (~40% of the 100,000,000 per-tx budget) |
| disk read / write bytes | 0 / 0 (pure, no storage) |
| resource fee (proposed) | 43,099 stroops |
| **fee charged (on-chain)** | **33,513 stroops (~0.00335 XLM)** |

Baseline comparison: Phase 0's trivial circuit (1 public input) = **27,218,117** CPU.
This real circuit (11 public inputs) = **40,019,012** CPU → **+12.8M for 10 extra
public inputs ≈ 1.28M CPU per input** (one `g1_mul`+`g1_add` each — cheap vs. the
pairing). **Comfortably under the 100M budget.**

## Clean-funds constraint is load-bearing ✅ (critical check)

A note that is **NOT** in the ASP allowlist tree cannot produce a valid proof. With an
otherwise-identical witness whose ASP tree does *not* contain the note's membership
leaf, circom witness generation **fails**:

```
Error: Assert Failed. Error in template PolicyTransaction_227 line: 144
```

`policyTransaction.circom:144` = `membershipVerifiers[tx][i].root === membershipRoots[tx][i]`
— the ASP-membership equality. No witness ⇒ no proof ⇒ nothing to submit on-chain.
The clean-funds gate is enforced inside the circuit, not bolted on. (The same wgen,
in `valid` mode, produces a satisfying witness and a verifying proof — control case.)

## circom → arkworks bridge (STEP 4)

**Prover decision (FINAL): snarkjs. The arkworks/`ark-circom` prover is ABANDONED.**

The on-chain-verified proof above was produced via **circom witness →
`snarkjs groth16 prove`** (the path `/web` Phase 4 ships).

**No public-input-ordering or serialization adjustment was needed:** snarkjs
`public.json` order matches the circuit's declaration order and the VK's IC ordering
1:1, and the snarkjs→Soroban encoders (G1 x‖y, G2 c1‖c0, 32 B BE, plain integers) from
Phase 0/0b worked unchanged.

Why arkworks was dropped (not just deferred):
- snarkjs already yields on-chain-verified proofs for `policy_tx_2_2` — the goal is met.
- The arkworks **serialization** was already proven sound in Phase 0b, and snarkjs
  reuses the **same** Soroban encoders, so the bridge had zero remaining payoff.
- `ark-circom` is git-only (Nethermind fork) and pulls a pinned `wasmer` that does a
  full multi-hundred-MB git clone — pure cost, no benefit. The probe was terminated and
  all `ark-circom`/`wasmer` git deps removed from the workspace so no future build
  re-triggers the clone. (Removed: `scratchpad/arkbridge`; pruned the partial `wasmer`
  checkout from the cargo cache.)

**snarkjs gotcha carried into Phase 4 (recorded in `web/lib/prover.ts`):** do **not**
use `snarkjs groth16 fullProve` for this circuit — it mis-parses the **bus** inputs
(`membershipProofs`/`nonMembershipProofs`) and throws "Not enough values for input
signal membershipProofs". Witness generation and proving are **two separate steps**:
circom's `generate_witness.js` (witness calculator — accepts bus inputs) → then
`snarkjs groth16 prove(zkey, wtns)`.

## Artifacts

- Circuits: `circuits/src/**` (committed) · build outputs `circuits/build/` (gitignored)
- Scripts: `circuits/scripts/{compile.sh,setup.sh,ptau.sh,groth16_setup.sh,snarkjs_to_soroban.py}`
- VK + sample proof: `deployments/testnet/policy_tx_2_2_vk.json`, `sample_proof.json`, `sample_public.json`
- Witness generator: `scratchpad/zk/wgen` · verifier build: `scratchpad/verifier-build`
