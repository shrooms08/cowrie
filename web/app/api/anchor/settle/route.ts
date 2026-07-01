// MOCK anchor — settle endpoint.
//
// ⚠️ MOCK: not real fiat rails. In production this is a Stellar anchor off-ramp.
// SEP mapping: this endpoint maps to **SEP-31 (direct/cross-border payment to a
// receiving merchant)**; the interactive-withdraw alternative is **SEP-24**.
//
// It INDEPENDENTLY verifies the on-chain spend (tx success + a matching pool
// SpendEvent) before "delivering" fiat — it never trusts a "paid" claim from
// the client.
import { NextRequest, NextResponse } from "next/server";
import { scValToNative, rpc } from "@stellar/stellar-sdk";
import { ANCHOR_NAME, ANCHOR_RATE_NGN_PER_USDC, fmtNGN } from "@/lib/merchant";
import { POOL_ID, RPC_URL } from "@/lib/config";

export async function POST(req: NextRequest) {
  try {
    const { txHash, merchant, payout, merchantName } = (await req.json()) as {
      txHash: string;
      merchant: string;
      payout: number;
      merchantName: string;
    };
    const s = new rpc.Server(RPC_URL);

    // 1. the spend tx must have succeeded on-chain
    const tx = await s.getTransaction(txHash).catch(() => null);
    if (!tx || tx.status !== "SUCCESS") {
      return NextResponse.json({ error: "spend tx not found / not successful" }, { status: 402 });
    }

    // 2. independently confirm a pool SpendEvent(merchant, payout) exists in that
    //    tx — the only trustworthy proof the funds were verified clean on-chain.
    const latest = (await s.getLatestLedger()).sequence;
    const evs = await s.getEvents({
      startLedger: Math.max(tx.ledger - 5, latest - 8000, 1),
      filters: [{ type: "contract", contractIds: [POOL_ID] }],
      limit: 200,
    });
    const matched = evs.events.find((ev) => {
      if (ev.txHash !== txHash) return false;
      const topics = (ev.topic ?? []).map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return undefined;
        }
      });
      if (!topics.includes("Spend")) return false;
      const v = scValToNative(ev.value) as Record<string, unknown>;
      return BigInt(v.merchant as bigint).toString() === merchant && Number(v.payout as bigint) === payout;
    });
    if (!matched) {
      return NextResponse.json({ error: "no matching verified SpendEvent in that tx" }, { status: 402 });
    }

    // 3. "deliver" local currency at the quoted rate (MOCK — no real rails).
    const ngn = payout * ANCHOR_RATE_NGN_PER_USDC;
    return NextResponse.json({
      delivered: true,
      mock: true,
      anchor: ANCHOR_NAME,
      sep: "SEP-31 (direct payment to merchant) · interactive off-ramp would be SEP-24",
      message: `Delivered ${fmtNGN(ngn)} to ${merchantName} for $${payout} USDC`,
      ngn,
      usdc: payout,
      rate: ANCHOR_RATE_NGN_PER_USDC,
      txHash,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
