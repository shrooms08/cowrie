// Phase R3 — visible buyer wallet + seedless merchant accounts, full one-laptop
// loop. ONE browser context (shared localStorage) with two pages: the merchant
// register and the buyer wallet — proving state separation (cowrie.wallet.v1 vs
// cowrie.merchant.v1 never collide) and the whole loop on real USDC.
//
// The buyer's Stellar account is pre-provisioned in Node (friendbot + trustline +
// DEX) and injected, so the test is reliable against friendbot rate-limiting; the
// in-app buyer onboarding itself is proven by scripts/onboard_diag.mjs. The
// MERCHANT is created live in-app (the new sign-in flow under test).
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

async function fund(pub) { for (let a = 0; a < 5; a++) { await fetch(`https://friendbot.stellar.org?addr=${pub}`).catch(() => {}); for (let i = 0; i < 12; i++) { try { await s.getAccount(pub); return; } catch { await sleep(1500); } } await sleep(2000); } throw new Error("friendbot"); }
async function classic(kp, op) { const acc = await h.loadAccount(kp.publicKey()); const tx = new TransactionBuilder(acc, { fee: "2000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build(); tx.sign(kp); await h.submitTransaction(tx); }
async function usdcOf(pub) { for (let i = 0; i < 6; i++) { try { const acc = await h.loadAccount(pub); const b = acc.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === ISSUER); return b ? parseFloat(b.balance) : 0; } catch (e) { if (e?.response?.status === 404) return 0; await sleep(1500); } } return 0; }
async function provisionBuyer(kp) { await fund(kp.publicKey()); const acc = await h.loadAccount(kp.publicKey()); if (!acc.balances.some((x) => x.asset_code === "USDC")) await classic(kp, Operation.changeTrust({ asset: USDC })); if ((await usdcOf(kp.publicKey())) < 100) await classic(kp, Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: "2000", destination: kp.publicKey(), destAsset: USDC, destAmount: "100", path: [] })); }
const walletState = (secret) => JSON.stringify({ stellarSecret: secret, walletPriv: (() => { const b = new Uint8Array(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x.toString(); })(), handle: "ama", hideBalance: false, notes: [], payments: [] });
const txt = (loc) => loc.textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const buyer = Keypair.random();
    log("pre-provisioning buyer stellar account…");
    await provisionBuyer(buyer);
    R.buyer_usdc_start = await usdcOf(buyer.publicKey());
    log(`buyer ready: ${R.buyer_usdc_start} USDC, addr ${buyer.publicKey().slice(0, 8)}`);

    // ONE context — shared localStorage for both buyer + merchant.
    const ctx = await browser.newContext();

    // ===== MERCHANT PAGE: sign in as "Test Merchant" =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate(() => localStorage.clear());
    await mp.reload();
    // sign-in gate visible (no merchant yet)
    await mp.getByRole("button", { name: "Create merchant account" }).waitFor({ timeout: 15000 });
    R.signin_gate_shown = true;
    await mp.locator(".reg-input").first().fill("Test Merchant");
    await mp.getByRole("button", { name: "Create merchant account" }).click();
    // wait until provisioned (identity panel shows "ready to receive")
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    R.merchant_name = await txt(mp.locator(".mp-name"));
    R.merchant_panel_addr = await txt(mp.locator(".merch-panel .wc-copy"));
    log(`merchant created: ${R.merchant_name}, panel addr ${R.merchant_panel_addr}`);

    // reload → still signed in as Test Merchant (persist)
    await mp.reload();
    await mp.locator(".merch-panel").waitFor({ timeout: 30000 });
    R.merchant_name_after_reload = await txt(mp.locator(".mp-name"));
    R.merchant_addr_after_reload = await txt(mp.locator(".merch-panel .wc-copy"));
    log(`after reload: ${R.merchant_name_after_reload}, addr ${R.merchant_addr_after_reload}`);
    // wait ready again post-reload
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });

    // create a $25 invoice (NGN 42500 / 1700 = $25)
    await mp.locator(".reg-input.big").fill("42500");
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payLink = await mp.locator(".paylink a.link").getAttribute("href", { timeout: 15000 });
    const addr = new URL(BASE + payLink).searchParams.get("addr");
    R.payLink = payLink; R.invoice_addr = addr;
    const merchBefore = await usdcOf(addr);
    R.merchant_usdc_before = merchBefore;
    log(`invoice $25, paylink addr ${addr?.slice(0, 8)}, merchant USDC before ${merchBefore}`);

    // ===== BUYER PAGE (same context): inject pre-provisioned wallet =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    await bp.goto(BASE);
    await bp.evaluate((st) => localStorage.setItem("cowrie.wallet.v1", st), walletState(buyer.secret()));
    await bp.reload();
    // wallet card shows address + public USDC balance
    await bp.locator(".wallet-card .wc-bal", { hasText: "$100" }).waitFor({ timeout: 90000 });
    R.buyer_wallet_bal = await txt(bp.locator(".wallet-card .wc-bal"));
    R.buyer_wallet_addr = await txt(bp.locator(".wallet-card .wc-copy"));
    R.buyer_private_bal_start = await txt(bp.locator(".balance").first());
    log(`buyer wallet card: bal ${R.buyer_wallet_bal}, addr ${R.buyer_wallet_addr}, private ${R.buyer_private_bal_start}`);

    // deposit $50 — wallet (public) DOWN, private UP
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    R.private_bal_after_deposit = await txt(bp.locator(".balance").first());
    // wallet public USDC reflects the deposit leaving (Horizon lags — poll via app)
    await bp.locator(".wallet-card .wc-bal", { hasText: "$50" }).waitFor({ timeout: 40000 });
    R.wallet_bal_after_deposit = await txt(bp.locator(".wallet-card .wc-bal"));
    log(`after deposit: private ${R.private_bal_after_deposit}, wallet ${R.wallet_bal_after_deposit}`);

    // ===== PAY the invoice ($25) =====
    await bp.goto(BASE + payLink);
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 15000 });
    await bp.locator(".amount-input").fill("25");
    await bp.waitForTimeout(400);
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 260000 });
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });
    R.private_bal_after_pay = await txt(bp.locator(".balance").first());
    log(`paid $25, private balance ${R.private_bal_after_pay}`);

    // merchant real USDC delta
    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(addr); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_after = merchAfter; R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    log(`merchant USDC ${merchAfter} (Δ ${R.merchant_usdc_delta})`);

    // register flip (merchant page still polling)
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;
    // merchant panel USDC updated
    R.merchant_panel_usdc_after = await txt(mp.locator(".merch-panel .mp-v").first());
    log(`register flipped ${flipped}, merchant panel USDC ${R.merchant_panel_usdc_after}`);

    // ===== STATE SEPARATION: both keys present, both identities intact =====
    const keys = await bp.evaluate(() => ({ wallet: !!localStorage.getItem("cowrie.wallet.v1"), merchant: !!localStorage.getItem("cowrie.merchant.v1"), mname: JSON.parse(localStorage.getItem("cowrie.merchant.v1") || "{}").name }));
    R.state_separation = keys;
    log(`state separation: ${JSON.stringify(keys)}`);

    // ===== can't-cover =====
    await bp.locator(".action.green").click();
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 10000 });
    await bp.locator(".amount-input").fill("100");
    await bp.waitForTimeout(400);
    R.cant_cover = (await bp.locator(".plan.cant").count()) ? (await txt(bp.locator(".plan.cant"))).replace(/\s+/g, " ") : "NOT SHOWN";
    await bp.getByRole("button", { name: "← back" }).first().click().catch(() => {});
    log(`cant-cover: ${R.cant_cover}`);

    // ===== receipt =====
    const recLink = bp.locator(".reclink").first();
    if (await recLink.count()) {
      await recLink.click();
      await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
      await bp.getByRole("button", { name: "Generate receipt" }).click();
      await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
      R.receipt_ok = (await bp.locator("textarea.input").inputValue()).startsWith("cowrie-receipt:");
    }
    log(`receipt ok ${R.receipt_ok}`);

    const ok = R.signin_gate_shown && R.merchant_name === "Test Merchant" && R.merchant_name_after_reload === "Test Merchant" &&
      R.merchant_addr_after_reload === R.merchant_panel_addr && R.buyer_wallet_bal?.includes("$100") &&
      R.wallet_bal_after_deposit?.includes("$50") && R.private_bal_after_deposit?.includes("$50") &&
      R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 && R.register_flipped &&
      R.state_separation.wallet && R.state_separation.merchant && R.state_separation.mname === "Test Merchant" &&
      /can.?t cover/i.test(R.cant_cover) && R.receipt_ok && R.private_bal_after_pay?.includes("$25");
    R.RESULT = ok ? "R3 ONE-LAPTOP LOOP ✓" : "INCOMPLETE ✗";
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
