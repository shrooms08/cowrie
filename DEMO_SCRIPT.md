# Cowrie — demo video script (2–3 min)

Two surfaces on screen: **phone wallet** (`/`) and **merchant register**
(`/merchant`). Hit "reset demo" first for a clean seedless wallet. Pre-fund a note
or two before recording so the Pay step has something to spend (or show the
deposit live if time allows). Keep the on-chain calls visible — the realness is
the point.

**0:00 — The problem.**
> "Pay with crypto today and you hand the merchant — and the whole world — your
> entire financial life: your balance, your history, every other payment. Cash
> doesn't do that. Cowrie makes stablecoin spend like cash."

**0:20 — Seedless wallet, private balance.**
Show the wallet: balance, `name.cowrie` ID, the green PRIVATE pill.
> "No seed phrase — the wallet provisioned itself. Here's my balance. I can hide
> it locally with the eye toggle — but the point is on-chain it's *always* hidden.
> Nobody can see what I hold."

**0:40 — Merchant creates a local-currency invoice.**
Switch to the register. Enter ₦8,500, "Jollof + drink", Generate charge.
> "The merchant is in Lagos. They charge ₦8,500. The anchor quotes that to $5
> USDC at an open rate — and the register starts watching the chain."

**0:55 — Buyer pays. The keystone — let it breathe.**
Open the pay-link / Pay in the wallet, pick the $5 note, tap Pay. **Stay on the
proving screen.**
> "Now I pay. Watch what actually happens: it asks the allowlist provider to
> attest my funds are clean, builds a zero-knowledge witness, generates a Groth16
> proof in my browser, and the Stellar contract verifies it on-chain with native
> pairing checks. This is a *real* proof — not a spinner. It proves I own a clean
> note for exactly this merchant and amount, and reveals nothing else."

**1:20 — The register flips on the real event.**
Cut to the register: shield draws in, "Paid. Verified clean.", "₦8,500 settled."
> "The register only trusts one thing: the on-chain event the contract emits after
> the proof verifies. It just flipped — *paid, verified clean* — and the mock
> anchor delivered ₦8,500 to the merchant."

**1:40 — Privacy panel: the real tx reveals nothing.**
Show the privacy panel; click through to the real explorer tx.
> "Here's the same payment on the public explorer. The merchant learns: paid,
> clean, the amount. That's it. Buyer address, balance, which note, where it came
> from — redacted, because the chain never had them. This is a real testnet tx;
> go look."

**2:00 — The differentiator: dirty money can't move. End on this.**
Try to pay with a note whose identity was never allowlisted (or describe it).
> "And the part that matters: a *dirty* note — one not on the clean-funds
> allowlist — can't pay. Not 'the app blocks it' — it literally **cannot generate
> a proof**. The clean-funds rule is a constraint inside the zero-knowledge
> circuit. Privacy for the user, compliance for the merchant, enforced by math."

**2:20 — One honest line.**
> "The anchor and the fiat rails here are mocked, and the trusted setup is
> dev-only — but the zero-knowledge proofs and the on-chain verification are real,
> live on Stellar testnet today. That's Cowrie."

---

### Shot list / cues
- Reset demo → clean wallet (cwFadeUp balance, cwDrift background).
- Eye toggle once (emphasize "on-chain always hidden").
- Register: Generate charge → AWAITING (spinner).
- Wallet Pay → **hold on the 4-step proving screen** (vouch → witness → Groth16 → on-chain verify).
- Register: shield cwDraw + "₦ settled" cwPop.
- Privacy panel: fields cwRedact to "nothing identifying"; open real explorer tx.
- Non-allowlisted attempt → clean error: "this note isn't on the ASP allowlist."
