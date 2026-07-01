# Cowrie wallet (Phase 3) — buyer-side mobile wallet, wired to real testnet contracts

A seedless private-stablecoin wallet. Balances, deposits, and spends are **real
contract calls and real ZK proofs** — no mock data. Reskinned to the Cowrie
design mock (dark, green-on-black, iOS frame).

## What's real

- **Seedless wallet.** On first load a Stellar keypair + a BN254 identity scalar
  are generated in-browser and persisted to `localStorage`. The Stellar key is
  friendbot-funded automatically. **No seed phrase is ever shown.**
  _Production note: real Cowrie uses passkey / social login; the demo
  auto-provisions a local key._
- **Note/balance model.** Notes (denomination + blinding + leaf index) live in
  `localStorage`. The displayed balance is their local sum. **The chain never
  sees a balance.** The eye toggle hides only the **local** display — on-chain
  the balance is always hidden.
- **Deposit** (`Receive`) calls `pool.deposit(amount, commitment)` with a chosen
  denomination {1,5,10,50}; the new note is stored with its on-chain leaf index.
- **Spend** (`Pay`) builds the witness, generates a **real Groth16 proof in the
  browser**, and calls `pool.spend(...)`. The "Proving funds & clean" screen
  wraps the **actual** proving — not a timer — and blocks until on-chain verify
  returns.
- **In-browser proving = two SEPARATE steps** (never `snarkjs.fullProve`, which
  mis-parses this circuit's bus inputs): circom `witness_calculator` →
  `snarkjs.groth16.prove`. The witness field values (Poseidon2 / Merkle / SMT)
  come from a **WASM module compiled from the exact Rust used by the circuit and
  contracts** (`wasm-witness/`) — one Poseidon2 source of truth, no JS reimpl.
- **Resilience.** Deposits and spends **never blind-resubmit**. On RPC flakiness
  (`txNoAccount`, `txBadSeq`, dropped responses) the client re-reads on-chain
  state — pool root after a deposit, nullifier presence after a spend — to learn
  whether the op already landed before retrying. Tree leaves are reconstructed
  from contract events and re-resolved until the built root is one the contract
  accepts (handles event-indexing lag). Testnet RPC IS flaky; this is assumed.

## What's mocked (flagged in-app too)

- **USDC transfer-in & merchant payout** — no real token moves yet (Phase 5/6).
- **ASP admin** — a server route (`app/api/asp-vouch`) holds the ASP admin key
  and adds a wallet's identity leaf to the allowlist. Stands in for the real
  Association-Set Provider attestation service. Only the leaf (a hash) is sent.
- **Blocklist root** is admin-set, not a live on-chain SMT.
- **Fixed denominations {1,5,10,50}, no change notes** — spends are full
  withdrawals of a single note.
- **Dev-only trusted setup** (carried from Phase 1).

## Run

```bash
npm install
# server-only ASP admin key (the killswitch identity used in Phases 0–2):
echo "ASP_ADMIN_SECRET=<S...secret>" >> .env.local
echo "ASP_DUMMY_LEAF=19187717433344121899528298946775778525835347177217043402537944412944308483581" >> .env.local
npm run dev   # http://localhost:3000
```

Contracts (testnet, Protocol 27): see `../deployments/testnet/phase3.json`.
To rebuild the witness WASM after editing `wasm-witness/src/lib.rs`:
`cd wasm-witness && wasm-pack build --target web --out-dir pkg && cp pkg/* ../lib/cowrie_wasm/ && cp pkg/cowrie_wasm_bg.wasm ../public/circuits/`.

## Headless proof of the flow

`node scripts/ui-e2e.mjs` exercises the **same** wasm builder + two-step prover +
contract calls (with the same resilience) the UI uses, against the deployed
contracts. A passing run: seedless wallet → ASP vouch → 2 deposits → **two
distinct spends both succeed** → a non-allowlisted note fails at the clean-funds
assert. Tx hashes are in `phase3.json`.
