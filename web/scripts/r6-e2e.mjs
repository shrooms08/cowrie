// Phase R6 — merchant invoice -> pay-link + QR + pay-ID; buyer loads it, sees the
// amount + local-currency equivalent, pays EXACTLY that amount to EXACTLY that
// address. Verifies no mismatch between invoice and payment. Screenshots both.
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
    log(`buyer ${await usdcOf(buyer.publicKey())} USDC, merchant ${merchBefore} USDC (${merchant.publicKey().slice(0, 8)})`);

    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });

    // ===== MERCHANT: create a ₦42,500 ($25) invoice -> pay-ID + QR + link =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((m) => localStorage.setItem("cowrie.merchant.v1", m), mSt(merchant.secret()));
    await mp.reload();
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    await mp.locator(".reg-input.big").fill("42500");
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    await mp.locator(".qr-frame svg").waitFor({ timeout: 15000 });
    R.qr_rendered = (await mp.locator(".qr-frame svg").count()) > 0;
    R.merchant_payid = await txt(mp.locator(".payid-chip"));
    const payUrl = await txt(mp.locator(".paylink a.link"));
    R.pay_url = payUrl;
    const u = new URL(payUrl);
    R.link_params = { amt: u.searchParams.get("amt"), addr: u.searchParams.get("addr"), fiat: u.searchParams.get("fiat"), cur: u.searchParams.get("cur"), id: u.searchParams.get("id"), pay: u.searchParams.get("pay") };
    R.awaiting_label = await txt(mp.locator(".label.awaiting"));
    await mp.screenshot({ path: "/tmp/r6_merchant.png" });
    log(`merchant: payId=${R.merchant_payid} qr=${R.qr_rendered} link=${payUrl}`);
    // link must carry the exact invoice figures
    R.link_matches_invoice = R.link_params.amt === "25" && R.link_params.addr === merchant.publicKey() && R.link_params.fiat === "42500" && R.link_params.cur === "NGN" && R.link_params.id === R.merchant_payid;

    // ===== BUYER: load the link -> auto-filled invoice + local currency =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    // open the pay-link directly (one-laptop clickable-link flow)
    const rel = payUrl.replace(BASE, "");
    await bp.goto(BASE + rel);
    await bp.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await bp.goto(BASE + rel); // reload with injected wallet + the link
    await bp.locator(".invoice-card").waitFor({ timeout: 90000 });
    R.buyer_invoice_merchant = await txt(bp.locator(".invoice-card .inv-v"));
    R.buyer_invoice_amount = await txt(bp.locator(".invoice-card .inv-amount"));
    R.buyer_invoice_meta = await txt(bp.locator(".invoice-card .inv-meta"));
    R.buyer_no_amount_input = (await bp.locator(".amount-input").count()) === 0; // locked (not editable)
    await bp.screenshot({ path: "/tmp/r6_buyer.png" });
    log(`buyer invoice: merchant="${R.buyer_invoice_merchant}" amount="${R.buyer_invoice_amount}" meta="${R.buyer_invoice_meta}" locked=${R.buyer_no_amount_input}`);
    R.buyer_shows_fiat = /₦42,500/.test(R.buyer_invoice_amount);
    R.buyer_shows_usdc = /\$25\.00 USDC/.test(R.buyer_invoice_amount);
    R.buyer_shows_payid = R.buyer_invoice_meta.includes(R.merchant_payid);

    // deposit $50 then pay the invoice (need funds first)
    await bp.goto(BASE); // home
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    log("deposited $50");
    // reopen the invoice link and pay
    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 30000 });
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 260000 });
    R.paid_amount = await txt(bp.locator(".paid .amt"));
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });
    log(`paid ${R.paid_amount}`);

    // merchant real USDC delta -> must be EXACTLY the invoice amount, at the invoice address
    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(merchant.publicKey()); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    R.paid_to_invoice_addr = merchant.publicKey() === R.link_params.addr;
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;
    log(`merchant Δ ${R.merchant_usdc_delta} at invoice addr=${R.paid_to_invoice_addr}, flipped ${flipped}`);

    // amount/address match: invoice said $25 to <addr>; buyer paid $25; merchant +$25 at <addr>
    R.amount_address_match = R.link_params.amt === "25" && R.paid_amount === "$25.00" && R.merchant_usdc_delta === 25 && R.paid_to_invoice_addr;

    const ok = R.qr_rendered && /^COWRIE-[0-9A-F]{4}$/.test(R.merchant_payid) && R.link_matches_invoice &&
      R.buyer_invoice_merchant === "Acme Foods" && R.buyer_shows_usdc && R.buyer_shows_fiat && R.buyer_shows_payid &&
      R.buyer_no_amount_input && R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 &&
      R.register_flipped && R.amount_address_match;
    R.RESULT = ok ? "R6 PAY-LINK + QR + LOCAL CURRENCY ✓" : "INCOMPLETE ✗";
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
