// Cowrie mock anchor.
//
// Stands in for a real Stellar anchor (SEP-24/SEP-31 off-ramp). When a merchant
// receives a private USDC payment from the pool, the anchor "settles" it into local
// currency and returns a fake payout reference. No real money moves.
//
// STUB — see PLAN.md Phase 6.

import express from "express";

const app = express();
app.use(express.json());

// Indicative FX; in a real anchor this comes from a quote (SEP-38).
const FX_USDC_TO_LOCAL = 1600; // e.g. 1 USDC -> 1600 local units

app.get("/health", (_req, res) => res.json({ ok: true, service: "cowrie-mock-anchor" }));

// TODO(PLAN Phase 6): accept a settled pool withdrawal (tx hash + amount), verify it
// on-chain via RPC, then record a payout. For now, echo a fake settlement.
app.post("/settle", (req, res) => {
  const { usdcAmount, merchantRef } = req.body ?? {};
  const amount = Number(usdcAmount ?? 0);
  res.json({
    status: "settled",
    merchantRef: merchantRef ?? null,
    usdcAmount: amount,
    localAmount: amount * FX_USDC_TO_LOCAL,
    fxRate: FX_USDC_TO_LOCAL,
    payoutRef: "MOCK-PAYOUT-PENDING",
  });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`cowrie-mock-anchor on :${port}`));
