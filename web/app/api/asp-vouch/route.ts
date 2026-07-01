// ASP "vouch" endpoint — STAND-IN for the real Association-Set Provider service.
//
// ⚠️ MOCK: in production an independent ASP attests that funds are clean and
// publishes the allowlist. Here a server route holds the ASP admin key and adds
// a wallet's identity leaf H(pubKey,0,1) to the on-chain allowlist on request.
// It maintains the canonical leaf ORDER (index 0 = global dummy) so the wallet
// can rebuild membership paths. Only the leaf (a hash) crosses the wire.
import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import fs from "node:fs";
import path from "node:path";
import { ASP_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/config";

const STORE = path.join(process.cwd(), ".cowrie-asp-leaves.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readLeaves(): string[] {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    // seed with the global dummy leaf at index 0 (already on-chain at index 0)
    const dummy = process.env.ASP_DUMMY_LEAF;
    return dummy ? [dummy] : [];
  }
}
function writeLeaves(l: string[]) {
  fs.writeFileSync(STORE, JSON.stringify(l));
}

async function adminAdd(kp: Keypair, leafDec: string): Promise<void> {
  const server = new rpc.Server(RPC_URL);
  const account = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(ASP_ID).call("admin_add", nativeToScVal(BigInt(leafDec), { type: "u256" })))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`admin_add sim: ${sim.error}`);
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);
  const send = await server.sendTransaction(tx);
  for (let i = 0; i < 30; i++) {
    const got = await server.getTransaction(send.hash);
    if (got.status === "SUCCESS") return;
    if (got.status === "FAILED") throw new Error("admin_add failed");
    await sleep(1500);
  }
  throw new Error("admin_add timed out");
}

async function liveRoot(): Promise<string> {
  const server = new rpc.Server(RPC_URL);
  const probe = Keypair.random().publicKey();
  const acct = new (await import("@stellar/stellar-sdk")).Account(probe, "0");
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(ASP_ID).call("get_root"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return BigInt(String(scValToNative((sim.result as { retval: xdr.ScVal }).retval))).toString();
}

export async function POST(req: NextRequest) {
  try {
    const { leaf } = (await req.json()) as { leaf: string };
    if (!leaf || !/^\d+$/.test(leaf)) return NextResponse.json({ error: "bad leaf" }, { status: 400 });
    const secret = process.env.ASP_ADMIN_SECRET;
    if (!secret) return NextResponse.json({ error: "ASP admin not configured" }, { status: 500 });
    const kp = Keypair.fromSecret(secret);

    const leaves = readLeaves();
    let index = leaves.indexOf(leaf);
    if (index === -1) {
      await adminAdd(kp, leaf);
      leaves.push(leaf);
      writeLeaves(leaves);
      index = leaves.length - 1;
    }
    return NextResponse.json({ index, leaves, root: await liveRoot() });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
