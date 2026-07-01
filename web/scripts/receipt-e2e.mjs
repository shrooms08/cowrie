// Phase D0 — payment-receipt selective disclosure (Claim A), headless against
// testnet. Does a REAL spend (capturing the note secrets), then proves a receipt
// "I am the payer of this SpendEvent, disclosed to recipient R" and verifies it
// on-chain. Plus the three negative tests (no-secret, wrong-recipient, wrong-amount).
import * as w from "../wasm-witness/pkg-node/cowrie_wasm.js";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import {
  Account, Contract, Keypair, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr,
} from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
const NET = "Test SDF Network ; September 2015";
const POOL = "CBMJYKQOYJWGPYVLNYCBRGOW3EPYB6GWPNQVVRV2WAQO3JOWWL5JUTEK";
const ASP = "CB2Y7XOOYPGIZU5QZYYLLR7UXPP7L3D3FMXD7GFCYT42TKT6AKRMJAMU";
const RECEIPT_VERIFIER = fs.readFileSync("/tmp/receipt_vid.txt", "utf8").trim();
const C = "/Users/minos/Projects/cowrie/circuits";
const ADMIN = fs.readFileSync(".env.local", "utf8").match(/ASP_ADMIN_SECRET=(\S+)/)[1];

const server = () => new rpc.Server(RPC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u256 = (d) => nativeToScVal(BigInt(d), { type: "u256" });
const vecU256 = (a) => xdr.ScVal.scvVec(a.map(u256));
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const merchantToField = (name) => { let h = 0n; for (const ch of name.trim()) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 200n); return (h === 0n ? 12648430n : h).toString(); };
const be32 = (d) => { let x = BigInt(d); const o = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

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
async function proveSpend(input) {
  const wc = await (await import(`${C}/build/policy_tx_2_2_js/witness_calculator.js`)).default(fs.readFileSync(`${C}/build/policy_tx_2_2_js/policy_tx_2_2.wasm`));
  const wtns = await wc.calculateWTNSBin(input, 0);
  const { proof } = await groth16.prove(new Uint8Array(fs.readFileSync(`${C}/build/keys/policy_final.zkey`)), new Uint8Array(wtns));
  return Buffer.concat([be32(proof.pi_a[0]), be32(proof.pi_a[1]), be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]), be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]), be32(proof.pi_c[0]), be32(proof.pi_c[1])]).toString("hex");
}
// Receipt proving: paymentReceipt circuit (small), two-step, then Soroban bytes.
async function proveReceipt(input) {
  const wc = await (await import(`${C}/build/receipt/paymentReceipt_js/witness_calculator.js`)).default(fs.readFileSync(`${C}/build/receipt/paymentReceipt_js/paymentReceipt.wasm`));
  const wtns = await wc.calculateWTNSBin(input, 0);
  const { proof, publicSignals } = await groth16.prove(new Uint8Array(fs.readFileSync(`${C}/build/receipt/receipt_final.zkey`)), new Uint8Array(wtns));
  const proofHex = Buffer.concat([be32(proof.pi_a[0]), be32(proof.pi_a[1]), be32(proof.pi_b[0][1]), be32(proof.pi_b[0][0]), be32(proof.pi_b[1][1]), be32(proof.pi_b[1][0]), be32(proof.pi_c[0]), be32(proof.pi_c[1])]).toString("hex");
  return { proofHex, publicSignals };
}
const randPriv = () => { const b = Buffer.alloc(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); return BigInt("0x" + b.toString("hex")).toString(); };

