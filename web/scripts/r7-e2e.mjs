// R7 — ONE clean end-to-end spend on the FRESH pool/ASP config. Confirms the
// "Paid" screen actually appears (a real completed payment, not just resolution
// passing), the merchant's real USDC increases by the payout, and the register
// flips. Exercises the real vouch -> resolveAspLeavesAuthoritative -> prove ->
// spend path.
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
    log("pre-provisioning…");
    await provisionBuyer(buyer);
    await fund(merch.publicKey()); await classic(merch, Operation.changeTrust({ asset: USDC }));
    const merchBefore = await usdcOf(merch.publicKey());
    const rel = `/?pay=${encodeURIComponent("Acme Foods")}&amt=25&addr=${merch.publicKey()}&fiat=42500&cur=NGN&id=COWRIE-7777`;
    log(`buyer ${await usdcOf(buyer.publicKey())} USDC; merchant ${merchBefore} (${merch.publicKey().slice(0, 8)})`);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });

    // merchant page open (to watch the register flip)
    const mp = await ctx.newPage();
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((m) => localStorage.setItem("cowrie.merchant.v1", m), mSt(merch.secret()));
    await mp.reload();
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    await mp.locator(".reg-input.big").fill("42500");
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    await mp.locator(".paylink a.link").waitFor({ timeout: 15000 });
    log("merchant invoice created");

    // buyer: deposit $50, then pay the invoice
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 140)); });
    await bp.goto(BASE);
    await bp.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await bp.reload();
    await bp.getByText("Receive", { exact: true }).first().click();
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 90000 });
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    log("buyer deposited $50 (real USDC into pool)");

    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 30000 });
    log("invoice loaded — proving + spending (watching for the Paid screen)…");
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    // THE key assertion: the Paid screen actually appears (real completed payment)
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 280000 });
    R.paid_screen = true;
    R.paid_amount = await txt(bp.locator(".paid .amt"));
    R.paid_to = await txt(bp.locator(".paid .label"));
    R.paid_tx = await bp.locator(".paid .txt a").getAttribute("href").catch(() => null);
    log(`PAID ✓ amount=${R.paid_amount} to="${R.paid_to}" tx=${R.paid_tx}`);
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });

    // merchant real USDC delta + register flip
    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(merch.publicKey()); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;
    log(`merchant Δ ${R.merchant_usdc_delta}, register flipped ${flipped}`);

    const ok = R.paid_screen && R.paid_amount === "$25.00" && /Acme Foods/.test(R.paid_to) &&
      R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 && R.register_flipped;
    R.RESULT = ok ? "R7 CLEAN SPEND ON FRESH CONFIG ✓" : "INCOMPLETE ✗";
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
