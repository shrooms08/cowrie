// Proves wallet keys AND notes survive a page reload, in the REAL app:
// load -> real deposit -> reload -> balance still correct + note still spendable.
import puppeteer from "puppeteer-core";

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: BRAVE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  page error:", String(e).slice(0, 80)));

try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  const readWallet = () => page.evaluate(() => JSON.parse(localStorage.getItem("cowrie.wallet.v1") || "null"));

  // wait for seedless provisioning
  let w0;
  for (let i = 0; i < 20; i++) { w0 = await readWallet(); if (w0?.stellarSecret) break; await sleep(1000); }
  console.log("1. seedless wallet provisioned:", w0?.stellarSecret ? `handle=${w0.handle} (key + identity present)` : "MISSING");

  // wait until funded (Deposit button enabled), then deposit $5
  await page.evaluate(() => [...document.querySelectorAll(".iconbtn")].find((b) => b.getAttribute("aria-label") === "scan")?.click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll(".denom")].find((b) => b.textContent.trim() === "$5")?.click());
  console.log("2. depositing $5 (real on-chain)…");
  let deposited = false;
  for (let i = 0; i < 60; i++) {
    const btn = await page.evaluate(() => { const b = [...document.querySelectorAll(".btn")].find((x) => /Deposit \$/.test(x.textContent)); if (b && !b.disabled) { b.click(); return "clicked"; } return b ? "disabled" : "none"; });
    const w = await readWallet();
    if (w?.notes?.length) { deposited = true; break; }
    await sleep(3000);
  }
  const wAfter = await readWallet();
  console.log("3. deposit landed:", deposited ? `note stored (leaf #${wAfter.notes[0].leafIndex}, $${wAfter.notes[0].amount})` : "FAILED/timeout");
  if (!deposited) throw new Error("deposit did not land in time");

  // ===== RELOAD =====
  await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);
  const wReload = await readWallet();
  const balanceText = await page.evaluate(() => document.querySelector(".balance")?.textContent?.trim());
  const note = wReload.notes[0];
  const sameKey = wReload.stellarSecret === w0.stellarSecret && wReload.walletPriv === w0.walletPriv;
  const spendable = note && note.blinding && note.commitment && typeof note.leafIndex === "number";

  console.log("4. AFTER RELOAD:");
  console.log("   same seedless key + identity:", sameKey ? "YES ✓" : "NO ✗");
  console.log("   notes persisted:", wReload.notes.length, "— balance renders:", balanceText);
  console.log("   note still spendable (blinding+commitment+leafIndex):", spendable ? "YES ✓" : "NO ✗");

  console.log(`\nRESULT: ${sameKey && spendable && /\$5/.test(balanceText) ? "PERSISTENCE OK ✓" : "FAIL ✗"}`);
} catch (e) {
  console.error("test error:", String(e.message || e).split("\n")[0]);
} finally {
  await browser.close();
}
