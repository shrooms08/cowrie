// Phase R2-1 — full-loop browser re-test on the MIGRATED, live USDC rail.
//
// In-app onboarding (friendbot XLM → USDC trustline → DEX swap) is proven
// separately by scripts/onboard_diag.mjs (reached "100.00 USDC · rail live"). To
// make THIS full-loop test reliable against public-friendbot rate-limiting when
// two accounts onboard back-to-back, we pre-provision both accounts in Node
// (same code path: ensureUsdc-equivalent) and inject them into localStorage, so
// the app's onboarding short-circuits (already funded + USDC) and we exercise the
// real money loop: deposit → reload persist → pay (real USDC to merchant) →
// merchant balance delta → register flip → receipt → can't-cover.
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

async function fund(pub) {
  for (let a = 0; a < 5; a++) {
    await fetch(`https://friendbot.stellar.org?addr=${pub}`).catch(() => {});
    for (let i = 0; i < 12; i++) { try { await s.getAccount(pub); return; } catch { await sleep(1500); } }
    await sleep(2000);
  }
  throw new Error("friendbot timeout " + pub.slice(0, 6));
}
async function classic(kp, op) {
  const acc = await h.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "2000", networkPassphrase: NET }).addOperation(op).setTimeout(60).build();
  tx.sign(kp); await h.submitTransaction(tx);
}
async function usdcOf(pub) {
  for (let i = 0; i < 6; i++) {
    try { const acc = await h.loadAccount(pub); const b = acc.balances.find((x) => x.asset_code === "USDC" && x.asset_issuer === ISSUER); return b ? parseFloat(b.balance) : 0; }
    catch (e) { if (e?.response?.status === 404) return 0; await sleep(1500); }
  }
  return 0;
}
async function onboardUsdc(kp, target) {
  await fund(kp.publicKey());
  const acc = await h.loadAccount(kp.publicKey());
  if (!acc.balances.some((x) => x.asset_code === "USDC")) await classic(kp, Operation.changeTrust({ asset: USDC }));
  if (target > 0 && (await usdcOf(kp.publicKey())) < target) {
    await classic(kp, Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: String(target * 20), destination: kp.publicKey(), destAsset: USDC, destAmount: String(target), path: [] }));
  }
}
const walletStateFor = (secret) => ({
  stellarSecret: secret,
  walletPriv: (() => { const b = new Uint8Array(31); for (let i = 0; i < 31; i++) b[i] = Math.floor(Math.random() * 256); let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x.toString(); })(),
  handle: "ama", hideBalance: false, notes: [], payments: [],
});
const bal = (page) => page.locator(".balance").first().textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  const browser = await chromium.launch({ headless: true });
  try {
    // ---- pre-provision both accounts (reliable, in Node) ----
    const buyer = Keypair.random();
    const merchant = Keypair.random();
    log("pre-provisioning buyer + merchant (XLM + USDC rail)…");
    await onboardUsdc(buyer, 100);      // buyer needs USDC to deposit
    await onboardUsdc(merchant, 0);     // merchant just needs a trustline to receive
    R.buyer_usdc_start = await usdcOf(buyer.publicKey());
    const merchBefore = await usdcOf(merchant.publicKey());
    R.merchant_usdc_before = merchBefore;
    log(`buyer USDC=${R.buyer_usdc_start}, merchant USDC=${merchBefore}, merchant=${merchant.publicKey().slice(0, 8)}`);

    // ===== MERCHANT CONTEXT: inject wallet, generate a $25 charge =====
    const mctx = await browser.newContext();
    const mp = await mctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 120)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((sec) => localStorage.setItem("cowrie.merchant.v1", JSON.stringify({ stellarSecret: sec, name: "Buka Express" })), merchant.secret());
    await mp.reload();
    await mp.getByRole("button", { name: "Generate charge" }).waitFor({ timeout: 90000 });
    await mp.locator(".reg-input.big").fill("42500"); // /1700 = $25
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payLink = await mp.locator(".paylink a.link").getAttribute("href", { timeout: 15000 });
    const addr = new URL(BASE + payLink).searchParams.get("addr");
    R.payLink = payLink; R.merchant_addr = addr;
    log(`merchant charge $25, paylink addr ${addr?.slice(0, 8)}…`);
    if (addr !== merchant.publicKey()) throw new Error("paylink addr != merchant");

    // ===== BUYER CONTEXT: inject pre-onboarded wallet, deposit $50 =====
    const bctx = await browser.newContext();
    const bp = await bctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 120)); });
    await bp.goto(BASE);
    await bp.evaluate((st) => localStorage.setItem("cowrie.wallet.v1", st), JSON.stringify(walletStateFor(buyer.secret())));
    await bp.reload();
    await bp.getByText("Receive", { exact: true }).first().click();
    // Onboarded when the deposit button shows any "Deposit $N USDC" (default denom
    // is $5). Then select $50 and deposit.
    await bp.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 90000 });
    R.buyer_usdc_avail = (await bp.locator(".usdc-avail b").first().textContent())?.trim();
    log(`buyer onboarded in-app (avail ${R.buyer_usdc_avail}); depositing $50…`);
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Top up a private note" }).waitFor({ state: "detached", timeout: 180000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    R.balance_after_deposit = await bal(bp);
    R.buyer_usdc_after_deposit = await usdcOf(buyer.publicKey());
    log(`deposited: balance ${R.balance_after_deposit}, buyer USDC now ${R.buyer_usdc_after_deposit} (was ${R.buyer_usdc_start})`);

    // ===== RELOAD persistence =====
    await bp.reload();
    await bp.waitForTimeout(3000);
    R.balance_after_reload = await bal(bp);
    log(`balance after reload = ${R.balance_after_reload}`);

    // ===== PAY $25 via pay-link (real USDC to merchant) =====
    await bp.goto(BASE + payLink);
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 15000 });
    await bp.locator(".amount-input").fill("25");
    await bp.waitForTimeout(400);
    R.pay_plan = (await bp.locator(".plan").first().textContent())?.replace(/\s+/g, " ").trim();
    await bp.getByRole("button", { name: /^Pay \$25/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 260000 });
    R.pay_change_chip = (await bp.locator(".change-chip").count()) ? (await bp.locator(".change-chip").textContent())?.trim() : null;
    await bp.getByRole("button", { name: "Done" }).click().catch(() => {});
    await bp.locator(".balance", { hasText: "$25" }).first().waitFor({ timeout: 30000 });
    R.balance_after_pay = await bal(bp);
    log(`PAID $25, change chip ${R.pay_change_chip}, balance ${R.balance_after_pay}`);

    // ===== merchant real USDC delta =====
    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(addr); if (merchAfter - merchBefore >= 24.99) break; await sleep(3000); }
    R.merchant_usdc_after = merchAfter;
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    log(`merchant USDC after ${merchAfter} (Δ ${R.merchant_usdc_delta})`);

    // ===== register flip =====
    let flipped = false;
    for (let i = 0; i < 20; i++) { if (await mp.getByRole("heading", { name: /Paid\. Verified clean\./ }).count()) { flipped = true; break; } await mp.waitForTimeout(3000); }
    R.register_flipped = flipped;
    log(`register flipped = ${flipped}`);

    // ===== can't-cover guard (quick/deterministic — do this before the receipt) =====
    await bp.locator(".action.green").click();
    await bp.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 10000 });
    await bp.locator(".amount-input").fill("100");
    await bp.waitForTimeout(400);
    R.cant_cover = (await bp.locator(".plan.cant").count()) ? (await bp.locator(".plan.cant").textContent())?.replace(/\s+/g, " ").trim() : "NOT SHOWN";
    log(`cant-cover: ${R.cant_cover}`);
    await bp.getByRole("button", { name: "← back" }).first().click().catch(() => {});

    // ===== receipt on the real-USDC payment =====
    const recLink = bp.locator(".reclink").first();
    if (await recLink.count()) {
      await recLink.click();
      await bp.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
      log("receipt: generating (in-browser proof + on-chain verify)…");
      await bp.getByRole("button", { name: "Generate receipt" }).click();
      await bp.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 240000 });
      R.receipt_ok = (await bp.locator("textarea.input").inputValue()).startsWith("cowrie-receipt:");
    }
    log(`receipt ok = ${R.receipt_ok}`);

    const ok = R.merchant_usdc_delta >= 24.99 && R.merchant_usdc_delta <= 25.01 && R.register_flipped &&
      R.receipt_ok && /can.?t cover/i.test(String(R.cant_cover)) && R.balance_after_reload?.includes("$50") &&
      R.balance_after_pay?.includes("$25") && R.buyer_usdc_after_deposit <= R.buyer_usdc_start - 49.99;
    R.RESULT = ok ? "FULL LOOP ON REAL USDC ✓" : "INCOMPLETE ✗";
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
