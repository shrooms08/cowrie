import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const t = () => new Date().toISOString().slice(11, 19);
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on("console", (m) => console.log(t(), "[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log(t(), "[pageerror]", e.message.slice(0, 200)));
page.on("requestfailed", (r) => console.log(t(), "[reqfail]", r.url().slice(0, 60), r.failure()?.errorText));
await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByText("Receive", { exact: true }).first().click();
for (let i = 0; i < 30; i++) {
  const wl = await page.locator(".working-line").textContent().catch(() => null);
  const av = await page.locator(".usdc-avail").textContent().catch(() => null);
  const dry = (await page.locator(".plan.cant").count()) ? await page.locator(".plan.cant").textContent().catch(() => null) : null;
  const btn = await page.getByRole("button", { name: /Deposit|Onboarding|Need/ }).textContent().catch(() => null);
  console.log(t(), `working=${(wl||"").trim().slice(0,50)} | avail=${(av||"").trim().slice(0,40)} | dry=${dry?dry.trim().slice(0,50):"-"} | btn=${(btn||"").trim()}`);
  if (btn && /Deposit \$/.test(btn)) { console.log(t(), "ONBOARDED ✓"); break; }
  await page.waitForTimeout(3000);
}
await browser.close();
