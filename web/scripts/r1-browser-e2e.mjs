// Phase R1 browser e2e — drives the REAL UI in Chromium against live testnet
// contracts (config.ts: change-enabled pool + ASP). Exercises type-an-amount
// pay, coin selection (1 vs 2 notes), change-note minting + persistence across
// reload + re-spend, the can't-cover case, and a receipt on a change payment.
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const log = (...a) => console.log(...a);
const time = () => new Date().toISOString().slice(11, 19);

async function balanceText(page) {
  return (await page.locator(".balance").first().textContent())?.trim() ?? "";
}
async function waitBalance(page, contains, timeout = 30000) {
  await page.locator(".balance", { hasText: contains }).first().waitFor({ timeout });
}

// Deposit a fixed-denomination note via the Receive sheet.
async function deposit(page, denom) {
  log(`${time()} deposit $${denom} …`);
  await page.getByText("Receive", { exact: true }).first().click();
  await page.getByRole("heading", { name: "Top up a private note" }).waitFor({ timeout: 15000 });
  await page.locator(".denom", { hasText: new RegExp(`^\\$${denom}$`) }).click();
  await page.getByRole("button", { name: `Deposit $${denom}` }).click();
  // back on home when done (deposit sheet closes)
  await page.getByRole("heading", { name: "Top up a private note" }).waitFor({ state: "detached", timeout: 120000 });
  log(`${time()}   deposited $${denom}`);
}

// Open Pay, type amount, return the plan preview text (or null).
async function openPay(page, merchant, amount) {
  await page.locator(".action.green").click();
  await page.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 15000 });
  const m = page.locator(".sheet input.input").first();
  await m.fill(merchant);
  await page.locator(".amount-input").fill(String(amount));
  await page.waitForTimeout(300);
}
async function planText(page) {
  const plan = page.locator(".plan");
  if (await plan.count()) return (await plan.first().textContent())?.replace(/\s+/g, " ").trim() ?? "";
  return null;
}

// Execute a pay that is expected to succeed; returns { paidText, changeChip }.
async function pay(page) {
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await page.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 240000 });
  const changeChip = (await page.locator(".change-chip").count())
    ? (await page.locator(".change-chip").textContent())?.trim()
    : null;
  const amt = (await page.locator(".paid .amt").textContent())?.trim();
  return { amt, changeChip };
}
async function done(page) {
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("heading", { name: "Pay a merchant" }).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("  [browser error]", m.text().slice(0, 160)); });
  const results = {};

  try {
    // fresh wallet
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // wait until funded (deposit button enabled). Provisioning happens on load.
    log(`${time()} waiting for wallet funding…`);
    await page.locator(".action.green").waitFor({ timeout: 60000 });
    // give friendbot a moment; the Receive button works regardless, deposit needs funded
    await page.waitForTimeout(3000);

    // ===== Scenario A: single-note + change. Deposit $50, type 25. =====
    await deposit(page, 50);
    await waitBalance(page, "$50", 30000);
    await openPay(page, "Buka Express", 25);
    const planA = await planText(page);
    log(`${time()} [A] plan: ${planA}`);
    results.A_plan = planA;
    const payA = await pay(page);
    log(`${time()} [A] ${JSON.stringify(payA)}`);
    results.A_pay = payA;
    await done(page);
    await waitBalance(page, "$25", 30000); // $50 spent, $25 change minted
    results.A_balance_after = await balanceText(page);
    log(`${time()} [A] balance after = ${results.A_balance_after}`);

    // ===== Scenario B: reload — change note persists + is spendable. =====
    await page.reload();
    await page.waitForTimeout(2500);
    results.B_balance_after_reload = await balanceText(page);
    log(`${time()} [B] balance after reload = ${results.B_balance_after_reload}`);
    // spend the $25 change note in full (change 0)
    await openPay(page, "Second Merchant", 25);
    const planB = await planText(page);
    log(`${time()} [B] plan: ${planB}`);
    results.B_plan = planB;
    const payB = await pay(page);
    log(`${time()} [B] ${JSON.stringify(payB)}`);
    results.B_pay = payB;
    await done(page);
    await waitBalance(page, "$0", 30000);

    // ===== Scenario C: coin selection. Deposit $10 + $50 (balance $60). =====
    await deposit(page, 10);
    await deposit(page, 50);
    await waitBalance(page, "$60", 30000);
    // C1: pay $45 — a single $50 covers it, so the rule "prefer 1 note" picks the
    // $50 alone (change $5), NOT a combine. (Preview-only check.)
    await openPay(page, "Buka Express", 45);
    results.C1_plan_45 = await planText(page);
    log(`${time()} [C1] plan(45): ${results.C1_plan_45}`);
    // C2: change amount to $55 — no single note covers, so it COMBINES $10+$50
    // (change $5). This is the genuine 2-input spend. Pay it on-chain.
    await page.locator(".amount-input").fill("55");
    await page.waitForTimeout(300);
    results.C2_plan_55 = await planText(page);
    log(`${time()} [C2] plan(55): ${results.C2_plan_55}`);
    const payC = await pay(page);
    log(`${time()} [C2] ${JSON.stringify(payC)}`);
    results.C2_pay = payC;
    await done(page);
    await waitBalance(page, "$5", 30000);
    results.C_balance_after = await balanceText(page);

    // ===== Scenario D: can't-cover with <=2 notes. Now hold one $5 note. Type 100. =====
    await openPay(page, "Big Store", 100);
    const planD = await planText(page);
    log(`${time()} [D] plan: ${planD}`);
    results.D_plan = planD;
    results.D_pay_disabled = await page.getByRole("button", { name: "Enter an amount" }).isDisabled().catch(() => null);
    // also confirm no crash: go back
    await page.getByRole("button", { name: "← back" }).first().click();

    // ===== Scenario E: receipt on a change payment (Scenario A was a change pay). =====
    // open the receipt for the most recent change payment via activity "· receipt"
    log(`${time()} [E] generating a receipt on a change payment…`);
    const recLink = page.locator(".reclink").first();
    if (await recLink.count()) {
      await recLink.click();
      await page.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Generate receipt" }).click();
      await page.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 180000 });
      const blob = await page.locator("textarea.input").inputValue();
      results.E_receipt_prefix = blob.slice(0, 24);
      results.E_receipt_ok = blob.startsWith("cowrie-receipt:");
      log(`${time()} [E] receipt ready: ${results.E_receipt_ok}`);
    } else {
      results.E_receipt_ok = "no receipt link found";
    }

    log("\nRESULTS " + JSON.stringify(results, null, 2));
  } catch (e) {
    log("E2E ERROR:", e.message);
    await page.screenshot({ path: "/tmp/r1_fail.png" }).catch(() => {});
    log("RESULTS_SO_FAR " + JSON.stringify(results, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
main();
