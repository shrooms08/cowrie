// Headless e2e exercising the SAME wasm witness builder + two-step prover + the
// pool/asp contract calls (with event-reconstructed trees) the UI uses, against
// the deployed UI contracts on testnet. Proves: seedless deposit, two
// successive distinct spends both succeed, non-allowlisted note fails.
import * as w from "../wasm-witness/pkg-node/cowrie_wasm.js";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import {
  Account, Contract, Keypair, TransactionBuilder,
  nativeToScVal, scValToNative, rpc, xdr,
} from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const NET = "Test SDF Network ; September 2015";
const POOL = "CDSQE32Q7W27FTK4CBGBDTHKKKVFL4BZH5OPNMVLKSMXOOTJ4J6LPM6B";
const ASP = "CC3VMBFWUNSAAFM6OM6TUAJCSMXKMFKJB2W2TB6WPZH6FG6PRSJGHHXJ";
const C = "/Users/minos/Projects/cowrie/circuits";
const ADMIN = fs.readFileSync(".env.local", "utf8").match(/ASP_ADMIN_SECRET=(\S+)/)[1];

const server = () => new rpc.Server(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u256 = (d) => nativeToScVal(BigInt(d), { type: "u256" });
const vecU256 = (a) => xdr.ScVal.scvVec(a.map(u256));
const u32 = (n) => nativeToScVal(n, { type: "u32" });

async function read(cid, method, args = []) {
  const s = server();
  const acct = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: NET })
    .addOperation(new Contract(cid).call(method, ...args)).setTimeout(30).build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(method + ": " + sim.error);
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}
// Resilient write: NEVER blind-resubmit. Before each retry, consult confirm()
// to learn whether a prior attempt already landed.
async function write(kp, cid, method, args, label, confirm) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0 && confirm && (await confirm().catch(() => false))) return { hash: "", landed: true };
    try {
      const s = server();
      const account = await s.getAccount(kp.publicKey());
      let tx = new TransactionBuilder(account, { fee: "3000000", networkPassphrase: NET })
        .addOperation(new Contract(cid).call(method, ...args)).setTimeout(60).build();
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) return { error: sim.error }; // deterministic reject
      tx = rpc.assembleTransaction(tx, sim).build(); tx.sign(kp);
      const send = await s.sendTransaction(tx);
      if (send.status === "ERROR") {
        let code = "?";
        try { code = send.errorResult?.result()?.switch()?.name ?? "?"; } catch {}
        throw new Error("send rejected: " + code);
      }
      for (let i = 0; i < 30; i++) {
        const g = await s.getTransaction(send.hash);
        if (g.status === "SUCCESS") return { hash: send.hash, ret: g.returnValue ? scValToNative(g.returnValue) : undefined, landed: true };
        if (g.status === "FAILED") return { error: "FAILED " + send.hash };
        await sleep(1500);
      }
    } catch (e) { console.log(`  ${label} flake (retry ${attempt}):`, String(e.message).slice(0, 40)); await sleep(2000); }
  }
  if (confirm && (await confirm().catch(() => false))) return { hash: "", landed: true };
  return { error: "exhausted" };
}
async function getLeaves(cid, field) {
  const s = server();
  const latest = (await s.getLatestLedger()).sequence;
  const byIndex = new Map();
  let cursor;
  for (let page = 0; page < 20; page++) {
    const res = await s.getEvents(cursor
      ? { filters: [{ type: "contract", contractIds: [cid] }], cursor, limit: 200 }
      : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [cid] }], limit: 200 });
    for (const ev of res.events) {
      const v = scValToNative(ev.value);
      if (v && v.index !== undefined && v[field] !== undefined) byIndex.set(Number(v.index), BigInt(v[field]).toString());
    }
    if (res.events.length < 200) break;
    cursor = res.cursor;
  }
  const max = byIndex.size ? Math.max(...byIndex.keys()) : -1;
  const out = [];
  for (let i = 0; i <= max; i++) out.push(byIndex.get(i) ?? "0");
  return out;
}

