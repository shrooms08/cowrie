<p align="center">
  <img src="web/public/logo/cowrie-lockup.svg" alt="Cowrie" width="248" height="72">
</p>

# Cowrie

**Spend stablecoin USD like cash** — your balance and identity stay private
on-chain, the merchant gets local currency and a cryptographic proof that the
funds are clean.

Cowrie is a private USDC wallet + merchant checkout on **Stellar**. A buyer holds
USDC as private notes; to pay, they generate a zero-knowledge proof — in the
browser — that they own a note, that the note is on an approved "clean funds"
allowlist, and that it hasn't been spent, all **bound to a specific merchant and
amount**. The pool contract verifies the proof on-chain via Stellar's native
BN254 host functions and emits a `SpendEvent`. The merchant's register flips to
"Paid. Verified clean." on that event — learning only *paid + clean + amount*,
never the wallet, balance, or buyer. A mock anchor then settles local currency.

> **Status: working demo on Stellar testnet (Protocol 27).** Real ZK proofs, real
> on-chain verification, real event-driven settlement. Some surrounding pieces are
> mocked — see the [Honesty ledger](#honesty-ledger). Nothing about the privacy or
> the proof is faked.

---

## How zero-knowledge is load-bearing

The spend is the whole product, and it is a single Groth16 proof
(`circuits/src/policy_tx_2_2.circom`, 11 public inputs) that simultaneously proves:

1. **Ownership** of an unspent note that is a leaf in the pool commitment tree
   (Poseidon2 Merkle membership) — without revealing which leaf.
2. **Clean funds** — that same note's owner is a member of the ASP allowlist tree
   — without revealing identity.
3. **A revealed nullifier** so the note can be burned (double-spend prevention).
4. **Binding** to the public `merchant id` + `amount` (via `extDataHash` /
   `publicAmount`), so a proof can't be replayed against a different payee.

Why this is not theatre:

- **A dirty note literally cannot pay.** If a note's owner is *not* on the ASP
  allowlist, witness generation fails at `policyTransaction.circom:144`
  (`membershipVerifiers.root === membershipRoots`). No witness ⇒ no proof ⇒
  nothing to submit. The clean-funds gate is a circuit constraint, not a UI check.
- **The contract is the source of truth for "clean."** `pool.spend` rejects any
  proof whose ASP root doesn't equal the live `asp.get_root()`
  (`AspRootMismatch`, error #7). A user can't prove membership in a fake allowlist
  they control — verified on testnet: a valid proof against a prover-controlled
  ASP root is rejected on-chain.
- **The merchant trusts only the verified event.** The register flips on the
  on-chain `SpendEvent`, which the pool emits *only after* the pairing check
  passes. The mock anchor independently re-verifies the spend tx before settling.

**Proof it runs (testnet, Protocol 27):**

| | |
|---|---|
| pool | `CDSQE32Q7W27FTK4CBGBDTHKKKVFL4BZH5OPNMVLKSMXOOTJ4J6LPM6B` |
| asp | `CC3VMBFWUNSAAFM6OM6TUAJCSMXKMFKJB2W2TB6WPZH6FG6PRSJGHHXJ` |
| verifier (BN254 Groth16) | `CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T` |
| receipt verifier (selective disclosure) | `CA6BDTDPO6ARRTHVFQ6LTJLP255JZDEPAPISXDAM5P7PF7FYBXRAGCXI` |
| a real private spend tx | [`fbd9c3596b9a587dc42127d76fbd95e7de11e9ee7bd8bc6448887ecce20b22d2`](https://stellar.expert/explorer/testnet/tx/fbd9c3596b9a587dc42127d76fbd95e7de11e9ee7bd8bc6448887ecce20b22d2) |
| a real proof-of-payment receipt verify tx | [`d73ae2b93200f2099712e8bc532a2d599eb59992a0c0b687afd429ed8ef76f05`](https://stellar.expert/explorer/testnet/tx/d73ae2b93200f2099712e8bc532a2d599eb59992a0c0b687afd429ed8ef76f05) |

Cost: the full `spend()` (verify + root checks + nullifier write) is **~46.8M CPU
instructions**, ~47% of the 100M per-tx budget; the bare verify is ~40M.

---

## Architecture

```
  BUYER WALLET (/)                                         MERCHANT REGISTER (/merchant)
  ─────────────────                                        ────────────────────────────
  seedless key + notes (localStorage)                      create NGN invoice
        │                                                        │  quote (SEP-38)
        │  pick note + merchant + amount                         ▼
        ▼                                               ┌─ mock anchor /api/anchor/quote
  WASM witness builder ──► input.json                   │
  (Rust→WASM: Poseidon2/Merkle/SMT,                     │   waits for the on-chain event
   one source of truth with the circuit)                │            ▲
        │                                               │            │ SpendEvent(merchant, amount)
        ▼   two-step (NOT fullProve)                    │            │
  circom witness_calculator ──► snarkjs.groth16.prove   │            │
        │                                               │            │
        ▼  proof → Soroban bytes (A‖B‖C)                │            │
  pool.spend(proof, public_inputs, merchant, amount) ───┼──► VERIFIER (BN254 pairing_check)
        │  checks: pool root ∈ history,                 │            │  e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ)==1
        │  ASP root == live, nullifier unspent          │            ▼
        ▼                                               │      "Paid. Verified clean."
  records nullifier ──► emits SpendEvent ───────────────┘            │  settle (SEP-31)
                                                                     ▼
                                                          mock anchor delivers ₦ at the quoted rate
                                                          privacy panel: real tx reveals nothing identifying
```

The witness builder runs **in the browser** (compiled from the exact Rust the
circuit/contracts use, so there's one Poseidon2), and proving is two separate
steps — `witness_calculator` then `groth16.prove` — because `snarkjs.fullProve`
mis-parses this circuit's bus inputs.

---

## Honesty ledger

| | |
|---|---|
| **Real** | The ZK circuit + Groth16 proofs; in-browser witness + proving; **on-chain verification via Stellar BN254 host functions**; the `pool` / `asp` / `verifier` Soroban contracts and their state (commitment tree, nullifier set, ASP allowlist root); the spend being **rejected on-chain** for a non-allowlisted note or a mismatched ASP root; **real on-chain USDC** — deposit **pulls** USDC from your wallet into the pool (auth rooted at `deposit` via `from.require_auth()`) and a spend **sends** USDC from the pool to the merchant for the payout, while change stays a private note (via the USDC Stellar Asset Contract `CBIELTK6…`); **arbitrary-amount payments** with automatic coin selection + private **change notes**; wallet **onboarding to the USDC rail** (friendbot XLM → USDC trustline → DEX path-payment for a starting balance); **event-driven** merchant settlement; the anchor independently re-verifying the spend; wallet persistence across reload. |
| **Forked (credit)** | The cryptographic core is forked from **Nethermind's [stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments)** — the Circom `policyTransaction` circuit family (Poseidon2, SMT, keypair) and the `circom-groth16-verifier` contract lineage. Cowrie ports/instantiates these and builds the wallet, register, anchor, and clean-funds UX on top. See [STUDY.md](./STUDY.md). |
| **Mocked** | The **fiat anchor rails** (no real fiat; a fixed, *exposed* mock SEP-38 quote — **₦1,400 / $1** — stands in for SEP-38/31/24; invoices are typed in USDC and the ₦ figure is a derived estimate). The **ASP admin** (a server route holds the admin key and vouches identities — stands in for the attestation service). The **blocklist root** is admin-set, not a live SMT. **Names are a local claim** — a buyer's `<name>.cowrie` handle and a merchant's business name are claimed and stored locally (single-device), with no uniqueness guarantee. **Dev-only trusted setup** (single-contributor, throwaway entropy). "**Seedless**" = a local Stellar key auto-provisioned + friendbot-funded (production would use passkey/social login). |
| **Production needs** | A proper **pool indexer** — the demo reconstructs the *pool* commitment tree from recent RPC events + local overlay, and public RPC retains only ~recent ledgers, so a long-lived pool eventually can't be rebuilt from events alone (the *ASP* tree is resolved from the vouch service's authoritative allowlist, so it's already immune to this). A **real Stellar anchor** via SEP-24/31/38. **Passkey / social login** instead of a local key. An **on-chain name registry** for globally-unique `<name>.cowrie` handles + merchant names (the demo claims them locally). Real **fiat on-/off-ramp** for USDC (the rail itself is now live). An **audited multi-party trusted-setup ceremony**. A live on-chain **blocklist SMT**. |

Every mock is also flagged in-app (the wallet's footer, the register's anchor panel).

---

## Run it (from a clean clone)

Prereqs: **Node ≥ 20**. The contracts are already deployed to testnet (IDs above);
the circuit + witness artifacts are committed under `web/public/circuits` and
`web/lib/cowrie_wasm`, so the demo runs without any Rust/circom toolchain.

```bash
cd web
npm install

# server-only ASP admin key (stands in for the attestation service).
# Use the testnet identity that owns the asp contract; export its secret:
cat > .env.local <<EOF
ASP_ADMIN_SECRET=<S...secret of the asp admin>
ASP_DUMMY_LEAF=19187717433344121899528298946775778525835347177217043402537944412944308483581
EOF

npm run dev      # http://localhost:3000
```

- **Buyer wallet:** http://localhost:3000 — Receive (deposit a note) then Pay.
- **Merchant register:** http://localhost:3000/merchant — create a charge, then
  pay it from the wallet and watch it flip on the real event.
- **Mock anchor:** http://localhost:3000/mock-anchor — endpoints + SEP mapping.
- **Reset demo:** the wallet footer has a "reset demo" button (fresh seedless key).

Headless proofs of each loop (against testnet): `node web/scripts/ui-e2e.mjs`
(two distinct spends), `node web/scripts/merchant-e2e.mjs` (full merchant loop),
`node web/scripts/persistence-test.mjs` (reload persistence).

### Rebuilding the crypto (optional)

To recompile from source you need Rust 1.94 + `wasm32v1-none`, circom 2.2,
snarkjs, stellar CLI, and `wasm-pack`. See the phase writeups:
[PHASE1](./PHASE1.md) (circuits + setup), [PHASE2](./PHASE2.md) (contracts),
[PHASE3](./PHASE3.md) (wallet), [PHASE4](./PHASE4.md) (merchant + anchor).

---

## Credits

- **Stellar Development Foundation** — the native **BN254** pairing host functions
  and **Poseidon2** (`crypto_hazmat`), live since Protocol 25 and efficient in 26,
  which make on-chain Groth16 verification practical.
- **Nethermind** — [stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments),
  the privacy-pool circuits + BN254 verifier Cowrie's crypto core is forked from.
- arkworks, iden3 circom/circomlib, snarkjs, Horizen Labs zkhash (Poseidon2).

Cowrie is a hackathon demo, not audited, not for production funds.
