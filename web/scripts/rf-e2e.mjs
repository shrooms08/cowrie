// UI refinements e2e: (0) rate ₦1,400/$1 everywhere; (1) USDC-primary invoice
// "$5 ≈ ₦7,000"; (2) copyable receipt recipient + Verify pre-fills signed-in
// merchant; (3) clean verify result (amount+merchant+clean, NO buyer identity);
// wrong-recipient rejects. One context, two pages (shared localStorage).
import { chromium } from "playwright";
import { Horizon, Asset, Operation, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
const BASE = "http://localhost:3000";
const NET = "Test SDF Network ; September 2015";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", ISSUER);
const h = new Horizon.Server("https://horizon-testnet.stellar.org");
const s = new rpc.Server("https://soroban-testnet.stellar.org");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fund(p) { for (let a = 0; a < 5; a++) { await fetch(`https://friendbot.stellar.org?addr=${p}`).catch(() => {}); for (let i = 0; i < 12; i++) { try { await s.getAccount(p); return; } catch { await sleep(1500); } } await sleep(2000); } throw new Error("friendbot"); }
async function classic(kp, op) { const acc = await h.loadAccount(kp.publicKey()); const tx = new TransactionBuilder(acc, { fee: "2000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build(); tx.sign(kp); await h.submitTransaction(tx); }
async function usdcOf(p) { for (let i = 0; i < 6; i++) { try { const acc = await h.loadAccount(p); const b = acc.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === ISSUER); return b ? parseFloat(b.balance) : 0; } catch (e) { if (e?.response?.status === 404) return 0; await sleep(1500); } } return 0; }
async function provisionBuyer(kp) { await fund(kp.publicKey()); const acc = await h.loadAccount(kp.publicKey()); if (!acc.balances.some((x) => x.asset_code === "USDC")) await classic(kp, Operation.changeTrust({ asset: USDC })); if ((await usdcOf(kp.publicKey())) < 100) await classic(kp, Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: "2000", destination: kp.publicKey(), destAsset: USDC, destAmount: "100", path: [] })); }
const wSt = (secret) => JSON.stringify({ stellarSecret: secret, walletPriv: "12345", handle: "sade", hideBalance: false, notes: [], payments: [] });
const mSt = (secret, name) => JSON.stringify({ stellarSecret: secret, name, createdAt: 1 });
const txt = (loc) => loc.textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const buyer = Keypair.random(), merch = Keypair.random();
    const MNAME = "Acme Foods";
    await provisionBuyer(buyer);
    await fund(merch.publicKey()); await classic(merch, Operation.changeTrust({ asset: USDC }));
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });

    // ===== MERCHANT: USDC-primary $5 invoice =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((m) => localStorage.setItem("cowrie.merchant.v1", m), mSt(merch.secret(), MNAME));
    await mp.reload();
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    await mp.locator(".uc-input").fill("5"); // type USDC
    await mp.waitForTimeout(300);
    R.merchant_quote_line = (await txt(mp.locator(".quote-line"))).replace(/\s+/g, " ");
    R.usdc_input_label = await txt(mp.locator(".reg-card .field label").first());
    log(`(1) merchant quote-line: "${R.merchant_quote_line}"`);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payUrl = await txt(mp.locator(".paylink a.link"));
    const u = new URL(payUrl);
    R.link_amt = u.searchParams.get("amt");
    R.link_fiat = u.searchParams.get("fiat");
    R.link_cur = u.searchParams.get("cur");
    log(`(0/1) link amt=${R.link_amt} fiat=${R.link_fiat} cur=${R.link_cur}`);

    // ===== BUYER: invoice shows $5 ≈ ₦7,000 at ₦1,400/$1 =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    const rel = payUrl.replace(BASE, "");
    await bp.goto(BASE + rel);
    await bp.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 90000 });
    R.buyer_invoice_amount = (await txt(bp.locator(".invoice-card .inv-amount"))).replace(/\s+/g, " ");
    R.buyer_rate_line = (await txt(bp.locator(".invoice-card .inv-rate"))).replace(/\s+/g, " ");
    log(`(0/1) buyer invoice: "${R.buyer_invoice_amount}" | rate "${R.buyer_rate_line}"`);

    // deposit + pay
    await bp.goto(BASE);
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 30000 });
    await bp.getByRole("button", { name: /^Pay \$5/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 280000 });
    log("buyer paid $5");

    // ===== (2) generate receipt — recipient copyable =====
    await bp.getByRole("button", { name: "Share a receipt" }).click();
    await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
    await bp.getByRole("button", { name: "Generate receipt" }).click();
    await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
    const receipt = await bp.locator("textarea.input").inputValue();
    R.recipient_copy_present = (await bp.locator(".recipient-row .rr-copy").count()) > 0;
    R.recipient_copy_text = R.recipient_copy_present ? await txt(bp.locator(".recipient-row .rr-copy")) : "(none)";
    log(`(2) receipt recipient copyable: ${R.recipient_copy_present} text="${R.recipient_copy_text}"`);

    // ===== (2/3) merchant verifies — pre-filled identity, clean result, no buyer name =====
    await mp.goto(BASE + "/verify");
    R.verify_prefill = await mp.locator("input.input").inputValue();
    log(`(2) verify pre-filled identity: "${R.verify_prefill}"`);
    await mp.locator("textarea.input").fill(receipt);
    // do NOT type identity — it is pre-filled with the signed-in merchant
    await mp.getByRole("button", { name: "Verify receipt" }).click();
    await mp.locator(".verify-grid h2", { hasText: /Verified|Invalid|Not addressed/ }).waitFor({ timeout: 60000 });
    R.verify_result = await txt(mp.locator(".verify-grid h2").last());
    const resultCard = await txt(mp.locator(".verify-grid").last());
    R.verify_amount = (await mp.locator(".amt").count()) ? await txt(mp.locator(".amt")) : null;
    R.verify_shows_merchant = new RegExp(MNAME).test(resultCard);
    R.verify_leaks_buyer = /sade/i.test(resultCard); // buyer handle must NOT appear
    R.verify_privacy_framing = /never revealed/i.test(resultCard);
    log(`(3) verify: "${R.verify_result}" amount=${R.verify_amount} merchant=${R.verify_shows_merchant} leaksBuyer=${R.verify_leaks_buyer} privacyFraming=${R.verify_privacy_framing}`);

    // wrong recipient -> rejected
    await mp.locator("input.input").fill("Someone Else");
    await mp.getByRole("button", { name: "Verify receipt" }).click();
    await mp.waitForTimeout(1500);
    await mp.locator(".verify-grid h2", { hasText: /Verified|Invalid|Not addressed/ }).waitFor({ timeout: 60000 });
    R.verify_wrong = await txt(mp.locator(".verify-grid h2").last());
    log(`wrong recipient: "${R.verify_wrong}"`);

    const ok = R.merchant_quote_line.includes("$5.00 USDC") && R.merchant_quote_line.includes("₦7,000") && R.merchant_quote_line.includes("₦1,400 / $1") &&
      R.usdc_input_label === "Amount (USDC)" && R.link_amt === "5" && R.link_fiat === "7000" && R.link_cur === "NGN" &&
      /\$5\.00 USDC/.test(R.buyer_invoice_amount) && /₦7,000/.test(R.buyer_invoice_amount) && /₦1,400 \/ \$1/.test(R.buyer_rate_line) &&
      R.recipient_copy_present && R.recipient_copy_text.includes(MNAME) &&
      R.verify_prefill === MNAME && /Verified/.test(R.verify_result) && R.verify_amount === "$5.00" &&
      R.verify_shows_merchant && !R.verify_leaks_buyer && R.verify_privacy_framing && /Not addressed/.test(R.verify_wrong);
    R.RESULT = ok ? "UI REFINEMENTS ✓" : "INCOMPLETE ✗";
    log("\nRESULTS " + JSON.stringify(R, null, 2));
  } catch (e) {
    log("ERROR:", e.message);
    log("RESULTS_SO_FAR " + JSON.stringify(R, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
main();