async function proveSpend(input) {
  const wcMod = await import(`${C}/build/policy_tx_2_2_js/witness_calculator.js`);
  const wc = await wcMod.default(fs.readFileSync(`${C}/build/policy_tx_2_2_js/policy_tx_2_2.wasm`));
  const wtns = await wc.calculateWTNSBin(input, 0);
  const { proof } = await groth16.prove(new Uint8Array(fs.readFileSync(`${C}/build/keys/policy_final.zkey`)), new Uint8Array(wtns));
  const be = (d) => { let x = BigInt(d); const o = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  return Buffer.concat([be(proof.pi_a[0]), be(proof.pi_a[1]), be(proof.pi_b[0][1]), be(proof.pi_b[0][0]), be(proof.pi_b[1][1]), be(proof.pi_b[1][0]), be(proof.pi_c[0]), be(proof.pi_c[1])]).toString("hex");
}
function randPriv() { const b = Buffer.alloc(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); return BigInt("0x" + b.toString("hex")).toString(); }

async function spend(kp, walletPriv, note, poolLeaves, aspLeaves, noteAspIndex, dummyAspIndex, merchant) {
  const built = JSON.parse(w.build_spend(walletPriv, note.blinding, note.amount, note.leafIndex,
    JSON.stringify(poolLeaves), JSON.stringify(aspLeaves), noteAspIndex, dummyAspIndex, merchant, note.amount));
  const proofHex = await proveSpend(built.input);
  const args = [xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")),
    u256(built.root), u256(built.public_amount), u256(built.ext_data_hash),
    vecU256(built.input_nullifiers), vecU256(built.output_commitments),
    u256(built.asp_membership_root), u256(built.asp_non_membership_root),
    u256(merchant), u32(note.amount)];
  return write(kp, POOL, "spend", args, "spend");
}

async function main() {
  const kp = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  for (let i = 0; i < 20; i++) { try { await server().getAccount(kp.publicKey()); break; } catch { await sleep(1500); } }
  const walletPriv = randPriv();
  console.log("1. seedless wallet funded:", kp.publicKey().slice(0, 8) + "…");

  const adminKp = Keypair.fromSecret(ADMIN);
  const aspLeaf = w.asp_leaf_for(walletPriv);
  const aspRootLive = async () => BigInt(String(await read(ASP, "get_root"))).toString();
  const v = await write(adminKp, ASP, "admin_add", [u256(aspLeaf)], "vouch",
    async () => { const ls = await getLeaves(ASP, "leaf"); return ls.includes(aspLeaf); });
  const noteAspIndex = typeof v.ret === "number" ? v.ret : -1;
  // Resolve the ASP tree to one whose root matches the LIVE asp root exactly
  // (ASP has no root history). Overlay our own leaf to beat event lag.
  async function resolveAsp() {
    const live = await aspRootLive();
    for (let t = 0; t < 8; t++) {
      const ls = await getLeaves(ASP, "leaf");
      if (noteAspIndex >= 0) { while (ls.length <= noteAspIndex) ls.push("0"); ls[noteAspIndex] = aspLeaf; }
      if (w.merkle_root_of(JSON.stringify(ls)) === live) return ls;
      await sleep(2500);
    }
    throw new Error("could not resolve live ASP root");
  }
  const aspLeaves = await resolveAsp();
  const dummyAspIndex = Math.max(0, aspLeaves.indexOf(w.dummy_asp_leaf()));
  const myAspIndex = noteAspIndex >= 0 ? noteAspIndex : aspLeaves.indexOf(aspLeaf);
  console.log(`2. ASP vouched -> identity at index ${myAspIndex}, dummy at ${dummyAspIndex} (tree size ${aspLeaves.length}, tx ${(v.hash||"").slice(0,10)})`);

  const poolRoot = async () => BigInt(String(await read(POOL, "get_root"))).toString();
  const notes = [];
  for (const amount of [5, 10]) {
    const blinding = randPriv();
    const commitment = w.note_commitment(amount, walletPriv, blinding);
    const before = await getLeaves(POOL, "commitment");
    const expectedRoot = w.merkle_root_of(JSON.stringify([...before, commitment]));
    // confirm = the new root is live; prevents blind double-deposit on flakes
    const r = await write(kp, POOL, "deposit", [u32(amount), u256(commitment)], "deposit",
      async () => (await poolRoot()) === expectedRoot);
    if (r.error) throw new Error("deposit failed: " + JSON.stringify(r.error).slice(0, 50));
    const leafIndex = typeof r.ret === "number" ? r.ret : before.length;
    notes.push({ amount, blinding, leafIndex, commitment });
    console.log(`3. deposit $${amount} -> leaf #${leafIndex} (tx ${(r.hash||"").slice(0,10)})`);
  }

  // Resolve the FULL pool tree such that the built root is one the contract
  // accepts (handles event-indexing lag + other depositors). Re-fetch until
  // is_known_root, overlaying our own notes which we always know.
  async function resolvePool() {
    for (let t = 0; t < 8; t++) {
      const leaves = await getLeaves(POOL, "commitment");
      for (const n of notes) { while (leaves.length <= n.leafIndex) leaves.push("0"); leaves[n.leafIndex] = n.commitment; }
      const root = w.merkle_root_of(JSON.stringify(leaves));
      if (await read(POOL, "is_known_root", [u256(root)])) return leaves;
      await sleep(2500);
    }
    throw new Error("could not resolve a known pool root");
  }
  const poolLeaves = await resolvePool();
  const r1 = await spend(kp, walletPriv, notes[0], poolLeaves, aspLeaves, myAspIndex, dummyAspIndex, "12648430");
  console.log(`4a. SPEND $5 note#${notes[0].leafIndex}:`, r1.hash ? `SUCCESS tx ${r1.hash}` : `FAIL ${JSON.stringify(r1.error).slice(0,60)}`);
  await sleep(8000); // let the account sequence settle before the next spend
  const r2 = await spend(kp, walletPriv, notes[1], poolLeaves, aspLeaves, myAspIndex, dummyAspIndex, "12648430");
  console.log(`4b. SPEND $10 note#${notes[1].leafIndex}:`, r2.hash ? `SUCCESS tx ${r2.hash}` : `FAIL ${JSON.stringify(r2.error).slice(0,60)}`);

  // non-allowlisted: different identity, never vouched
  const otherPriv = randPriv(), otherBlind = randPriv();
  const otherCommit = w.note_commitment(5, otherPriv, otherBlind);
  const dr = await write(kp, POOL, "deposit", [u32(5), u256(otherCommit)], "deposit");
  const pl2 = await getLeaves(POOL, "commitment");
  const otherIdx = pl2.indexOf(otherCommit);
  let nonAllow;
  try {
    const built = JSON.parse(w.build_spend(otherPriv, otherBlind, 5, otherIdx,
      JSON.stringify(pl2), JSON.stringify(aspLeaves), noteAspIndex /* not its leaf */, dummyAspIndex, "12648430", 5));
    await proveSpend(built.input);
    nonAllow = "UNEXPECTED: produced a proof";
  } catch (e) {
    nonAllow = String(e.message).includes("Assert") ? "witness FAILED at Assert (clean-funds binds) ✓" : "FAILED: " + String(e.message).slice(0, 40);
  }
  console.log(`5. non-allowlisted note: ${nonAllow}`);
  console.log("\nRESULT:", r1.hash && r2.hash ? "TWO DISTINCT SPENDS SUCCEEDED ✓" : "SPEND FAILURE ✗");
}
main().catch((e) => { console.error("e2e error:", String(e.message || e).split("\n")[0]); process.exit(1); });
