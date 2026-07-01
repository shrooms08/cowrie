# Phase 4 — Merchant register + mock anchor (PASSED)

The seller side and local-currency settlement, completing the demo loop:
**buyer pays privately → merchant sees "paid, verified clean" → mock anchor shows
local currency delivered.** Built in `/web` (desktop/tablet register, separate
from the mobile wallet). Contracts unchanged from Phase 2/3
(`deployments/testnet/phase3.json`).

## The loop, proven on testnet (headless `web/scripts/merchant-e2e.mjs`)

| Stage | Result |
|---|---|
| Merchant invoice | `₦8,500 = $5 USDC @ ₦1,700/$1` (quote via **SEP-38**) |
| Buyer pays (real wallet, real proof) | seedless wallet → vouch → deposit $5 → real spend **tx `1e6d07f34c31d81c37982d4a3388cb82f822a44acc80895e7589b118156536e4`** |
| Register flips | detected the **real on-chain `SpendEvent`** (merchant id + amount match) — its ONLY trusted "paid" signal |
| Mock anchor settles | "Delivered **₦8,500** to Buka Express for $5 USDC" (**SEP-31**) |
| Negative test | a different-merchant invoice and a different-amount ($50) invoice **did NOT match** — no false flip ✓ |

`RESULT: MERCHANT LOOP OK ✓`

## 1. Merchant register (`/merchant`)

Desktop/tablet POS. Create an invoice: NGN amount + description. The mock anchor
quote derives the USDC the buyer must pay (snapped to a payable denomination) and
the **merchant id** = `merchantToField(name)` (the same deterministic field
element the wallet binds in the proof). State machine:

- **NEW CHARGE** → **AWAITING PAYMENT** (shows the charge + a buyer pay-link
  `/?pay=<merchant>&amt=<usdc>` that pre-fills the wallet) → **"Paid. Verified
  clean."** with the animated shield + "₦X settled".
- The flip is driven **only** by the on-chain `SpendEvent`, which the pool emits
  **only after the Groth16 proof verifies**. The register records the ledger when
  the invoice opens and accepts a spend **only if `merchant` AND `amount` match
  its invoice** (and is at/after that ledger) — so it never flips on someone
  else's payment. The merchant learns **only**: paid + clean + amount. Never the
  wallet, balance, which note, or buyer identity.

## 2. Mock anchor (`/mock-anchor`, `/api/anchor/*`)

Clearly labeled **MOCK — not real fiat rails**. SEP mapping (printed in-app):

| Endpoint | SEP | Role |
|---|---|---|
| `POST /api/anchor/quote` | **SEP-38** (Anchor RFQ / quotes) | NGN → USDC at the **exposed** rate (₦1,700/$1, not hidden) |
| `POST /api/anchor/settle` | **SEP-31** (direct payment to receiving merchant) | verifies the on-chain spend, then "delivers" NGN |
| interactive off-ramp | **SEP-24** | alternative UX for the same off-ramp |

`/settle` **independently verifies** the spend — it fetches the tx (must be
`SUCCESS`) and re-confirms a pool `SpendEvent(merchant, amount)` in that tx via
RPC before delivering. It never trusts a "paid" claim from the caller.

## 3. Privacy panel (driven by the real tx)

Live contrast on the register, populated from the real spend:
- **What the register learns:** paid ✓, clean (ASP-verified on-chain) ✓, amount.
- **What stays private:** buyer identity, buyer balance, which note / its source
  deposit — **never revealed** (✕). The panel links the real explorer tx so you
  can confirm the on-chain record exposes a contract call + a public
  `SpendEvent(merchant, amount)` and nothing that links to the buyer.

## Fidelity to the mock register screens

`scratchpad/mock/ui_merchant.png`: "COWRIE REGISTER · LAGOS / ONLINE" + OPEN
status, NEW CHARGE (AMOUNT NGN big field, FOR, merchant), the live quote line,
green "Generate charge", the privacy contrast panel, and the mock-anchor SEP
panel — all in the established green-on-black / mono-label language. AWAITING and
the "Paid. Verified clean." shield + "₦X settled" states match the mock's flow
(exercised by the e2e).

## Mocked / flagged (unchanged from Phase 3, plus this phase)

Token transfer-in & payout, ASP admin (server route), admin-set blocklist root,
fixed denominations / no change notes, dev-only setup — **and the anchor itself**
(MOCK fiat rails; real = Stellar anchor via SEP-24/31/38).
