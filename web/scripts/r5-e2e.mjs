// Phase R5 — buyer wallet vs merchant register are separate experiences.
// Asserts: clean buyer home (no in-wallet merchant link, no settles/fee on the
// ID card, claim button renders un-clipped), standalone merchant register (no
// buyer elements), a working role switch both ways with isolated state, and the
// full one-laptop loop across the role switch.
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
    const buyer = Keypair.random(), merchant = Keypair.random();
    log("pre-provisioning…");
    await provisionBuyer(buyer);
    await fund(merchant.publicKey()); await classic(merchant, Operation.changeTrust({ asset: USDC }));
    const merchBefore = await usdcOf(merchant.publicKey());
    log(`buyer ${await usdcOf(buyer.publicKey())} USDC, merchant ${merchBefore} USDC`);

    const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 } });
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    await bp.goto(BASE);
    await bp.evaluate(([w, m]) => { localStorage.setItem("cowrie.wallet.v1", w); localStorage.setItem("cowrie.merchant.v1", m); }, [wSt(buyer.secret()), mSt(merchant.secret())]);
    await bp.reload();
    await bp.locator(".wallet-card .wc-bal", { hasText: "$100" }).waitFor({ timeout: 90000 });

    // ===== CLEAN BUYER HOME =====
    R.body_has_merchant_link = (await bp.locator(".app a[href='/merchant']").count()) + (await bp.locator(".foot-controls a[href='/merchant']").count());
    R.idcard_has_settles_fee = (await bp.locator(".idcard .foot").count()) > 0 || /settles in|fee/i.test(await txt(bp.locator(".idcard")));
    // claim button renders un-clipped: visible, text "Claim", right edge within the id card
    const claim = bp.locator(".idcard .claim-link");
    R.claim_text = await txt(claim);
    const cb = await claim.boundingBox(), ib = await bp.locator(".idcard").boundingBox();
    R.claim_within_card = !!(cb && ib && cb.x >= ib.x && cb.x + cb.width <= ib.x + ib.width + 1 && cb.width > 20);
    // separated role switch present in sidebar, NOT among wallet nav
    R.sidebar_role_switch = await bp.locator(".side-role .role-switch").count();
    R.walletnav_has_merchant = /merchant/i.test(await txt(bp.locator(".sidenav")));
    log(`clean home: bodyMerchantLink=${R.body_has_merchant_link} settlesFee=${R.idcard_has_settles_fee} claim="${R.claim_text}" withinCard=${R.claim_within_card} roleSwitch=${R.sidebar_role_switch} walletNavHasMerchant=${R.walletnav_has_merchant}`);

    // ===== ROLE SWITCH: buyer -> merchant -> buyer =====
    await bp.locator(".side-role .role-switch").click();
    await bp.waitForURL("**/merchant", { timeout: 20000 });
    await bp.locator(".reg-root").waitFor({ timeout: 15000 });
    R.register_no_buyer_wallet = (await bp.locator(".wallet-card").count()) === 0 && (await bp.locator(".balance-row").count()) === 0;
    R.register_shows_merchant = /Acme Foods/.test(await txt(bp.locator(".reg-root")));
    await bp.locator(".reg-role-switch").click();
    await bp.waitForURL(BASE + "/", { timeout: 20000 });
    await bp.locator(".wallet-card").waitFor({ timeout: 30000 });
    R.switch_back_to_wallet = (await bp.locator(".wallet-card").count()) > 0;
    log(`role switch: registerNoBuyer=${R.register_no_buyer_wallet} registerMerchant=${R.register_shows_merchant} backToWallet=${R.switch_back_to_wallet}`);

    // ===== FULL LOOP across the switch =====
    // merchant page (own tab) creates an invoice
    const mp = await ctx.newPage();
    await mp.goto(BASE + "/merchant");
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    await mp.locator(".reg-input.big").fill("42500"); // $25
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payLink = await mp.locator(".paylink a.link").getAttribute("href", { timeout: 15000 });
    const addr = new URL(BASE + payLink).searchParams.get("addr");
    log(`invoice as Acme Foods -> ${addr?.slice(0, 8)}`);

    // buyer deposits + pays
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    await bp.goto(BASE + payLink);
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 15000 });
    await bp.locator(".amount-input").fill("25");
    await bp.waitForTimeout(400);
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 260000 });
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });
    log("deposited + paid $25");

    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(addr); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;

    // state isolation
    R.state = await bp.evaluate(() => ({ wallet: !!localStorage.getItem("cowrie.wallet.v1"), merchant: JSON.parse(localStorage.getItem("cowrie.merchant.v1") || "{}").name }));

    // receipt
    const recLink = bp.locator(".reclink").first();
    if (await recLink.count()) {
      await recLink.click();
      await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
      await bp.getByRole("button", { name: "Generate receipt" }).click();
      await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
      R.receipt_ok = (await bp.locator("textarea.input").inputValue()).startsWith("cowrie-receipt:");
    }
    log(`merchant Δ ${R.merchant_usdc_delta}, flipped ${R.register_flipped}, state ${JSON.stringify(R.state)}, receipt ${R.receipt_ok}`);

    const ok = R.body_has_merchant_link === 0 && !R.idcard_has_settles_fee && R.claim_text === "Claim" && R.claim_within_card &&
      R.sidebar_role_switch === 1 && !R.walletnav_has_merchant && R.register_no_buyer_wallet && R.register_shows_merchant &&
      R.switch_back_to_wallet && R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 && R.register_flipped &&
      R.state.wallet && R.state.merchant === "Acme Foods" && R.receipt_ok;
    R.RESULT = ok ? "R5 ROLE SEPARATION ✓" : "INCOMPLETE ✗";
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
