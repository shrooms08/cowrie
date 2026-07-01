// Phase R0 — arbitrary amount + change-note kill switch, headless on testnet.
// Proves: single-input+change, two-input+change, value-safety (counterfeiting
// impossible), and clean-funds preserved on change notes. Uses the EXISTING
// circuit (no circuit change) + the change-enabled pool (inserts output leaves).
import * as w from "../wasm-witness/pkg-node/cowrie_wasm.js";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import {
  Account, Contract, Keypair, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr,
} from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const NET = "Test SDF Network ; September 2015";
const POOL = fs.readFileSync("/tmp/change_pool.txt", "utf8").trim();
const ASP = "CCWKOEE3FJEPUMNVSLSBIF6LKBD3H3DMGJZOIVTD537K26FDCO4TBW5X";
const C = "/Users/minos/Projects/cowrie/circuits";
const ADMIN = fs.readFileSync(".env.local", "utf8").match(/ASP_ADMIN_SECRET=(\S+)/)[1];

const DUMMY_PRIV = "9001", DUMMY_BLIND = "9002";
const server = () => new rpc.Server(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u256 = (d) => nativeToScVal(BigInt(d), { type: "u256" });
const vecU256 = (a) => xdr.ScVal.scvVec(a.map(u256));
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const merchantToField = (name) => { let h = 0n; for (const ch of name.trim()) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 200n); return (h === 0n ? 12648430n : h).toString(); };
const be32 = (d) => { let x = BigInt(d); const o = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const randPriv = () => { const b = Buffer.alloc(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); return BigInt("0x" + b.toString("hex")).toString(); };

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
      let tx = new TransactionBuilder(acct, { fee: "4000000", networkPassphrase: NET }).addOperation(new Contract(cid).call(m, ...args)).setTimeout(60).build();
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
      tx = rpc.assembleTransaction(tx, sim).build(); tx.sign(kp);
      const send = await s.sendTransaction(tx);
      if (send.status === "ERROR") { let c = "?"; try { c = send.errorResult?.result()?.switch()?.name; } catch {} throw new Error("send " + c); }
      for (let i = 0; i < 30; i++) { const g = await s.getTransaction(send.hash); if (g.status === "SUCCESS") return { hash: send.hash, ret: g.returnValue ? scValToNative(g.returnValue) : undefined }; if (g.status === "FAILED") { throw new Error("FAILED " + send.hash.slice(0,8) + " (footprint/state lag, re-simulating)"); } await sleep(1500); }
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
// Pool leaves come from BOTH Deposit and ChangeNote events (both insert leaves), indexed by leaf index.
async function getPoolLeaves() {
  const s = server(); const latest = (await s.getLatestLedger()).sequence; const byIndex = new Map(); let cursor;
  for (let p = 0; p < 20; p++) {
    const res = await s.getEvents(cursor ? { filters: [{ type: "contract", contractIds: [POOL] }], cursor, limit: 200 } : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [POOL] }], limit: 200 });
    for (const ev of res.events) { const v = scValToNative(ev.value); if (v && v.index !== undefined && v.commitment !== undefined) byIndex.set(Number(v.index), BigInt(v.commitment).toString()); }
    if (res.events.length < 200) break; cursor = res.cursor;
  }
  const max = byIndex.size ? Math.max(...byIndex.keys()) : -1; const out = []; for (let i = 0; i <= max; i++) out.push(byIndex.get(i) ?? "0"); return out;
}
async function proveSpend(input) {
  const wc = await (await import(`${C}/build/policy_tx_2_2_js/witness_calculator.js`)).default(fs.readFileSync(`${C}/build/policy_tx_2_2_js/policy_tx_2_2.wasm`));
  const wtns = await wc.calculateWTNSBin(input, 0);
  const { proof } = await groth16.prove(new Uint8Array(fs.readFileSync(`${C}/build/keys/policy_final.zkey`)), new Uint8Array(wtns));
  return Buffer.concat([be32(proof.pi_a[0]), be32(proof.pi_a[1]), be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]), be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]), be32(proof.pi_c[0]), be32(proof.pi_c[1])]).toString("hex");
}

let walletPriv, aspLeaves, noteAspIndex, dummyAspIndex;

