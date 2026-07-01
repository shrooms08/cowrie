// Phase R4 — UI cleanup + claimable names + no hardcoded merchant. Extends the
// R3 one-laptop loop with: clean-label assertions, a buyer name claim that
// persists, a merchant created with a CUSTOM name (form starts empty), and a
// grep-style check that no default merchant appears. One context, two pages.
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
    log("pre-provisioning buyer…");
    await provisionBuyer(buyer);
    log(`buyer ready: ${await usdcOf(buyer.publicKey())} USDC`);
    const ctx = await browser.newContext();

    // ===== BUYER: clean labels + claim a custom name =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    await bp.goto(BASE);
    await bp.evaluate((st) => localStorage.setItem("cowrie.wallet.v1", st), walletState(buyer.secret()));
    await bp.reload();
    await bp.locator(".wallet-card .wc-bal", { hasText: "$100" }).waitFor({ timeout: 90000 });

    // CLEAN LABELS
    const walletCardText = await txt(bp.locator(".wallet-card"));
    R.wallet_card_has_account = /account/i.test(walletCardText);
    R.wallet_card_has_helper = /Deposit moves it into your private/i.test(walletCardText);
    R.balance_label = await txt(bp.locator(".balance-row .label"));
    R.honesty_block_present = (await bp.locator(".honesty").count()) > 0;
    R.id_handle = await txt(bp.locator(".wc-addr .wc-k"));
    log(`labels: account?${R.wallet_card_has_account} helper?${R.wallet_card_has_helper} balLabel="${R.balance_label}" honesty?${R.honesty_block_present} handle="${R.id_handle}"`);

    // CLAIM a custom name
    await bp.getByRole("button", { name: "claim name" }).click();
    await bp.getByRole("heading", { name: "Claim your name" }).waitFor({ timeout: 10000 });
    await bp.locator(".claim-entry .input").fill("");
    await bp.locator(".claim-entry .input").fill("mychosen");
    await bp.getByRole("button", { name: /Claim mychosen\.cowrie/ }).click();
    await bp.locator(".wc-addr .wc-k", { hasText: "mychosen.cowrie" }).waitFor({ timeout: 10000 });
    R.claimed_handle = await txt(bp.locator(".wc-addr .wc-k"));
    // persist across reload
    await bp.reload();
    await bp.locator(".wallet-card").waitFor({ timeout: 90000 });
    R.claimed_handle_after_reload = await txt(bp.locator(".wc-addr .wc-k"));
    log(`claimed: ${R.claimed_handle}, after reload: ${R.claimed_handle_after_reload}`);

    // ===== MERCHANT: create with a CUSTOM name (form starts empty) =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.locator(".signin-card").waitFor({ timeout: 15000 });
    R.merchant_input_default = await mp.locator(".signin-card .reg-input").inputValue();
    // no hardcoded merchant anywhere in the signed-out register DOM
    const signedOutText = await txt(mp.locator(".reg-root"));
    R.no_hardcoded_merchant_signedout = !/Buka Express|Test Merchant/i.test(signedOutText);
    log(`merchant form default="${R.merchant_input_default}", no-hardcoded(signedout)=${R.no_hardcoded_merchant_signedout}`);
    await mp.locator(".signin-card .reg-input").fill("Acme Foods");
    await mp.getByRole("button", { name: "Create merchant account" }).click();
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    R.merchant_name = await txt(mp.locator(".mp-name"));
    // persist across reload
    await mp.reload();
    await mp.locator(".merch-panel").waitFor({ timeout: 30000 });
    R.merchant_name_after_reload = await txt(mp.locator(".mp-name"));
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    log(`merchant: ${R.merchant_name}, after reload: ${R.merchant_name_after_reload}`);

    // invoice $25
    await mp.locator(".reg-input.big").fill("42500");
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payLink = await mp.locator(".paylink a.link").getAttribute("href", { timeout: 15000 });
    const addr = new URL(BASE + payLink).searchParams.get("addr");
    const payName = new URL(BASE + payLink).searchParams.get("pay");
    R.invoice_merchant_name = payName;
    const merchBefore = await usdcOf(addr);
    log(`invoice as "${payName}" -> ${addr?.slice(0, 8)}, merchant USDC before ${merchBefore}`);

    // ===== FULL LOOP: buyer deposits + pays =====
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    log("deposited $50");

    await bp.goto(BASE + payLink);
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 15000 });
    await bp.locator(".amount-input").fill("25");
    await bp.waitForTimeout(400);
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 260000 });
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });
    log("paid $25");

    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(addr); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;
    log(`merchant Δ ${R.merchant_usdc_delta}, register flipped ${flipped}`);

    // can't-cover
    await bp.locator(".action.green").click();
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 10000 });
    await bp.locator(".amount-input").fill("100");
    await bp.waitForTimeout(400);
    R.cant_cover = (await bp.locator(".plan.cant").count()) ? (await txt(bp.locator(".plan.cant"))).replace(/\s+/g, " ") : "NOT SHOWN";
    await bp.getByRole("button", { name: "← back" }).first().click().catch(() => {});

    // receipt
    const recLink = bp.locator(".reclink").first();
    if (await recLink.count()) {
      await recLink.click();
      await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
      await bp.getByRole("button", { name: "Generate receipt" }).click();
      await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
      R.receipt_ok = (await bp.locator("textarea.input").inputValue()).startsWith("cowrie-receipt:");
    }
    log(`receipt ok ${R.receipt_ok}`);

    const clean = !R.wallet_card_has_account && !R.wallet_card_has_helper && !R.honesty_block_present &&
      /COWRIE PRIVATE BALANCE/i.test(R.balance_label) && !/in the pool/i.test(R.balance_label);
    const ok = clean && R.id_handle === "ama.cowrie" && R.claimed_handle === "mychosen.cowrie" &&
      R.claimed_handle_after_reload === "mychosen.cowrie" && R.merchant_input_default === "" &&
      R.no_hardcoded_merchant_signedout && R.merchant_name === "Acme Foods" &&
      R.merchant_name_after_reload === "Acme Foods" && R.invoice_merchant_name === "Acme Foods" &&
      R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 && R.register_flipped &&
      /can.?t cover/i.test(R.cant_cover) && R.receipt_ok;
    R.RESULT = ok ? "R4 CLEANUP + CLAIMABLE NAMES ✓" : "INCOMPLETE ✗";
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
