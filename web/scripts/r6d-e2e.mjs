// R6 fix — Verify belongs to the MERCHANT (the recipient who verifies), not the
// buyer. Asserts: buyer nav has NO Verify; merchant register HAS a Verify link;
// full loop — buyer pays + generates a receipt scoped to the merchant, the
// merchant opens Verify from the register, verifies as itself -> success, and as
// a DIFFERENT identity -> rejected. Verify LOGIC untouched (reuses /verify).
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
const mSt = (secret) => JSON.stringify({ stellarSecret: secret, name: "Acme Foods", createdAt: 1 });
const txt = (loc) => loc.textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const buyer = Keypair.random(), merch = Keypair.random();
    await provisionBuyer(buyer);
    await fund(merch.publicKey()); await classic(merch, Operation.changeTrust({ asset: USDC }));
    const NAME = "Acme Foods";
    const rel = `/?pay=${encodeURIComponent(NAME)}&amt=25&addr=${merch.publicKey()}&fiat=42500&cur=NGN&id=COWRIE-1234`;
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });

    // ===== BUYER: no Verify in nav; pay + generate receipt =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    await bp.goto(BASE);
    await bp.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await bp.reload();
    await bp.locator(".wallet-card .wc-bal", { hasText: "$100" }).waitFor({ timeout: 90000 });
    R.buyer_sidenav = await txt(bp.locator(".sidenav"));
    R.buyer_bottomtabs = await txt(bp.locator(".bottom-tabs"));
    R.buyer_nav_has_verify = /verify/i.test(R.buyer_sidenav) || /verify/i.test(R.buyer_bottomtabs);
    R.buyer_verify_links = await bp.locator("a[href='/verify']").count();
    log(`buyer nav: sidenav="${R.buyer_sidenav}" hasVerify=${R.buyer_nav_has_verify} verifyLinks=${R.buyer_verify_links}`);

    // deposit + pay the invoice
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 30000 });
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 280000 });
    log("buyer paid $25");
    // generate a receipt (scoped to the merchant by default)
    await bp.getByRole("button", { name: "Share a receipt" }).click();
    await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
    R.receipt_recipient_default = await bp.locator(".sheet input.input").first().inputValue();
    await bp.getByRole("button", { name: "Generate receipt" }).click();
    await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
    const receipt = await bp.locator("textarea.input").inputValue();
    R.receipt_ok = receipt.startsWith("cowrie-receipt:");
    R.buyer_receipt_no_verify_link = (await bp.locator("a[href='/verify']").count()) === 0;
    log(`receipt generated: ok=${R.receipt_ok} recipientDefault="${R.receipt_recipient_default}" buyerNoVerifyLink=${R.buyer_receipt_no_verify_link}`);

    // ===== MERCHANT: Verify link in register; verify the receipt =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((m) => localStorage.setItem("cowrie.merchant.v1", m), mSt(merch.secret()));
    await mp.reload();
    await mp.locator(".reg-head").waitFor({ timeout: 15000 });
    R.merchant_has_verify_link = (await mp.locator(".reg-verify-link").count()) > 0 && (await mp.locator("a[href='/verify']").count()) > 0;
    log(`merchant register verify link: ${R.merchant_has_verify_link}`);
    // click Verify -> /verify
    await mp.locator(".reg-verify-link").click();
    await mp.waitForURL("**/verify", { timeout: 20000 });
    // paste receipt, verify AS the merchant -> success
    await mp.locator("textarea.input").fill(receipt);
    await mp.locator("input.input").fill(NAME);
    await mp.getByRole("button", { name: "Verify receipt" }).click();
    await mp.locator(".verify-grid h2", { hasText: /Verified|Invalid|Not addressed/ }).waitFor({ timeout: 60000 });
    R.verify_as_merchant = await txt(mp.locator(".verify-grid h2").last());
    R.verify_amount = (await mp.locator(".amt").count()) ? await txt(mp.locator(".amt")) : null;
    log(`verify as "${NAME}": ${R.verify_as_merchant} (${R.verify_amount})`);
    // verify AS a different identity -> rejected
    await mp.locator("input.input").fill("Someone Else");
    await mp.getByRole("button", { name: "Verify receipt" }).click();
    await mp.waitForTimeout(1500);
    await mp.locator(".verify-grid h2", { hasText: /Verified|Invalid|Not addressed/ }).waitFor({ timeout: 60000 });
    R.verify_as_other = await txt(mp.locator(".verify-grid h2").last());
    log(`verify as "Someone Else": ${R.verify_as_other}`);

    const ok = !R.buyer_nav_has_verify && R.buyer_verify_links === 0 && R.buyer_receipt_no_verify_link &&
      R.receipt_ok && R.merchant_has_verify_link && /Verified/.test(R.verify_as_merchant) &&
      R.verify_amount === "$25.00" && /Not addressed/.test(R.verify_as_other);
    R.RESULT = ok ? "R6 VERIFY MOVED TO MERCHANT ✓" : "INCOMPLETE ✗";
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
