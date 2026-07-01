// Phase R2-0 — REAL USDC rail kill switch (headless, throwaway pool).
// Proves: onboarding (XLM friendbot -> USDC trustline -> DEX swap to USDC),
// deposit PULLS real USDC user->pool + creates the note, spend SENDS real USDC
// pool->merchant for the payout (change stays a private note), and accounting
// safety (a spend cannot extract more USDC than the note it burns).
//
// Does NOT touch the live demo pool/config — uses the throwaway R2 contracts.
import * as w from "../wasm-witness/pkg-node/cowrie_wasm.js";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import {
  Account, Asset, Contract, Keypair, Operation, TransactionBuilder,
  nativeToScVal, scValToNative, rpc, xdr, Address, Horizon,
} from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const NET = "Test SDF Network ; September 2015";
const POOL = fs.readFileSync("/tmp/r2_pool.txt", "utf8").trim();
const ASP = fs.readFileSync("/tmp/r2_asp.txt", "utf8").trim();
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const C = "/Users/minos/Projects/cowrie/circuits";
const ADMIN = fs.readFileSync(".env.local", "utf8").match(/ASP_ADMIN_SECRET=(\S+)/)[1];
const SCALE = 10_000_000n; // USDC 7 decimals

const server = () => new rpc.Server(RPC);
const horizon = () => new Horizon.Server(HORIZON);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u256 = (d) => nativeToScVal(BigInt(d), { type: "u256" });
const vecU256 = (a) => xdr.ScVal.scvVec(a.map(u256));
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const addr = (g) => Address.fromString(g).toScVal();
const be32 = (d) => { let x = BigInt(d); const o = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const randPriv = () => { const b = Buffer.alloc(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); return BigInt("0x" + b.toString("hex")).toString(); };
const merchantToField = (name) => { let h = 0n; for (const ch of name.trim()) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 200n); return (h === 0n ? 12648430n : h).toString(); };
const log = (...a) => console.log(...a);
const DUMMY_PRIV = "9001", DUMMY_BLIND = "9002";

