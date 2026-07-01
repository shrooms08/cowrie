# Phase 0 — Kill Switch (PASSED)

**Goal:** prove ONE Groth16 proof verifies on a Soroban verifier contract deployed to
Stellar **testnet (Protocol 27)** via the native BN254 host functions. Nothing else.

**Result: the BN254 ZK host functions work on testnet.** A valid proof returns `true`
on-chain; a tampered proof is rejected by the host function. Cowrie's core premise is viable.

## What was run

| Step | Detail |
|---|---|
| Circuit | Trivial multiplier `c <== a*b` (1 constraint, 1 public output) — a stand-in to produce one valid Groth16/BN254 proof. |
| Trusted setup | **DEV-ONLY** Powers-of-Tau + Groth16 phase-2 via snarkjs, throwaway entropy. Not reusable for production. |
| Prover | **snarkjs** `groth16.prove` (deliberate divergence — see note below), proof converted to Soroban byte layout (A 64B, B 128B `c1‖c0`, C 64B). Locally verified `OK!` first. |
| Verifier contract | Nethermind `circom-groth16-verifier` **unchanged**, built standalone with our dev VK embedded via `build.rs`. soroban-sdk 26, target `wasm32v1-none`. |
| Build | 4557-byte wasm. Hash `b7cea8882c67c8aaf0f45e08d460b2666561b4e3c5f3a787de1060c94b35d0c6`. Exported fn: `verify`. |

## Deliverables (the four required facts)

- **Contract ID (testnet):** `CAXX5JWWLSIIQXWGA6OE765C46KCWGU72FFXU3WYBQOACDRFNB2VZW2H`
- **Passing run (valid proof → TRUE):** `verify(proof, ["33"])` → `true`.
  On-chain tx: `340d8aa12bb549a8fe818cbed25891c194cdd255b4290c42cf8f45ba0a28b2e9`
- **Failing run (tampered proof → rejected):** flipped one byte of point A →
  `HostError: Error(Crypto, InvalidInput)` — "escalating error to VM trap from failed
  host function call: `bn254_multi_pairing_check`" / "bn254 G1: point not on curve".
- **Verification resource cost (1 public input):**
  - **CPU instructions: 27,218,117** (~27% of the 100,000,000 per-tx budget — comfortable headroom)
  - disk read bytes: 0 · write bytes: 0 (pure, no storage)
  - read footprint: contract instance + 4557-byte code
  - resource fee: 33,039 stroops proposed / 23,353 charged · **total fee charged ≈ 23,453 stroops (~0.00234 XLM)**

## Notes / deviations (flagged)

1. **snarkjs, not the reference arkworks prover.** The kill switch's job is to validate the
   on-chain BN254 host functions, and the *verifier contract* (the thing that exercises them)
   was used unchanged. Using snarkjs additionally validated the **snarkjs→Soroban proof
   conversion** that our `/web` Phase 4 depends on — more valuable to Cowrie than exercising a
   prover we won't ship. If you specifically want the arkworks path validated, that's a quick
   follow-up.
2. **Build gotcha (documented for later):** building any package inside the reference cargo
   workspace hangs `cargo metadata` because the workspace pulls git deps (`wasmer`, `ark-circom`,
   iden3 `circom`). We built the verifier in a **minimal standalone workspace** (verifier + types +
   circuit-keys, crates.io-only). Cowrie's `/contracts` workspace already avoids those git deps.
3. **Headroom signal:** ~27.2M CPU for a 1-public-input verify. The real `policyTransaction`
   adds one `g1_mul`+`g1_add` per extra public input (cheap vs. the pairing), so on-chain verify
   should stay well under the 100M budget. To be confirmed in Phase 2 with the real circuit.

Artifacts: `scratchpad/killswitch/` (circuit, keys, proof) and `scratchpad/verifier-build/`
(standalone contract build).

---

# Phase 0b — Arkworks prover validation (PASSED)

**Goal:** prove a Groth16 proof from the **arkworks** prover (no snarkjs in the proving
step) verifies TRUE on a Soroban BN254 verifier on testnet — de-risking the Phase 4
in-browser arkworks prover.

**Plan used: B** (fully arkworks-native). Plan A was blocked: `ark-circom` is **not on
crates.io** (git-only Nethermind fork, drags in `wasmer` + arkworks-version skew vs our
0.6) — so it can't cleanly import the `.zkey` under the crates.io-only constraint. Plan B
is the sanctioned fallback.

**What ran:** `arkprove` (host bin in the standalone workspace) defines `a*b=c` via
`ark-relations::gr1cs`, runs `ark_groth16::Groth16::<Bn254>::setup` + `prove` (StdRng),
verifies locally (`true`), writes the VK as snarkjs-json (`circuit_keys::write_vk_snarkjs_json`)
and the proof bytes via `circuit_keys::{g1,g2}_to_soroban_bytes`. A 2nd verifier was built
with that arkworks VK embedded and deployed.

**Result:**
- **Verifier (arkworks VK):** `CD6IMJVPVDPULMFVGNPGJHZEAPGYBCTUVDHUNGGFBSCTWLPFSUCNMGXT` (wasm hash `c4b594f8…`)
- **Passing run (arkworks proof → TRUE):** `verify(arkworks_proof, ["33"])` → `true`
  on-chain tx `583978bf154a8e165ff3fc9129f8b5ea8c164851dd6b1bd2002ff88c89173991`

**Arkworks → Soroban serialization that worked (reuse in Phase 4):**
- **G1 (A, C):** 64 bytes = `x(32 BE) ‖ y(32 BE)`. Affine, uncompressed, no flag byte.
- **G2 (B):** 128 bytes = `x.c1(32 BE) ‖ x.c0(32 BE) ‖ y.c1(32 BE) ‖ y.c0(32 BE)` —
  **imaginary (c1) first, then real (c0)**.
- **Public input (Bn254Fr):** 32-byte big-endian; passed to the CLI as a `u256` **decimal**
  string (`"33"`).
- **Point A passed as-is** — the contract computes `-A` internally; no client-side negation.
- Coordinates are plain integers (`into_bigint().to_bytes_be()`), **not** Montgomery.
- Do **NOT** use arkworks' native `CanonicalSerialize` (`proof.serialize_*`): it is
  little-endian with different Fp2 ordering + flag bits. Use the explicit big-endian
  `x/y`, `c1/c0` layout above — i.e. `circuit_keys::{g1,g2}_to_soroban_bytes`.
- **No snarkjs↔arkworks gap appeared** (no c0/c1 flip, no endianness retry) because both
  the proof and the VK came from the same arkworks source through these encoders.
