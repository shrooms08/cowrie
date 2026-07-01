// Phase R1 — confirm a receipt minted on a CHANGE payment verifies end-to-end
// through the /verify page (new payout-split cross-check), and is rejected for
// the wrong recipient. Fresh wallet, live contracts.
import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const log = (...a) => console.log(...a);
const t = () => new Date().toISOString().slice(11, 19);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  const R = {};
  try {
    await page.goto(BASE);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator(".action.green").waitFor({ timeout: 60000 });
    await page.waitForTimeout(3000);

    // deposit $50, pay $30 -> $20 change (a change payment)
    log(`${t()} deposit $50`);
    await page.getByText("Receive", { exact: true }).first().click();
    await page.locator(".denom", { hasText: /^\$50$/ }).click();
    await page.getByRole("button", { name: "Deposit $50" }).click();
    await page.getByRole("heading", { name: "Top up a private note" }).waitFor({ state: "detached", timeout: 120000 });

    log(`${t()} pay $30 to Buka Express (mints $20 change)`);
    await page.locator(".action.green").click();
    await page.locator(".sheet input.input").first().fill("Buka Express");
    await page.locator(".amount-input").fill("30");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 240000 });
    R.changeChip = await page.locator(".change-chip").textContent();

    // Share -> generate receipt (recipient = Buka Express)
    log(`${t()} generate receipt`);
    await page.getByRole("button", { name: "Share a receipt" }).click();
    await page.getByRole("heading", { name: "Share a receipt" }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Generate receipt" }).click();
    await page.getByRole("heading", { name: "Receipt ready" }).waitFor({ timeout: 180000 });
    const blob = await page.locator("textarea.input").inputValue();
    R.blobOk = blob.startsWith("cowrie-receipt:");

    // VERIFY PAGE — verify as the correct recipient
    log(`${t()} verify as Buka Express (correct)`);
    await page.goto(BASE + "/verify");
    await page.locator("textarea.input").fill(blob);
    await page.locator('input.input').fill("Buka Express");
    await page.getByRole("button", { name: "Verify receipt" }).click();
    await page.locator("h2", { hasText: /Verified|Invalid|Not addressed/ }).first().waitFor({ timeout: 60000 });
    R.verifyResult = (await page.locator(".verify-grid h2").last().textContent())?.trim();
    R.verifyAmount = (await page.locator(".amt").count()) ? (await page.locator(".amt").textContent())?.trim() : null;

    // VERIFY PAGE — verify as the WRONG recipient -> rejected
    log(`${t()} verify as Someone Else (wrong)`);
    await page.locator('input.input').fill("Someone Else");
    await page.getByRole("button", { name: "Verify receipt" }).click();
    await page.waitForTimeout(1500);
    await page.locator("h2", { hasText: /Verified|Invalid|Not addressed/ }).first().waitFor({ timeout: 60000 });
    R.wrongRecipientResult = (await page.locator(".verify-grid h2").last().textContent())?.trim();

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