async function fund(pub) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await fetch(`https://friendbot.stellar.org?addr=${pub}`).catch(() => {});
    for (let i = 0; i < 14; i++) { try { await server().getAccount(pub); return; } catch { await sleep(1500); } }
    await sleep(2000); // friendbot may have rate-limited — back off and retry
  }
  throw new Error("friendbot timeout");
}
// USDC balance of a classic G-account (from Horizon). Retries — Horizon hiccups
// must not be read as a zero balance (that corrupts delta math).
async function usdcOf(pub) {
  for (let i = 0; i < 6; i++) {
    try {
      const acc = await horizon().loadAccount(pub);
      const b = acc.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === USDC_ISSUER);
      return b ? BigInt(Math.round(parseFloat(b.balance) * 1e7)) : 0n;
    } catch { await sleep(1500); }
  }
  throw new Error("usdcOf: Horizon unreachable for " + pub.slice(0, 8));
}
// USDC balance of a contract C-address (via the SAC's balance()).
async function usdcOfContract(cid) {
  const s = server();
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: "100", networkPassphrase: NET })
    .addOperation(new Contract(USDC_SAC).call("balance", addr(cid))).setTimeout(30).build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return 0n;
  return BigInt(scValToNative(sim.result.retval));
}
// classic op submit (changeTrust / path payment) via Horizon.
async function classic(kp, op) {
  const h = horizon();
  const acc = await h.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  tx.sign(kp);
  return h.submitTransaction(tx);
}
async function read(cid, m, args = []) {
  const s = server();
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: "100", networkPassphrase: NET })
    .addOperation(new Contract(cid).call(m, ...args)).setTimeout(30).build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(m + ": " + sim.error);
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}
// soroban write with confirm-before-retry; returns {hash, ret, fee, cpu}.
async function write(kp, cid, m, args, confirm) {
  for (let a = 0; a < 6; a++) {
    if (a > 0 && confirm && (await confirm().catch(() => false))) return { landed: true };
    try {
      const s = server();
      const acct = await s.getAccount(kp.publicKey());
      let tx = new TransactionBuilder(acct, { fee: "5000000", networkPassphrase: NET }).addOperation(new Contract(cid).call(m, ...args)).setTimeout(90).build();
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
      let cpu = null;
      tx = rpc.assembleTransaction(tx, sim).build(); tx.sign(kp);
      const send = await s.sendTransaction(tx);
      if (send.status === "ERROR") { let c = "?"; try { c = send.errorResult?.result()?.switch()?.name; } catch {} throw new Error("send " + c); }
      for (let i = 0; i < 40; i++) {
        const g = await s.getTransaction(send.hash);
        if (g.status === "SUCCESS") {
          let fee = null; try { fee = g.resultXdr?.feeCharged?.()?.toString(); } catch {}
          let icpu = cpu; try { icpu = g.envelopeXdr.v1().tx().ext().sorobanData().resources().instructions(); } catch {}
          return { hash: send.hash, ret: g.returnValue ? scValToNative(g.returnValue) : undefined, fee, cpu: icpu };
        }
        if (g.status === "FAILED") throw new Error("FAILED " + send.hash.slice(0, 8));
        await sleep(1500);
      }
    } catch (e) { log(`  ${m} flake ${a}: ${String(e.message).slice(0, 40)}`); await sleep(2500); }
  }
  if (confirm && (await confirm().catch(() => false))) return { landed: true };
  return { error: "exhausted" };
}
async function getPoolLeaves() {
  const s = server(); const latest = (await s.getLatestLedger()).sequence; const byIndex = new Map(); let cursor;
  for (let p = 0; p < 20; p++) {
    const res = await s.getEvents(cursor ? { filters: [{ type: "contract", contractIds: [POOL] }], cursor, limit: 200 } : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [POOL] }], limit: 200 });
    for (const ev of res.events) { const v = scValToNative(ev.value); if (v && v.index !== undefined && v.commitment !== undefined) byIndex.set(Number(v.index), BigInt(v.commitment).toString()); }
    if (res.events.length < 200) break; cursor = res.cursor;
  }
  const max = byIndex.size ? Math.max(...byIndex.keys()) : -1; const out = []; for (let i = 0; i <= max; i++) out.push(byIndex.get(i) ?? "0"); return out;
}
async function getAspLeaves() {
  const s = server(); const latest = (await s.getLatestLedger()).sequence; const byIndex = new Map(); let cursor;
  for (let p = 0; p < 20; p++) {
    const res = await s.getEvents(cursor ? { filters: [{ type: "contract", contractIds: [ASP] }], cursor, limit: 200 } : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [ASP] }], limit: 200 });
    for (const ev of res.events) { const v = scValToNative(ev.value); if (v && v.index !== undefined && v.leaf !== undefined) byIndex.set(Number(v.index), BigInt(v.leaf).toString()); }
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
async function vouch() {
  const adminKp = Keypair.fromSecret(ADMIN);
  const aspLeaf = w.asp_leaf_for(walletPriv);
  // FRESH ASP: leaves are deterministically [dummy@0, user@1] after one add. No
  // event reconstruction (laggy) — the leaf set is known, and get_root (a live
  // simulation read) tells us when the add has landed.
  const dummy = w.dummy_asp_leaf();
  const vch = await write(adminKp, ASP, "admin_add", [u256(aspLeaf)],
    async () => (await getAspLeaves()).includes(aspLeaf));
  const retIdx = typeof vch.ret === "number" ? vch.ret : -1;
  for (let t = 0; t < 24; t++) {
    const live = BigInt(String(await read(ASP, "get_root"))).toString();
    // pristine ASP fast-path: leaves are exactly [dummy, user]
    const cand = [dummy, aspLeaf];
    if (w.merkle_root_of(JSON.stringify(cand)) === live) { aspLeaves = cand; noteAspIndex = 1; dummyAspIndex = 0; return; }
    // general case: reconstruct from events, overlay dummy@0 + user@retIdx
    const ls = [...(await getAspLeaves())];
    ls[0] = dummy;
    if (retIdx >= 0) { while (ls.length <= retIdx) ls.push("0"); ls[retIdx] = aspLeaf; }
    else if (!ls.includes(aspLeaf)) ls.push(aspLeaf);
    for (let i = 0; i < ls.length; i++) if (ls[i] === undefined) ls[i] = "0";
    if (w.merkle_root_of(JSON.stringify(ls)) === live) {
      aspLeaves = ls; noteAspIndex = ls.indexOf(aspLeaf); dummyAspIndex = Math.max(0, ls.indexOf(dummy)); return;
    }
    await sleep(3000);
  }
  throw new Error("asp root unresolved");
}
function noteSlot(n) { return { priv_dec: walletPriv, blinding_dec: n.blinding, amount: n.amount, pool_index: n.leafIndex, asp_index: noteAspIndex }; }
const dummySlot = () => ({ priv_dec: DUMMY_PRIV, blinding_dec: DUMMY_BLIND, amount: 0, pool_index: 0, asp_index: dummyAspIndex });

