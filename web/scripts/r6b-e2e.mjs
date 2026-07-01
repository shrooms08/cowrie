// R6 fix — merchant name must display as the clean name, never the raw pay-link
// URL. Verifies: (A) pasting a full pay-link into the manual Merchant field
// auto-loads it (clean name, not the URL); (B) the full pay reaches "Paid" and
// the "to" line shows the clean merchant name; merchant real USDC +amount.
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
const txt = (loc) => loc.textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const buyer = Keypair.random(), merch = Keypair.random();
    await provisionBuyer(buyer);
    await fund(merch.publicKey()); await classic(merch, Operation.changeTrust({ asset: USDC }));
    const merchBefore = await usdcOf(merch.publicKey());
    const NAME = "Minos Akara";
    const rel = `/?pay=${encodeURIComponent(NAME)}&amt=15&addr=${merch.publicKey()}&fiat=25500&cur=NGN&id=COWRIE-1A2B`;
    const fullUrl = BASE + rel;
    log(`buyer ${await usdcOf(buyer.publicKey())} USDC; invoice "${NAME}" $15`);

    const ctx = await browser.newContext({ viewport: { width: 460, height: 900 } });
    const pg = await ctx.newPage();
    pg.on("console", (m) => { if (m.type() === "error") log("[err]", m.text().slice(0, 120)); });

    // ---- (A) paste the FULL pay-link URL into the manual Merchant field ----
    await pg.goto(BASE);
    await pg.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await pg.reload();
    await pg.locator(".wallet-card .wc-bal", { hasText: "$100" }).waitFor({ timeout: 90000 });
    await pg.locator(".action.green").click(); // Send -> manual pay
    await pg.getByRole("heading", { name: "Pay a merchant" }).waitFor({ timeout: 10000 });
    await pg.locator(".sheet input.input").first().fill(fullUrl); // paste the whole URL
    await pg.waitForTimeout(400);
    R.paste_loaded_invoice = (await pg.locator(".invoice-card").count()) > 0;
    R.paste_merchant_name = (await pg.locator(".invoice-card").count()) ? await txt(pg.locator(".invoice-card .inv-v")) : "(no invoice card)";
    R.paste_no_raw_url = !/https?:\/\/|\?pay=/.test(R.paste_merchant_name);
    log(`(A) paste-url: invoiceLoaded=${R.paste_loaded_invoice} merchant="${R.paste_merchant_name}" noRawUrl=${R.paste_no_raw_url}`);

    // ---- (B) open the link, deposit, pay, check the "Paid" TO line ----
    await pg.goto(fullUrl);
    await pg.locator(".invoice-card").waitFor({ timeout: 30000 });
    await pg.goto(BASE);
    await pg.getByText("Receive", { exact: true }).first().click();
    await pg.getByRole("button", { name: /Deposit \$\d+ USDC/ }).waitFor({ timeout: 60000 });
    await pg.locator(".denom", { hasText: /^\$50$/ }).click();
    await pg.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await pg.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 180000 });
    await pg.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 30000 });
    log("deposited $50");
    await pg.goto(fullUrl);
    await pg.locator(".invoice-card").waitFor({ timeout: 30000 });
    await pg.getByRole("button", { name: /^Pay \$15/ }).click();
    await pg.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 280000 });
    R.paid_to_line = await txt(pg.locator(".paid .label"));
    R.paid_to_clean = R.paid_to_line.includes(NAME) && !/https?:\/\/|\?pay=|localhost/.test(R.paid_to_line);
    log(`(B) paid 'to' line: "${R.paid_to_line}" clean=${R.paid_to_clean}`);
    // activity row also clean (go home)
    await pg.getByRole("button", { name: "Done" }).click().catch(() => {});
    await pg.locator(".activity").waitFor({ timeout: 15000 });
    R.activity_name = await txt(pg.locator(".activity .act .name").first());
    R.activity_clean = R.activity_name === NAME;

    let merchAfter = merchBefore;
    for (let i = 0; i < 15; i++) { merchAfter = await usdcOf(merch.publicKey()); if (merchAfter - merchBefore >= 14.99) break; await sleep(3000); }
    R.merchant_usdc_delta = +(merchAfter - merchBefore).toFixed(2);
    log(`merchant Δ ${R.merchant_usdc_delta}, activity name "${R.activity_name}"`);

    const ok = R.paste_loaded_invoice && R.paste_merchant_name === NAME && R.paste_no_raw_url &&
      R.paid_to_clean && R.activity_clean && R.merchant_usdc_delta >= 14.99 && R.merchant_usdc_delta <= 15.01;
    R.RESULT = ok ? "R6 MERCHANT-NAME DISPLAY FIX ✓" : "INCOMPLETE ✗";
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
