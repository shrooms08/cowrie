// ASP "vouch" endpoint — STAND-IN for the real Association-Set Provider service.
//
// ⚠️ MOCK: in production an independent ASP attests that funds are clean and
// publishes the allowlist. Here a server route holds the ASP admin key and adds
// a wallet's identity leaf H(pubKey,0,1) to the on-chain allowlist on request.
// It returns the canonical leaf ORDER (index 0 = global dummy) so the wallet can
// rebuild membership paths. Only the leaf (a hash) crosses the wire.
//
// The canonical leaf order is read straight from the ASP contract's persistent
// storage (`DataKey::Leaves`) — the on-chain source of truth. We deliberately do
// NOT cache it in a local file: Vercel's serverless filesystem is read-only
// (writing threw `EROFS`), and reading storage is also immune to RPC event-aging.
import { NextRequest, NextResponse } from "next/server";
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { ASP_ID, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the authoritative ordered allowlist leaf set directly from the ASP
 * contract's persistent storage entry `DataKey::Leaves` (a `Vec<U256>`). A unit
 * enum variant encodes as `ScVal::Vec([Symbol("Leaves")])`. This is the exact
 * vector the contract hashes into its root, so the returned order's Merkle root
 * always equals the live `get_root()` — no local file, no event reconstruction.
 */
async function readLeavesFromChain(server: rpc.Server): Promise<string[]> {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Leaves")]);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(ASP_ID).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const resp = await server.getLedgerEntries(ledgerKey);
  if (!resp.entries || resp.entries.length === 0) {
    // Allowlist storage not present yet — fall back to the known dummy@0 so a
    // never-vouched deployment still returns a coherent (single-leaf) order.
    const dummy = process.env.ASP_DUMMY_LEAF;
    return dummy ? [dummy] : [];
  }
  const val = resp.entries[0].val.contractData().val();
  return (scValToNative(val) as unknown[]).map((x) => BigInt(x as bigint).toString());
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

async function liveRoot(server: rpc.Server): Promise<string> {
  const probe = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(probe, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
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
    const server = new rpc.Server(RPC_URL);

    let leaves = await readLeavesFromChain(server);
    let index = leaves.indexOf(leaf);
    if (index === -1) {
      // Not yet allowlisted — add it on-chain, then re-read the authoritative
      // order (the admin_add tx is already confirmed, so storage reflects it).
      await adminAdd(kp, leaf);
      leaves = await readLeavesFromChain(server);
      index = leaves.indexOf(leaf);
      // Belt-and-suspenders: if the read momentarily lags the write, append the
      // known leaf so the caller still gets a usable order (its root is then
      // re-confirmed client-side against the live root before proving).
      if (index === -1) {
        leaves = [...leaves, leaf];
        index = leaves.length - 1;
      }
    }
    return NextResponse.json({ index, leaves, root: await liveRoot(server) });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
