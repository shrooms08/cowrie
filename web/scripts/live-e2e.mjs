// LIVE deployment E2E — proves in-browser Groth16 proving works in PRODUCTION.
// Drives the deployed Vercel URL through the REAL flow:
//   merchant $5 invoice -> buyer onboards (via the gated "Get started" button)
//   -> deposit -> pay (in-browser proof + on-chain BN254 verify) -> "Paid"
// Then captures the spend tx hash from the UI and INDEPENDENTLY verifies it on
// Horizon (successful + invokes the pool contract). No mocks on the proof path.
import { chromium } from "playwright";
import { Horizon, Asset, Operation, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
const BASE = process.env.BASE || "https://cowrie-cyan.vercel.app";
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
const mSt = (secret, name) => JSON.stringify({ stellarSecret: secret, name, createdAt: 1 });
const txt = (loc) => loc.textContent().then((t) => (t || "").trim());

async function main() {
  const R = {};
  log(`LIVE E2E against ${BASE}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const buyer = Keypair.random(), merch = Keypair.random();
    const MNAME = "Acme Foods";
    log("provisioning buyer + merchant on testnet…");
    await provisionBuyer(buyer);
    await fund(merch.publicKey()); await classic(merch, Operation.changeTrust({ asset: USDC }));
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });

    // ===== MERCHANT: $5 invoice =====
    const mp = await ctx.newPage();
    mp.on("console", (m) => { if (m.type() === "error") log("[merchant err]", m.text().slice(0, 140)); });
    await mp.goto(BASE + "/merchant");
    await mp.evaluate((m) => localStorage.setItem("cowrie.merchant.v1", m), mSt(merch.secret(), MNAME));
    await mp.reload();
    await mp.locator(".merch-panel", { hasText: "ready to receive" }).waitFor({ timeout: 120000 });
    await mp.locator(".uc-input").fill("5");
    await mp.waitForTimeout(300);
    await mp.getByRole("button", { name: "Generate charge" }).click();
    const payUrl = await txt(mp.locator(".paylink a.link"));
    log(`invoice created: ${payUrl.slice(0, 80)}…`);

    // ===== BUYER: onboard via the GATED "Get started" button =====
    const bp = await ctx.newPage();
    bp.on("console", (m) => { if (m.type() === "error") log("[buyer err]", m.text().slice(0, 140)); });
    const rel = payUrl.replace(BASE, "");
    await bp.goto(BASE + "/");
    await bp.evaluate((w) => localStorage.setItem("cowrie.wallet.v1", w), wSt(buyer.secret()));
    await bp.goto(BASE + "/");
    // go to Receive; confirm onboarding is NOT auto-run (gate present)
    await bp.getByText("Receive", { exact: true }).first().click();
    R.gate_button_present = await bp.getByRole("button", { name: /Get started/ }).count() > 0;
    log(`(gate) "Get started" button present, onboarding NOT auto-run: ${R.gate_button_present}`);
    await bp.getByRole("button", { name: /Get started/ }).click();
    log("clicked Get started — onboarding to USDC rail…");
    await bp.locator(".usdc-avail", { hasText: "rail live" }).waitFor({ timeout: 180000 });
    // deposit $50
    await bp.locator(".denom", { hasText: /^\$50$/ }).click();
    await bp.getByRole("button", { name: /Deposit \$50 USDC/ }).click();
    await bp.getByRole("heading", { name: "Move USDC into Cowrie" }).waitFor({ state: "detached", timeout: 200000 });
    await bp.locator(".balance", { hasText: "$50" }).first().waitFor({ timeout: 40000 });
    log("deposited $50 into a private note");

    // ===== BUYER: pay the invoice — REAL in-browser proof + on-chain verify =====
    await bp.goto(BASE + rel);
    await bp.locator(".invoice-card").waitFor({ timeout: 40000 });
    log("paying $5 — proving in-browser (this is the production proving test)…");
    await bp.getByRole("button", { name: /^Pay \$5/ }).click();
    await bp.getByRole("heading", { name: "Paid" }).waitFor({ timeout: 300000 });
    // capture the on-chain spend tx from the Paid screen
    const txHref = await bp.locator(".paid .txt a").getAttribute("href");
    R.spend_tx = (txHref || "").split("/tx/")[1] || null;
    R.paid_amount = await txt(bp.locator(".paid .amt"));
    log(`UI shows Paid ${R.paid_amount}; spend tx = ${R.spend_tx}`);

    // ===== INDEPENDENT on-chain verification of the spend tx =====
    if (!R.spend_tx) throw new Error("no spend tx hash captured from UI");
    let txRec = null;
    for (let i = 0; i < 10; i++) { try { txRec = await h.transactions().transaction(R.spend_tx).call(); break; } catch { await sleep(2000); } }
    if (!txRec) throw new Error("spend tx not found on Horizon");
    R.tx_successful = txRec.successful;
    const ops = await h.operations().forTransaction(R.spend_tx).call();
    R.tx_invokes_contract = ops.records.some((o) => o.type === "invoke_host_function");
    log(`Horizon: successful=${R.tx_successful} invokeHostFunction=${R.tx_invokes_contract} ledger=${txRec.ledger}`);

    R.PROOF_VERIFIED_ON_LIVE_URL =
      R.gate_button_present && /\$5/.test(R.paid_amount) && !!R.spend_tx &&
      R.tx_successful === true && R.tx_invokes_contract === true;
    R.RESULT = R.PROOF_VERIFIED_ON_LIVE_URL ? "LIVE PROOF ✓" : "FAILED ✗";
    log("\nRESULTS " + JSON.stringify(R, null, 2));
    if (!R.PROOF_VERIFIED_ON_LIVE_URL) process.exitCode = 1;
  } catch (e) {
    log("ERROR:", e.message);
    log("RESULTS_SO_FAR " + JSON.stringify(R, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
main();
