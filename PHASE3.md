# Phase 3 — Wallet UI wired to real testnet contracts (PASSED ✅)

The buyer-side mobile wallet (`/web`, Next.js 15 App Router), reskinned to the
Cowrie design mock and wired to the real Phase-2 contracts. **No mock data** —
balances, deposits, and spends are real contract calls and real in-browser ZK
proofs. Full details + run instructions: [web/README.md](web/README.md).

## Contracts (testnet, Protocol 27)

| | |
|---|---|
| pool | `CDW7FIK7WXBQNCPHNGJIRHA7R6MJ6X44MQVLAUCVBS3IFYB7KB2QRUPB` |
| asp | `CDFHS2COEUGSHVBMNA5TZALVTM42P6FWS66GLX63DRSRSM3JHUQLQR3C` |
| verifier | `CCKJHEGDDCBYYZFNK5W2Q7G2FAR7ASMQGYOOTXZOMSAEI6O37WEVK65T` (reused) |

(A fresh pool+asp so the demo wallet is a depositor from leaf 0; source of truth
`deployments/testnet/phase3.json`.)

## Keystone: real in-browser proving

The risk was the witness builder — the circuit's Poseidon2/Merkle/SMT must match
the contracts exactly. Rather than reimplement Poseidon2 in JS, the **proven Rust
witness builder is compiled to WASM** (`web/wasm-witness/`, reusing the Phase-1/2
zkhash logic) and called from the browser. Verified against Phase-2 constants
(dummy nullifier, blocklist root, note commitment, ASP leaf — all match). Proving
is the **two-step** path (circom `witness_calculator` → `snarkjs.groth16.prove`),
never `fullProve`. The "Proving funds & clean" screen wraps this real work and
blocks until on-chain verify returns.

## Headless e2e (same code paths the UI uses, against testnet)

Run: `cd web && node scripts/ui-e2e.mjs`. Passing run:

| Step | Result |
|---|---|
| Fresh seedless wallet | friendbot-funded local Stellar key + BN254 identity |
| ASP vouch | identity leaf added to allowlist (mock ASP admin route) |
| Deposit $5, $10 | leaves #17 (`f3a6ee4614`), #18 (`e11dc45eef`) |
| **Spend $5** | **SUCCESS** `41f2f4a13985db079aa6af3092052d9a8432a0daa5d3e654ecb95dbd92dc0f00` |
| **Spend $10** | **SUCCESS** `debdb505f69d3683c2661c6163f1d2d73edb35983de50220e98725d2c11578b1` |
| **Two distinct spends** | **BOTH SUCCEEDED** — the dummy fix holds through the UI flow |
| Non-allowlisted note | witness generation fails at the clean-funds assert (graceful) |

The 2nd spend hit a `txBadSeq` on submit; the **confirm-before-retry** logic
re-checked nullifier presence and retried without blind-resubmitting — it landed.

## Resilience (required, implemented)

Deposits/spends never blind-resubmit. On flakiness (`txNoAccount`, `txBadSeq`,
dropped responses) the client re-reads chain state — pool root after a deposit,
`is_spent(nullifier)` after a spend — to learn if the op landed before retrying.
Tree leaves are reconstructed from contract events and **re-resolved until the
built root is one the contract accepts** (`is_known_root` for the pool; exact
match for the ASP), overlaying the wallet's own leaves to beat event-indexing
lag. This pattern (inherited + extended from Phase 2) is in `web/lib/contracts.ts`.

## Fidelity to the mock

Home screen reproduced faithfully (`scratchpad/mock/ui_home.png` vs the mock):
dark #060807 / accent #B7F24A, iOS frame + status bar, bean avatar + scan button,
`BALANCE` + eye toggle, big `$x.00` (dimmed cents), `… USDC` + `PRIVATE` pill,
`Receive` (dark) / `Send` (green), the `name.cowrie` ID card (green dot, settles
in ₦·€·$, $0.00 fee), `RECENT ACTIVITY`, and the HOME/PAY/MERCHANT/PRIVACY tabs.
Fresh seedless load correctly shows `$0.00` + empty activity. The Pay sheet,
"Proving funds & clean" screen (spinner + live step list), and Paid screen use
the same language. An in-app honesty footer lists every mock.

## Mocked (flagged in UI + README)

Token transfer-in & merchant payout, the ASP admin (server route stand-in),
admin-set blocklist root, fixed denominations / no change notes, dev-only setup.

## NOT built yet (per scope)

Merchant register and mock anchor — Home + Pay first, as requested.
