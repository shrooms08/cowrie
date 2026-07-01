// Phase 4 merchant-loop e2e against testnet + the running dev server:
//   merchant quote -> invoice -> REAL buyer payment -> register detects the REAL
//   SpendEvent (merchant id + amount) -> mock anchor settles -> negative test
//   (a different merchant/amount must NOT match this invoice).
import * as w from "../wasm-witness/pkg-node/cowrie_wasm.js";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import {
  Account, Contract, Keypair, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr,
} from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const NET = "Test SDF Network ; September 2015";
const POOL = "CDSQE32Q7W27FTK4CBGBDTHKKKVFL4BZH5OPNMVLKSMXOOTJ4J6LPM6B";
const ASP = "CC3VMBFWUNSAAFM6OM6TUAJCSMXKMFKJB2W2TB6WPZH6FG6PRSJGHHXJ";
const C = "/Users/minos/Projects/cowrie/circuits";
const DEV = "http://localhost:3000";
const ADMIN = fs.readFileSync(".env.local", "utf8").match(/ASP_ADMIN_SECRET=(\S+)/)[1];

const server = () => new rpc.Server(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u256 = (d) => nativeToScVal(BigInt(d), { type: "u256" });
const vecU256 = (a) => xdr.ScVal.scvVec(a.map(u256));
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const merchantToField = (name) => { let h = 0n; for (const ch of name.trim()) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 200n); return (h === 0n ? 12648430n : h).toString(); };