// Verify a receipt on-chain with an explicit public-input vector (lets us tamper R/merchant).
async function verifyReceiptOnChain(kp, proofHex, pubs /* [nullifier,amount,merchant,recipient] */) {
  const pubBytes = Buffer.concat(pubs.map(be32)).toString("hex");
  const res = await write(kp, RECEIPT_VERIFIER, "verify_bytes",
    [xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")), xdr.ScVal.scvBytes(Buffer.from(pubBytes, "hex"))], "verify");
  return res;
}

async function main() {
  console.log("RECEIPT_VERIFIER:", RECEIPT_VERIFIER);
  // ===== 1. real spend (capture secrets) =====
  const kp = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  for (let i = 0; i < 20; i++) { try { await server().getAccount(kp.publicKey()); break; } catch { await sleep(1500); } }
  const walletPriv = randPriv();
  const adminKp = Keypair.fromSecret(ADMIN);
  const aspLeaf = w.asp_leaf_for(walletPriv);
  const vch = await write(adminKp, ASP, "admin_add", [u256(aspLeaf)], "vouch", async () => (await getLeaves(ASP, "leaf")).includes(aspLeaf));
  const noteAspIndex = typeof vch.ret === "number" ? vch.ret : -1;
  const aspLive = BigInt(String(await read(ASP, "get_root"))).toString();
  let aspLeaves;
  for (let t = 0; t < 8; t++) { const ls = await getLeaves(ASP, "leaf"); if (noteAspIndex >= 0) { while (ls.length <= noteAspIndex) ls.push("0"); ls[noteAspIndex] = aspLeaf; } if (w.merkle_root_of(JSON.stringify(ls)) === aspLive) { aspLeaves = ls; break; } await sleep(2500); }
  const dummyAspIndex = Math.max(0, aspLeaves.indexOf(w.dummy_asp_leaf()));

  const amount = 5;
  const blinding = randPriv();
  const commitment = w.note_commitment(amount, walletPriv, blinding);
  const before = await getLeaves(POOL, "commitment");
  const expRoot = w.merkle_root_of(JSON.stringify([...before, commitment]));
  const dr = await write(kp, POOL, "deposit", [u32(amount), u256(commitment)], "deposit", async () => BigInt(String(await read(POOL, "get_root"))).toString() === expRoot);
  const leafIndex = typeof dr.ret === "number" ? dr.ret : before.length;

  const merchantName = "Buka Express";
  const merchantId = merchantToField(merchantName);
  // resolve a known pool root, build + submit the real spend
  let poolLeaves;
  for (let t = 0; t < 8; t++) { const ls = await getLeaves(POOL, "commitment"); while (ls.length <= leafIndex) ls.push("0"); ls[leafIndex] = commitment; if (await read(POOL, "is_known_root", [u256(w.merkle_root_of(JSON.stringify(ls)))])) { poolLeaves = ls; break; } await sleep(2500); }
  const built = JSON.parse(w.build_spend(walletPriv, blinding, amount, leafIndex, JSON.stringify(poolLeaves), JSON.stringify(aspLeaves), noteAspIndex, dummyAspIndex, merchantId, amount));
  const spendProof = await proveSpend(built.input);
  const sres = await write(kp, POOL, "spend", [xdr.ScVal.scvBytes(Buffer.from(spendProof, "hex")),
    u256(built.root), u256(built.public_amount), u256(built.ext_data_hash), vecU256(built.input_nullifiers), vecU256(built.output_commitments),
    u256(built.asp_membership_root), u256(built.asp_non_membership_root), u256(merchantId), u32(amount)], "spend",
    async () => Boolean(await read(POOL, "is_spent", [u256(built.real_nullifier)])));
  if (sres.error) throw new Error("spend failed: " + JSON.stringify(sres.error));
  const nullifier = built.real_nullifier;
  console.log(`1. REAL spend: nullifier ${nullifier.slice(0,14)}… amount $${amount} merchant ${merchantId.slice(0,10)}… spend tx ${(sres.hash||"(confirmed)").slice(0,12)}`);
  // sanity: note_nullifier(secrets, pathIndices=leafIndex) == published nullifier
  const recomputed = w.note_nullifier(amount, walletPriv, blinding, leafIndex);
  console.log(`   nullifier preimage check (pathIndices=leafIndex=${leafIndex}): ${recomputed === nullifier ? "MATCH ✓" : "MISMATCH ✗"}`);

  // ===== 2. REAL receipt bound to recipient R =====
  const R = merchantToField("alice.bank.receiver");   // the single disclosure target
  const Rprime = merchantToField("mallory.other.party"); // a DIFFERENT recipient
  const recInput = { nullifier, amount: String(amount), merchant: merchantId, recipient: R, privateKey: walletPriv, blinding, pathIndices: String(leafIndex) };
  const { proofHex, publicSignals } = await proveReceipt(recInput);
  console.log(`2. receipt proof built. public order [nullifier,amount,merchant,recipient] = ${JSON.stringify(publicSignals.map(x=>x.slice(0,8)+"…"))}`);
  const okR = await verifyReceiptOnChain(kp, proofHex, [nullifier, String(amount), merchantId, R]);
  console.log(`   on-chain verify (recipient R): ${okR.hash ? "TRUE ✓ tx "+okR.hash : "FAIL "+JSON.stringify(okR.error).slice(0,50)}`);

  // ===== 3. NEGATIVE TESTS =====
  // (a) no-secret: a non-payer (wrong privateKey) cannot build a witness
  let noSecret;
  try { await proveReceipt({ ...recInput, privateKey: randPriv() }); noSecret = "UNEXPECTED: produced a proof"; }
  catch (e) { noSecret = String(e.message).includes("Assert") ? "witness FAILED (Assert) ✓" : "FAILED: " + String(e.message).slice(0, 40); }
  console.log(`3a. no-secret (non-payer): ${noSecret}`);

  // (b) wrong-recipient: present the VALID R-proof with R' in the public vector -> must reject (SECURITY CORE)
  const wrongR = await verifyReceiptOnChain(kp, proofHex, [nullifier, String(amount), merchantId, Rprime]);
  console.log(`3b. wrong-recipient (R-proof presented as R'): ${wrongR.hash ? "ACCEPTED ✗✗ BEARER-REPLAYABLE" : "REJECTED ✓ ("+String(wrongR.error?.message||wrongR.error).match(/#?\d+|Crypto|InvalidInput|InvalidProof/i)?.[0]+")"}`);

  // (c) wrong-amount: claiming a different amount can't reproduce the nullifier -> witness fails
  let wrongAmt;
  try { await proveReceipt({ ...recInput, amount: "10" }); wrongAmt = "UNEXPECTED: produced a proof"; }
  catch (e) { wrongAmt = String(e.message).includes("Assert") ? "witness FAILED (Assert) ✓" : "FAILED: " + String(e.message).slice(0, 40); }
  console.log(`3c. wrong-amount ($10 vs real $5): ${wrongAmt}`);
  // (c2) wrong-merchant: present the valid proof with a different merchant in the vector -> reject
  const wrongM = await verifyReceiptOnChain(kp, proofHex, [nullifier, String(amount), merchantToField("Evil Corp"), R]);
  console.log(`3d. wrong-merchant (proof presented with other merchant): ${wrongM.hash ? "ACCEPTED ✗" : "REJECTED ✓"}`);

  console.log("\nRESULT:", okR.hash && noSecret.includes("✓") && !wrongR.hash && wrongAmt.includes("✓") && !wrongM.hash ? "RECEIPT KILL-SWITCH CLOSED ✓" : "NOT CLOSED ✗");
}
main().catch((e) => { console.error("error:", String(e.message || e).split("\n")[0]); process.exit(1); });
