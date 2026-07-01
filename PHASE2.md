# Phase 2 — Pool + ASP contracts + spend entrypoint (PASSED)

**Goal:** build the on-chain state the Phase-1 verifier checks against — a
commitment pool, a nullifier set, an ASP allowlist — and a `spend()` entrypoint
that ties them together. Fixed denominations {1,5,10,50}, no change notes.

**Result:** a real, headless deposit → allowlist → spend works end-to-end on
testnet against a real Groth16 proof, and every adversarial path is rejected —
including the critical one: **a valid proof against a prover-controlled ASP root
is rejected because the contract, not the prover, is the source of truth.**

## Contracts (testnet, Protocol 27)

| Contract | ID |
|---|---|
| **pool** | `CAUFAAX4VRCFFPY5H3GFDQTG2IE5NMCBUYLMCSNWE4O5XLXRFXY54NX4` |
| **asp** | `CCF3LS2MQJBAIQO2OVXSUZSP7HBB57SRXIWVO5FYVVRPYCBHFXK5ZRTC` |
| **verifier** | `CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T` |

All built in the crates.io-only `/contracts` workspace (no git deps). Poseidon2
on-chain via `soroban-sdk` 26's `poseidon2_permutation` host function (feature
`hazmat-crypto`), wrapped in a trimmed `soroban-utils` ported from the reference.

### pool ([contracts/pool](contracts/pool/src/lib.rs))
- Poseidon2 commitment Merkle tree (depth **10**, MUST match the circuit) with a
  **64-root history ring** so a proof against a slightly stale root still verifies.
  Empty leaves use the Poseidon2("XLM") `get_zeroes` convention.
- `deposit(amount, commitment)` — denomination-checked, single-leaf insert, emits
  `DepositEvent{amount, commitment, index, root}`. ⚠️ **MOCK:** the USDC
  transfer-in is not performed (Phase 5/6).
- Spent-nullifier set (`Map<U256,bool>`).
- `spend(...)` — the integration point (below).

### asp ([contracts/asp](contracts/asp/src/lib.rs))
- Poseidon2 **allowlist** tree (depth 10) of clean-funds leaves
  `H(pubKey, blinding, dom=1)`. `admin_add` / `admin_remove` (admin-gated
  STAND-IN for the ASP service), `get_root()`. Root recomputed from a stored leaf
  vector so removal works.
- **blocklist** non-membership root: admin-set `set_blocklist_root` /
  `get_blocklist_root`. ⚠️ STAND-IN — see §3b.

## §3b — where does the blocklist root live?

The circuit enforces SMT **non-membership** against `nonMembershipRoots`, which is
a **public input the prover supplies**. For the same reason the ASP allowlist root
must be contract-owned, the blocklist root is too: the ASP contract holds the
canonical value and `spend()` rejects any proof whose `nonMembership` root differs.
A full on-chain SMT is out of scope for the demo, so the value is **admin-set**
(flagged). The prover builds its non-membership proof against this fixed root.

## spend() — the integration point ([pool/src/lib.rs](contracts/pool/src/lib.rs))

Checks, in order — rejecting on the first failure:
1. **pool root** is in the recent-root history (`UnknownRoot` else).
2. **nullifiers** unspent (`AlreadySpent` else).
3. **merchant+payout binding:** `extDataHash == Poseidon2(merchant, payout, dom=5)`
   and `publicAmount == field − payout`. Binds the payee to the proof — the
   contract trusts only the verified public inputs, never the caller's claim.
4. **ASP allowlist root** (public input) `==` live `asp.get_root()`
   — **`AspRootMismatch` else. CRITICAL.**
5. **blocklist root** (public input) `==` live `asp.get_blocklist_root()`.
6. **verify** the proof: builds the 11 public inputs in circuit-declared order and
   cross-calls `verifier.verify_bytes`.
7. only if all pass: record nullifiers, emit `SpendEvent{merchant, payout,
   nullifier}`. ⚠️ MOCK payout transfer.

Public-input order matches Phase 1 exactly: `root, publicAmount, extDataHash,
inputNullifier[2], outputCommitment[2], membershipRoots[2], nonMembershipRoots[2]`
(the two roots replicated once per circuit input).

## Empty-leaf reconciliation (the integration risk)