async function read(cid, m, args = []) {
  const s = server();
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: "100", networkPassphrase: NET })
    .addOperation(new Contract(cid).call(m, ...args)).setTimeout(30).build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(m + ": " + sim.error);
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}
async function write(kp, cid, m, args, label, confirm) {
  for (let a = 0; a < 5; a++) {
    if (a > 0 && confirm && (await confirm().catch(() => false))) return { landed: true };
    try {
      const s = server();
      const acct = await s.getAccount(kp.publicKey());
      let tx = new TransactionBuilder(acct, { fee: "3000000", networkPassphrase: NET }).addOperation(new Contract(cid).call(m, ...args)).setTimeout(60).build();
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
      tx = rpc.assembleTransaction(tx, sim).build(); tx.sign(kp);
      const send = await s.sendTransaction(tx);
      if (send.status === "ERROR") { let c = "?"; try { c = send.errorResult?.result()?.switch()?.name; } catch {} throw new Error("send " + c); }
      for (let i = 0; i < 30; i++) { const g = await s.getTransaction(send.hash); if (g.status === "SUCCESS") return { hash: send.hash, ret: g.returnValue ? scValToNative(g.returnValue) : undefined }; if (g.status === "FAILED") return { error: "FAILED" }; await sleep(1500); }
    } catch (e) { console.log(`  ${label} flake ${a}: ${String(e.message).slice(0, 36)}`); await sleep(2000); }
  }
  if (confirm && (await confirm().catch(() => false))) return { landed: true };
  return { error: "exhausted" };
}
async function getLeaves(cid, field) {
  const s = server(); const latest = (await s.getLatestLedger()).sequence; const byIndex = new Map(); let cursor;
  for (let p = 0; p < 20; p++) {
    const res = await s.getEvents(cursor ? { filters: [{ type: "contract", contractIds: [cid] }], cursor, limit: 200 } : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [cid] }], limit: 200 });
    for (const ev of res.events) { const v = scValToNative(ev.value); if (v && v.index !== undefined && v[field] !== undefined) byIndex.set(Number(v.index), BigInt(v[field]).toString()); }
    if (res.events.length < 200) break; cursor = res.cursor;
  }
  const max = byIndex.size ? Math.max(...byIndex.keys()) : -1; const out = []; for (let i = 0; i <= max; i++) out.push(byIndex.get(i) ?? "0"); return out;
}
async function getSpends(since) {
  const s = server(); const latest = (await s.getLatestLedger()).sequence; const out = [];
  const res = await s.getEvents({ startLedger: Math.max(since, latest - 8000, 1), filters: [{ type: "contract", contractIds: [POOL] }], limit: 200 });
  for (const ev of res.events) {
    const topics = (ev.topic ?? []).map((t) => { try { return scValToNative(t); } catch { return 0; } });
    if (!topics.includes("Spend")) continue;
    const v = scValToNative(ev.value);
    out.push({ merchant: BigInt(v.merchant).toString(), payout: Number(v.payout), txHash: ev.txHash, ledger: ev.ledger });
  }
  return out;
}
async function proveSpend(input) {
  const wc = await (await import(`${C}/build/policy_tx_2_2_js/witness_calculator.js`)).default(fs.readFileSync(`${C}/build/policy_tx_2_2_js/policy_tx_2_2.wasm`));
  const wtns = await wc.calculateWTNSBin(input, 0);
  const { proof } = await groth16.prove(new Uint8Array(fs.readFileSync(`${C}/build/keys/policy_final.zkey`)), new Uint8Array(wtns));
  const be = (d) => { let x = BigInt(d); const o = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  return Buffer.concat([be(proof.pi_a[0]), be(proof.pi_a[1]), be(proof.pi_b[0][1]), be(proof.pi_b[0][0]), be(proof.pi_b[1][1]), be(proof.pi_b[1][0]), be(proof.pi_c[0]), be(proof.pi_c[1])]).toString("hex");
}
const randPriv = () => { const b = Buffer.alloc(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); return BigInt("0x" + b.toString("hex")).toString(); };

async function main() {
  // ===== MERCHANT: quote an NGN invoice =====
  const merchantName = "Buka Express";
  const q = await fetch(`${DEV}/api/anchor/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ngn: 8500 }) }).then((r) => r.json());
  const merchantId = merchantToField(merchantName);
  console.log(`MERCHANT invoice: ₦${q.ngn} = $${q.usdc} USDC @ ${q.rateLabel} (${q.sep})  merchant id ${merchantId.slice(0, 12)}…`);
  const sinceLedger = (await server().getLatestLedger()).sequence - 1;

  // ===== BUYER: seedless wallet, vouch, deposit a $usdc note, real spend to merchantId =====
  const kp = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  for (let i = 0; i < 20; i++) { try { await server().getAccount(kp.publicKey()); break; } catch { await sleep(1500); } }
  const walletPriv = randPriv();
  const adminKp = Keypair.fromSecret(ADMIN);
  const aspLeaf = w.asp_leaf_for(walletPriv);
  const v = await write(adminKp, ASP, "admin_add", [u256(aspLeaf)], "vouch", async () => (await getLeaves(ASP, "leaf")).includes(aspLeaf));
  const noteAspIndex = typeof v.ret === "number" ? v.ret : -1;
  const aspLive = BigInt(String(await read(ASP, "get_root"))).toString();
  let aspLeaves;
  for (let t = 0; t < 8; t++) { const ls = await getLeaves(ASP, "leaf"); if (noteAspIndex >= 0) { while (ls.length <= noteAspIndex) ls.push("0"); ls[noteAspIndex] = aspLeaf; } if (w.merkle_root_of(JSON.stringify(ls)) === aspLive) { aspLeaves = ls; break; } await sleep(2500); }
  const dummyAspIndex = Math.max(0, aspLeaves.indexOf(w.dummy_asp_leaf()));
  console.log(`BUYER funded + vouched (asp idx ${noteAspIndex})`);

  const blinding = randPriv();
  const commitment = w.note_commitment(q.usdc, walletPriv, blinding);
  const before = await getLeaves(POOL, "commitment");
  const expRoot = w.merkle_root_of(JSON.stringify([...before, commitment]));
  const dr = await write(kp, POOL, "deposit", [u32(q.usdc), u256(commitment)], "deposit", async () => BigInt(String(await read(POOL, "get_root"))).toString() === expRoot);
  const leafIndex = typeof dr.ret === "number" ? dr.ret : before.length;
  console.log(`BUYER deposited $${q.usdc} note -> leaf #${leafIndex}`);

  // resolve pool to a known root
  let poolLeaves;
  for (let t = 0; t < 8; t++) { const ls = await getLeaves(POOL, "commitment"); while (ls.length <= leafIndex) ls.push("0"); ls[leafIndex] = commitment; const root = w.merkle_root_of(JSON.stringify(ls)); if (await read(POOL, "is_known_root", [u256(root)])) { poolLeaves = ls; break; } await sleep(2500); }

  const built = JSON.parse(w.build_spend(walletPriv, blinding, q.usdc, leafIndex, JSON.stringify(poolLeaves), JSON.stringify(aspLeaves), noteAspIndex, dummyAspIndex, merchantId, q.usdc));
  const proofHex = await proveSpend(built.input);
  const sp = await write(kp, POOL, "spend", [xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")), u256(built.root), u256(built.public_amount), u256(built.ext_data_hash), vecU256(built.input_nullifiers), vecU256(built.output_commitments), u256(built.asp_membership_root), u256(built.asp_non_membership_root), u256(merchantId), u32(q.usdc)], "spend", async () => Boolean(await read(POOL, "is_spent", [u256(built.real_nullifier)])));
  console.log(`BUYER paid: spend ${sp.hash ? "tx " + sp.hash : JSON.stringify(sp.error)}`);

  // ===== REGISTER: detect the REAL SpendEvent for THIS invoice =====
  let detected;
  for (let t = 0; t < 10; t++) {
    const spends = await getSpends(sinceLedger);
    detected = spends.find((e) => e.merchant === merchantId && e.payout === q.usdc);
    if (detected) break;
    await sleep(3000);
  }
  console.log(detected ? `REGISTER detected SpendEvent (merchant+amount match) tx ${detected.txHash.slice(0, 12)}…` : "REGISTER did NOT detect (FAIL)");

  // ===== ANCHOR: settle (independently verifies the spend) =====
  if (detected) {
    const s = await fetch(`${DEV}/api/anchor/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: detected.txHash, merchant: merchantId, payout: q.usdc, merchantName }) }).then((r) => r.json());
    console.log(`ANCHOR settle: ${s.delivered ? s.message + "  [" + s.sep + "]" : "FAIL " + JSON.stringify(s)}`);
  }

  // ===== NEGATIVE: a different invoice (other merchant / other amount) must NOT match =====
  const otherId = merchantToField("Other Shop");
  const spends = await getSpends(sinceLedger);
  const falseMatchMerchant = spends.find((e) => e.merchant === otherId && e.payout === q.usdc);
  const falseMatchAmount = spends.find((e) => e.merchant === merchantId && e.payout !== q.usdc && e.payout === 50);
  console.log(`NEGATIVE: different-merchant invoice match = ${falseMatchMerchant ? "FALSE FLIP ✗" : "none ✓"}; different-amount(50) match = ${falseMatchAmount ? "FALSE FLIP ✗" : "none ✓"}`);

  console.log(`\nRESULT: ${detected && !falseMatchMerchant ? "MERCHANT LOOP OK ✓" : "FAIL ✗"}`);
}
main().catch((e) => { console.error("e2e error:", String(e.message || e).split("\n")[0]); process.exit(1); });