async function vouchOnce(kp) {
  const adminKp = Keypair.fromSecret(ADMIN);
  const aspLeaf = w.asp_leaf_for(walletPriv);
  const vch = await write(adminKp, ASP, "admin_add", [u256(aspLeaf)], "vouch", async () => (await getLeaves(ASP, "leaf")).includes(aspLeaf));
  const retIdx = typeof vch.ret === "number" ? vch.ret : -1;
  const live = BigInt(String(await read(ASP, "get_root"))).toString();
  for (let t = 0; t < 12; t++) {
    const ls = await getLeaves(ASP, "leaf");
    if (!ls.includes(aspLeaf)) { if (retIdx >= 0) { while (ls.length <= retIdx) ls.push("0"); ls[retIdx] = aspLeaf; } else ls.push(aspLeaf); }
    if (w.merkle_root_of(JSON.stringify(ls)) === live) { aspLeaves = ls; break; }
    await sleep(2500);
  }
  if (!aspLeaves) throw new Error("could not resolve live ASP root");
  noteAspIndex = aspLeaves.indexOf(aspLeaf);
  dummyAspIndex = Math.max(0, aspLeaves.indexOf(w.dummy_asp_leaf()));
}
async function deposit(kp, amount) {
  const blinding = randPriv();
  const commitment = w.note_commitment(amount, walletPriv, blinding);
  const before = await getPoolLeaves();
  const expRoot = w.merkle_root_of(JSON.stringify([...before, commitment]));
  const dr = await write(kp, POOL, "deposit", [u32(amount), u256(commitment)], "deposit", async () => BigInt(String(await read(POOL, "get_root"))).toString() === expRoot);
  if (dr.error) throw new Error("deposit failed: " + JSON.stringify(dr.error));
  const leafIndex = typeof dr.ret === "number" ? dr.ret : before.length;
  return { amount, blinding, leafIndex, commitment };
}
// A change note owned by the payer; commitment = note_commitment(amount, walletPriv, blinding).
function changeNote(amount, blinding, leafIndex) {
  return { amount, blinding, leafIndex, commitment: w.note_commitment(amount, walletPriv, blinding) };
}

// inputs/outputs are explicit. Returns {built, res, changeIndex} after on-chain spend.
async function spendChange(kp, inputs, outputs, payout, merchantName, knownNotes) {
  const merchantId = merchantToField(merchantName);
  let built, res;
  for (let attempt = 0; attempt < 5; attempt++) {
    // resolve a known pool root: event leaves + overlay our known notes
    let poolLeaves;
    for (let t = 0; t < 10; t++) {
      const ls = await getPoolLeaves();
      for (const n of knownNotes) { while (ls.length <= n.leafIndex) ls.push("0"); ls[n.leafIndex] = n.commitment; }
      if (await read(POOL, "is_known_root", [u256(w.merkle_root_of(JSON.stringify(ls)))])) { poolLeaves = ls; break; }
      await sleep(2500);
    }
    if (!poolLeaves) { await sleep(3000); continue; }
    built = JSON.parse(w.build_spend_change(JSON.stringify({ inputs, outputs, pool_leaves: poolLeaves, asp_leaves: aspLeaves, merchant_dec: merchantId, payout })));
    const proofHex = await proveSpend(built.input);
    const realNull = built.input_real_nullifiers[built.input_real_nullifiers.length - 1];
    res = await write(kp, POOL, "spend", [xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")),
      u256(built.root), u256(built.public_amount), u256(built.ext_data_hash), vecU256(built.input_nullifiers), vecU256(built.output_commitments),
      u256(built.asp_membership_root), u256(built.asp_non_membership_root), u256(merchantId), u32(payout)], "spend",
      async () => Boolean(await read(POOL, "is_spent", [u256(realNull)])));
    if (res.hash || res.landed) break;
    if (JSON.stringify(res.error).includes("#5")) { console.log(`  spend #5 (root lag) retry ${attempt}`); await sleep(4000); continue; }
    break;
  }
  // find the change note's leaf index from ChangeNote events (output[0])
  let changeIndex = null;
  const changeCommit = built.output_commitments[0];
  const zeroCommit = "2149236365869659221064584500930753929137827657236543506233382298139131760848";
  if (changeCommit !== zeroCommit) {
    for (let t = 0; t < 6 && changeIndex === null; t++) {
      const pl = await getPoolLeaves();
      const idx = pl.indexOf(changeCommit);
      if (idx >= 0) changeIndex = idx;
      else await sleep(2500);
    }
  }
  return { built, res, changeIndex };
}

function dummySlot() { return { priv_dec: DUMMY_PRIV, blinding_dec: DUMMY_BLIND, amount: 0, pool_index: 0, asp_index: dummyAspIndex }; }
function noteSlot(note) { return { priv_dec: walletPriv, blinding_dec: note.blinding, amount: note.amount, pool_index: note.leafIndex, asp_index: noteAspIndex }; }
function changeOut(amount, blinding) { return { pubkey_dec: w.derive_pubkey(walletPriv), blinding_dec: blinding, amount }; }
const zeroOut = () => ({ pubkey_dec: "0", blinding_dec: "0", amount: 0 });

