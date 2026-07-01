// MOCK anchor — quote endpoint.
//
// ⚠️ MOCK: not real fiat rails. In production this is a Stellar anchor RFQ.
// SEP mapping: this endpoint maps to **SEP-38 (Anchor RFQ / quotes)**.
import { NextRequest, NextResponse } from "next/server";
import { quoteFromNgn } from "@/lib/merchant";

export async function POST(req: NextRequest) {
  const { ngn } = (await req.json()) as { ngn: number };
  if (!ngn || ngn <= 0) return NextResponse.json({ error: "bad ngn" }, { status: 400 });
  const q = quoteFromNgn(ngn);
  return NextResponse.json({ ...q, mock: true });
}