Phase 1's witness builder used empty-leaf = 0; the contracts use Poseidon2("XLM").
The circuit is agnostic (it only checks leaf→root via the supplied path), so the
**same VK/verifier still works** — but the witness builder MUST match the contract.
The Phase-2 builder switches to the XLM zero-leaf and asserts it equals the
contract's `get_zeroes[0]` at build time. Confirmed live: after 3 deposits the
on-chain `pool.get_root()` and after 2 allowlist adds the on-chain
`asp.get_root()` both **matched the off-chain builder bit-for-bit** — proof that
the on-chain and off-chain Poseidon2 parameterizations agree.

## E2E results (headless, real snarkjs proof)

| Step | Outcome |
|---|---|
| Deposit 3 notes (1, 5, 10) | indices 0,1,2; **pool root MATCH** ✓ |
| Allowlist 2 leaves + set blocklist root | **asp root MATCH** ✓ |
| **Valid spend** (note B → merchant, payout 5) | **SUCCESS** — `SpendEvent{merchant=0xC0FFEE, payout=5}` · tx `22496a8e5a80adc9d47a1008bec61691487687f3691437c606aa4f2d4a51734d` |
| **Double-spend** (same nullifier) | rejected `Error(Contract,#6)` AlreadySpent |
| **ASP-root mismatch** (valid proof vs prover-controlled fake root) | rejected `Error(Contract,#7)` AspRootMismatch — the contract's live root ≠ the proof's |
| **Non-allowlisted note** | cannot produce a witness (circom fails at `policyTransaction:144`) → no proof exists to submit |

Reproducible via [scripts/e2e_phase2.sh](scripts/e2e_phase2.sh).

## Cost of a full spend() (verify + root checks + cross-calls + nullifier write)

| Metric | Value |
|---|---|
| **CPU instructions** | **46,796,527** (~47% of the 100,000,000 budget) |
| disk read / write bytes | 0 / 188 (nullifier persisted) |
| resource fee (proposed) | 111,821 stroops |
| **fee charged** | **94,641 stroops (~0.0095 XLM)** |

Versus the bare Phase-1 verify (40,019,012 CPU): the pool orchestration —
recent-root check, Poseidon2 ext-data binding, two ASP cross-contract calls, and
the nullifier map write — adds **~6.8M CPU**. Comfortably under budget.

## Post-Phase-2 fix — dummy-nullifier collision (correctness bug)

**Bug:** `spend()` recorded *both* revealed nullifiers, including slot 0 — the
fixed canonical "dummy" of the 2-in shape. Since that nullifier is identical on
every spend, the **2nd distinct spend** would falsely fail `AlreadySpent`. Phase 2's
single spend never surfaced it.

**Cause (diagnosed, not a soundness property):** the dummy is amount-0 and
structurally inert — the circuit gates its pool-membership off (`enabled <==
inAmount = 0`), the amount invariant `sumIns + publicAmount === sumOuts` forces all
value onto a *real* input (whose nullifier differs), and `sameNullifiers` blocks
reusing it twice within one tx. Recording it enforces nothing.

**Fix (preferred path):** the canonical dummy nullifier is wired into the pool
`__constructor` and `spend()` **skips it** — no spent-check, no record. Only real
nullifiers enter the set. Sound because forging a value-bearing note with that exact
nullifier needs a Poseidon2 collision (infeasible), and the dummy carries no value.

**Proof (fresh deploy: pool `CCSCRBKHE257NK4MWSSKELRUV4ACPIFHLCAIB6OLBVMPQOQ3HGIAIESB`,
asp `CBR723UTZB2YBIV3HGSITKD4QZII3WCJ5U7QRXR7HYDKSNIJSZRIG772`):** two **distinct**
spends that share the canonical dummy (slot 0) but differ in their real nullifier
(slot 1) BOTH succeed —
- spend note B (payout 5) → tx `9ef66013d7f0def5a7c5b85312f5dd0a1ca3a21413415887c6e66ab657e193a2`
- spend note C (payout 10) → tx `68befa391ed25e762a847e71192f81e1d8e5a08302bc0dffff661285e988f90c`

…and a genuine **re-spend of note B** is still rejected `Error(Contract, #6)`
AlreadySpent. The dummy no longer blocks distinct spends; real replay stays blocked.

## Flagged stand-ins (demo, not production)

- **Token transfers mocked** — deposit-in and merchant payout are not real USDC
  movements yet (Phase 5/6).
- **ASP admin is a single key** standing in for the real ASP service.
- **Blocklist root is admin-set**, not a live on-chain SMT.
- **Trusted setup is dev-only** (carried from Phase 1).
- **Fixed denominations, no change notes** — full-withdrawal spends only.