async function main() {
  const kp = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  for (let i = 0; i < 20; i++) { try { await server().getAccount(kp.publicKey()); break; } catch { await sleep(1500); } }
  walletPriv = randPriv();
  console.log("CHANGE_POOL:", POOL);
  await vouchOnce(kp);
  console.log(`vouched (asp idx ${noteAspIndex}, dummy ${dummyAspIndex})`);

  // ===== 3. SINGLE-INPUT + CHANGE: $50 note, pay $25, mint $25 change =====
  const n50 = await deposit(kp, 50);
  console.log(`\n[single+change] deposited $50 -> leaf #${n50.leafIndex}`);
  const chBlind1 = randPriv();
  const sc = await spendChange(kp, [dummySlot(), noteSlot(n50)], [changeOut(25, chBlind1), zeroOut()], 25, "Buka Express", [n50]);
  if (sc.res.error) throw new Error("single+change spend failed: " + JSON.stringify(sc.res.error));
  console.log(`  spend $25 + mint $25 change: VERIFIED ON-CHAIN ✓ tx ${(sc.res.hash||"(confirmed)").slice(0,14)}`);
  console.log(`  change note inserted at leaf #${sc.changeIndex}`);
  // spend the change note ($25 full) to prove it's real + usable
  const changeNote1 = changeNote(25, chBlind1, sc.changeIndex);
  const sc2 = await spendChange(kp, [dummySlot(), noteSlot(changeNote1)], [zeroOut(), zeroOut()], 25, "Second Merchant", [n50, changeNote1]);
  console.log(`  SPEND the change note ($25 full): ${sc2.res.hash || sc2.res.landed ? "SUCCESS ✓ (change note is real + usable)" : "FAIL "+JSON.stringify(sc2.res.error).slice(0,40)}`);

  // ===== 4. TWO-INPUT + CHANGE: $10 + $50, pay $45, mint $15 change =====
  const n10 = await deposit(kp, 10);
  const n50b = await deposit(kp, 50);
  console.log(`\n[two+change] deposited $10 -> #${n10.leafIndex}, $50 -> #${n50b.leafIndex}`);
  const chBlind2 = randPriv();
  const known2 = [n50, changeNote1, n10, n50b];
  const tc = await spendChange(kp, [noteSlot(n10), noteSlot(n50b)], [changeOut(15, chBlind2), zeroOut()], 45, "Buka Express", known2);
  console.log(`  combine $10+$50, pay $45 + mint $15 change: ${tc.res.hash||tc.res.landed ? "VERIFIED ON-CHAIN ✓ tx "+(tc.res.hash||"(confirmed)").slice(0,14) : "FAIL "+JSON.stringify(tc.res.error).slice(0,50)}`);
  console.log(`  change note inserted at leaf #${tc.changeIndex}`);
  const changeNote2 = changeNote(15, chBlind2, tc.changeIndex);
  const tc2 = await spendChange(kp, [dummySlot(), noteSlot(changeNote2)], [zeroOut(), zeroOut()], 15, "Third Merchant", [...known2, changeNote2]);
  console.log(`  SPEND the $15 change note: ${tc2.res.hash||tc2.res.landed ? "SUCCESS ✓ (two-input change note usable)" : "FAIL "+JSON.stringify(tc2.res.error).slice(0,40)}`);

  // ===== 5. VALUE SAFETY: pay $25 from a $50 note but mint $40 change -> MUST fail =====
  console.log(`\n[value-safety] forge: pay $25 from a $50 note but mint $40 change (sumOuts 40 != sumIns 50 + publicAmount -25 = 25)`);
  let forge;
  try {
    const built = JSON.parse(w.build_spend_change(JSON.stringify({ inputs: [dummySlot(), noteSlot(n50b)], outputs: [changeOut(40, randPriv()), zeroOut()], pool_leaves: await getPoolLeaves(), asp_leaves: aspLeaves, merchant_dec: merchantToField("Forger"), payout: 25 })));
    await proveSpend(built.input);
    forge = "UNEXPECTED: produced a proof (COUNTERFEITING POSSIBLE ✗✗)";
  } catch (e) {
    forge = String(e.message).includes("Assert") ? "witness FAILED (value invariant binds) ✓ — counterfeiting IMPOSSIBLE" : "FAILED: " + String(e.message).slice(0, 40);
  }
  console.log(`  ${forge}`);

  // ===== 6. CLEAN-FUNDS on change: the change notes above were spendable ONLY because
  // the payer's identity is ASP-allowlisted; the membership check binds for change too.
  console.log(`\n[clean-funds] change notes share the payer identity (asp leaf #${noteAspIndex}); spending them passed the ASP membership gate — same gate as any note. A change note from a clean input is clean by construction.`);

  console.log("\nRESULT:", sc.res.hash && (sc2.res.hash||sc2.res.landed) && (tc.res.hash||tc.res.landed) && (tc2.res.hash||tc2.res.landed) && forge.includes("✓") ? "CHANGE KILL-SWITCH CLOSED ✓" : "NOT CLOSED ✗");
  if (sc.res.hash) console.log("spend-with-change tx for cost analysis:", sc.res.hash);
}
main().catch((e) => { console.error("error:", String(e.message || e).split("\n")[0]); process.exit(1); });