const EMPTY_POOL_ROOT = "2302223575749844940221218608817648865122641281382153518325924961250440546344";
async function resolvePool(known) {
  for (let t = 0; t < 12; t++) {
    const ls = await getPoolLeaves();
    for (const n of known) { while (ls.length <= n.leafIndex) ls.push("0"); ls[n.leafIndex] = n.commitment; }
    const root = w.merkle_root_of(JSON.stringify(ls));
    // Never resolve on the empty-tree root — our deposited note(s) must be
    // reflected (guards against the first-deposit event-lag race that yields a
    // root the contract knows from init but that omits our note → spend #5).
    if (root !== EMPTY_POOL_ROOT && await read(POOL, "is_known_root", [u256(root)])) return ls;
    await sleep(2500);
  }
  throw new Error("pool root unresolved");
}

async function main() {
  const R = {};
  log("R2 POOL:", POOL, "\nR2 ASP:", ASP, "\nUSDC SAC:", USDC_SAC);

  // ===== ONBOARDING =====
  const user = Keypair.random();
  const merchant = Keypair.random();
  walletPriv = randPriv();
  log("\n[onboard] user", user.publicKey().slice(0, 8), "merchant", merchant.publicKey().slice(0, 8));
  await fund(user.publicKey());
  await fund(merchant.publicKey());
  log("[onboard] friendbot XLM ✓");
  // USDC trustlines
  await classic(user, Operation.changeTrust({ asset: USDC }));
  await classic(merchant, Operation.changeTrust({ asset: USDC }));
  log("[onboard] USDC trustlines ✓");
  // user buys USDC on the DEX (strict-receive 100 USDC, send up to 300 XLM)
  await classic(user, Operation.pathPaymentStrictReceive({
    sendAsset: Asset.native(), sendMax: "300", destination: user.publicKey(),
    destAsset: USDC, destAmount: "100", path: [],
  }));
  const userUsdc0 = await usdcOf(user.publicKey());
  R.onboarding = { user_usdc: (Number(userUsdc0) / 1e7).toFixed(2), method: "friendbot XLM -> changeTrust USDC -> pathPaymentStrictReceive (DEX swap)" };
  log(`[onboard] user USDC = ${R.onboarding.user_usdc} ✓`);
  if (userUsdc0 < 5n * SCALE) throw new Error("onboarding got insufficient USDC");

  await vouch();
  log(`[vouch] asp idx ${noteAspIndex}, dummy ${dummyAspIndex}`);

  // ===== DEPOSIT $5 — real USDC user -> pool + note created =====
  const userBefore = await usdcOf(user.publicKey());
  const poolBefore = await usdcOfContract(POOL);
  const blind5 = randPriv();
  const commit5 = w.note_commitment(5, walletPriv, blind5);
  const before = await getPoolLeaves();
  const expRoot = w.merkle_root_of(JSON.stringify([...before, commit5]));
  log("\n[deposit] $5 — pulling real USDC user->pool …");
  const dep = await write(user, POOL, "deposit", [addr(user.publicKey()), u32(5), u256(commit5)],
    async () => BigInt(String(await read(POOL, "get_root"))).toString() === expRoot);
  if (dep.error) throw new Error("deposit failed: " + JSON.stringify(dep.error));
  const leaf5 = typeof dep.ret === "number" ? dep.ret : before.length;
  const userAfter = await usdcOf(user.publicKey());
  const poolAfter = await usdcOfContract(POOL);
  R.deposit = {
    tx: dep.hash, leaf: leaf5,
    user_usdc_delta: (Number(userAfter - userBefore) / 1e7).toFixed(2),
    pool_usdc_delta: (Number(poolAfter - poolBefore) / 1e7).toFixed(2),
    cpu: dep.cpu, fee_stroops: dep.fee,
  };
  log(`[deposit] tx ${dep.hash?.slice(0, 12)} leaf #${leaf5}  userΔ=${R.deposit.user_usdc_delta} poolΔ=${R.deposit.pool_usdc_delta} cpu=${dep.cpu}`);
  const note5 = { amount: 5, blinding: blind5, leafIndex: leaf5, commitment: commit5 };

  // ===== SPEND $3 to merchant (mint $2 change) — real USDC pool -> merchant =====
  const merchBefore = await usdcOf(merchant.publicKey());
  const poolBeforeSpend = await usdcOfContract(POOL);
  const merchantId = merchantToField("Buka Express");
  const chBlind = randPriv();
  const payerPk = w.derive_pubkey(walletPriv);
  const poolLeaves = await resolvePool([note5]);
  const built = JSON.parse(w.build_spend_change(JSON.stringify({
    inputs: [dummySlot(), noteSlot(note5)],
    outputs: [{ pubkey_dec: payerPk, blinding_dec: chBlind, amount: 2 }, { pubkey_dec: "0", blinding_dec: "0", amount: 0 }],
    pool_leaves: poolLeaves, asp_leaves: aspLeaves, merchant_dec: merchantId, payout: 3,
  })));
  log("\n[spend] $3 payout + $2 change — proving …");
  const liveRoot = BigInt(String(await read(POOL, "get_root"))).toString();
  const knownBuilt = await read(POOL, "is_known_root", [u256(built.root)]);
  log(`  diag: built.root=${built.root.slice(0, 14)} poolRoot=${liveRoot.slice(0, 14)} is_known(built.root)=${knownBuilt} poolLeaves=${JSON.stringify(poolLeaves.map((x) => x.slice(0, 6)))}`);
  const proofHex = await proveSpend(built.input);
  const realNull = built.input_nullifiers[1];
  const sp = await write(user, POOL, "spend", [
    xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")), u256(built.root), u256(built.public_amount), u256(built.ext_data_hash),
    vecU256(built.input_nullifiers), vecU256(built.output_commitments), u256(built.asp_membership_root), u256(built.asp_non_membership_root),
    u256(merchantId), u32(3), addr(merchant.publicKey()),
  ], async () => Boolean(await read(POOL, "is_spent", [u256(realNull)])));
  if (sp.error) throw new Error("spend failed: " + JSON.stringify(sp.error));
  const merchAfter = await usdcOf(merchant.publicKey());
  const poolAfterSpend = await usdcOfContract(POOL);
  R.spend = {
    tx: sp.hash, payout: 3, change: 2,
    merchant_usdc_delta: (Number(merchAfter - merchBefore) / 1e7).toFixed(2),
    pool_usdc_delta: (Number(poolAfterSpend - poolBeforeSpend) / 1e7).toFixed(2),
    cpu: sp.cpu, fee_stroops: sp.fee,
  };
  log(`[spend] tx ${sp.hash?.slice(0, 12)}  merchantΔ=${R.spend.merchant_usdc_delta} poolΔ=${R.spend.pool_usdc_delta} cpu=${sp.cpu}`);

  // change note (the $2) leaf index
  let chIdx = built.output_commitments[0] === "2149236365869659221064584500930753929137827657236543506233382298139131760848" ? -1 : null;
  for (let t = 0; t < 6 && chIdx === null; t++) { const pl = await getPoolLeaves(); const i = pl.indexOf(built.output_commitments[0]); if (i >= 0) chIdx = i; else await sleep(2500); }

  // ===== ACCOUNTING SAFETY =====
  // (1) pool USDC now equals outstanding note value ($2 change note).
  const poolNow = await usdcOfContract(POOL);
  R.accounting = {
    pool_usdc_now: (Number(poolNow) / 1e7).toFixed(2),
    outstanding_notes_value: "2.00",
    balanced: poolNow === 2n * SCALE,
  };
  log(`\n[accounting] pool USDC = $${R.accounting.pool_usdc_now}, outstanding notes = $2.00, balanced=${R.accounting.balanced}`);

  // (2) over-payout MUST be impossible: try to pay $5 from the $2 change note.
  const chNote = { amount: 2, blinding: chBlind, leafIndex: chIdx, commitment: built.output_commitments[0] };
  let overpay;
  try {
    const pl2 = await resolvePool([note5, chNote]);
    const forged = JSON.parse(w.build_spend_change(JSON.stringify({
      inputs: [dummySlot(), noteSlot(chNote)],
      outputs: [{ pubkey_dec: payerPk, blinding_dec: randPriv(), amount: 0 }, { pubkey_dec: "0", blinding_dec: "0", amount: 0 }],
      pool_leaves: pl2, asp_leaves: aspLeaves, merchant_dec: merchantToField("Thief"), payout: 5, // pay $5 from a $2 note
    })));
    await proveSpend(forged.input);
    overpay = "UNEXPECTED: produced a proof (UNSAFE ✗)";
  } catch (e) {
    overpay = String(e.message).includes("Assert") ? "witness FAILED — cannot pay more than the note (value conservation) ✓" : "FAILED: " + String(e.message).slice(0, 50);
  }
  R.accounting.overpay_blocked = overpay;
  log(`[accounting] over-payout $5 from $2 note: ${overpay}`);

  // (3) the $2 change note is spendable for its real value (pay $2 to merchant).
  const merchB2 = await usdcOf(merchant.publicKey());
  const pl3 = await resolvePool([note5, chNote]);
  const built2 = JSON.parse(w.build_spend_change(JSON.stringify({
    inputs: [dummySlot(), noteSlot(chNote)],
    outputs: [{ pubkey_dec: "0", blinding_dec: "0", amount: 0 }, { pubkey_dec: "0", blinding_dec: "0", amount: 0 }],
    pool_leaves: pl3, asp_leaves: aspLeaves, merchant_dec: merchantId, payout: 2,
  })));
  const proof2 = await proveSpend(built2.input);
  const realNull2 = built2.input_nullifiers[1];
  const sp2 = await write(user, POOL, "spend", [
    xdr.ScVal.scvBytes(Buffer.from(proof2, "hex")), u256(built2.root), u256(built2.public_amount), u256(built2.ext_data_hash),
    vecU256(built2.input_nullifiers), vecU256(built2.output_commitments), u256(built2.asp_membership_root), u256(built2.asp_non_membership_root),
    u256(merchantId), u32(2), addr(merchant.publicKey()),
  ], async () => Boolean(await read(POOL, "is_spent", [u256(realNull2)])));
  const merchAfter2 = await usdcOf(merchant.publicKey());
  const poolFinal = await usdcOfContract(POOL);
  R.accounting.change_spent = { ok: Boolean(sp2.hash || sp2.landed), merchant_delta: (Number(merchAfter2 - merchB2) / 1e7).toFixed(2), pool_final_usdc: (Number(poolFinal) / 1e7).toFixed(2) };
  log(`[accounting] change note spent: merchantΔ=${R.accounting.change_spent.merchant_delta}, pool final USDC=$${R.accounting.change_spent.pool_final_usdc} (should be $0.00)`);

  const ok = R.deposit.user_usdc_delta === "-5.00" && R.deposit.pool_usdc_delta === "5.00" &&
    R.spend.merchant_usdc_delta === "3.00" && R.spend.pool_usdc_delta === "-3.00" &&
    R.accounting.balanced && R.accounting.overpay_blocked.includes("✓") &&
    R.accounting.change_spent.ok && R.accounting.change_spent.pool_final_usdc === "0.00";
  R.RESULT = ok ? "USDC RAIL KILL-SWITCH CLOSED ✓" : "NOT CLOSED ✗";
  log("\nRESULTS " + JSON.stringify(R, null, 2));
}
main().catch((e) => { log("error:", String(e.message || e).split("\n")[0]); process.exit(1); });
