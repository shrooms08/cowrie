// Soroban contract layer: real testnet calls with RPC resilience.
//
// Resilience contract (Phase-2 rule): NEVER blind-resubmit a deposit or spend.
// On any submit/poll flakiness, re-read on-chain state (pool root / nullifier
// presence) to learn whether the op already landed; only resubmit if it did not.
import {
  Account,
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ASP_ID,
  FRIENDBOT_URL,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  POOL_ID,
  RECEIPT_VERIFIER_ID,
  RPC_URL,
  USDC_ASSET_CODE,
  USDC_DECIMALS,
  USDC_ISSUER,
} from "./config";
import { merkleRootOf } from "./wasmWitness";

const server = () => new rpc.Server(RPC_URL, { allowHttp: false });
const horizon = () => new Horizon.Server(HORIZON_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const u256 = (dec: string) => nativeToScVal(BigInt(dec), { type: "u256" });
const vecU256 = (decs: string[]) => xdr.ScVal.scvVec(decs.map(u256));
const bytesScv = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const addrScv = (g: string) => Address.fromString(g).toScVal();

// ---------- real USDC rail (Phase R2-1) ----------
export const USDC = new Asset(USDC_ASSET_CODE, USDC_ISSUER);
const USDC_SCALE = 10 ** USDC_DECIMALS;

/** A wallet's USDC balance in whole USD (from Horizon). Retries — a Horizon
 * hiccup must not read as a zero balance. Returns 0 if the trustline is absent. */
export async function usdcBalance(pubkey: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    try {
      const acc = await horizon().loadAccount(pubkey);
      const b = acc.balances.find(
        (x) => "asset_code" in x && x.asset_code === USDC_ASSET_CODE && x.asset_issuer === USDC_ISSUER
      );
      return b ? parseFloat(b.balance) : 0;
    } catch (e) {
      // account-not-found (unfunded/no trustline) → 0; transient → retry
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) return 0;
      await sleep(1200);
    }
  }
  throw new Error("Horizon unreachable (USDC balance)");
}

export async function hasUsdcTrustline(pubkey: string): Promise<boolean> {
  try {
    const acc = await horizon().loadAccount(pubkey);
    return acc.balances.some(
      (x) => "asset_code" in x && x.asset_code === USDC_ASSET_CODE && x.asset_issuer === USDC_ISSUER
    );
  } catch {
    return false;
  }
}

/** Submit a classic (non-Soroban) operation via Horizon, with a light retry. */
async function classicOp(kp: Keypair, op: xdr.Operation): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const h = horizon();
      const acc = await h.loadAccount(kp.publicKey());
      const tx = new TransactionBuilder(acc, { fee: "2000", networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(op)
        .setTimeout(60)
        .build();
      tx.sign(kp);
      await h.submitTransaction(tx);
      return;
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr ?? new Error("classic op failed");
}

/** Establish the USDC trustline (idempotent — skips if already present). */
export async function establishUsdcTrustline(kp: Keypair): Promise<void> {
  if (await hasUsdcTrustline(kp.publicKey())) return;
  await classicOp(kp, Operation.changeTrust({ asset: USDC }));
}

/** Acquire `amount` USD of USDC via the testnet DEX (path payment XLM→USDC).
 * Throws DexDryError if there's no path/liquidity so the caller can surface a
 * clean retry rather than a broken half-onboarded wallet. */
export class DexDryError extends Error {}
export async function acquireUsdcViaDex(kp: Keypair, amount: number): Promise<void> {
  // Is a path available? (guards against dry liquidity.)
  let ok = false;
  try {
    const paths = await horizon()
      .strictReceivePaths([Asset.native()], USDC, String(amount))
      .call();
    ok = (paths.records?.length ?? 0) > 0;
  } catch {
    ok = false;
  }
  if (!ok) throw new DexDryError("No XLM→USDC path on the testnet DEX right now");
  try {
    await classicOp(
      kp,
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: String(amount * 20), // generous XLM cap; testnet XLM is free
        destination: kp.publicKey(),
        destAsset: USDC,
        destAmount: String(amount),
        path: [],
      })
    );
  } catch (e) {
    throw new DexDryError(`DEX swap failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Ensure `pubkey` (an already-XLM-funded account) holds >= `min` USDC: establish
 * the trustline, then swap on the DEX for a `target` balance. Idempotent and
 * resilient — never leaves a half-onboarded state; surfaces DexDryError. */
export async function ensureUsdc(
  kp: Keypair,
  opts: { min?: number; target?: number; onStatus?: (m: string) => void } = {}
): Promise<number> {
  const min = opts.min ?? 1;
  const target = opts.target ?? 100;
  opts.onStatus?.("establishing USDC trustline…");
  await establishUsdcTrustline(kp);
  let bal = await usdcBalance(kp.publicKey());
  if (bal >= min) return bal;
  opts.onStatus?.("acquiring USDC on the testnet DEX…");
  await acquireUsdcViaDex(kp, target);
  bal = await usdcBalance(kp.publicKey());
  if (bal < min) throw new DexDryError("USDC balance still zero after DEX swap");
  return bal;
}

export async function ensureFunded(pubkey: string): Promise<void> {
  const s = server();
  try {
    await s.getAccount(pubkey);
    return; // already exists
  } catch {
    /* needs funding */
  }
  // Re-request friendbot across attempts: it rate-limits when several accounts
  // are funded back-to-back (e.g. merchant + buyer), so a single request can be
  // dropped. Back off and re-ask rather than fail the whole onboarding.
  for (let attempt = 0; attempt < 4; attempt++) {
    await fetch(`${FRIENDBOT_URL}?addr=${pubkey}`).catch(() => {});
    for (let i = 0; i < 10; i++) {
      try {
        await s.getAccount(pubkey);
        return;
      } catch {
        await sleep(1500);
      }
    }
    await sleep(2000);
  }
  throw new Error("friendbot funding timed out");
}

/** Read-only contract call (simulation), returns the native return value. */
export async function callRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const s = server();
  // simulation needs a source account; any funded account works, but we use a
  // throwaway sequence on a random key to avoid needing the wallet here.
  const probe = Keypair.random().publicKey();
  const acct = new Account(probe, "0");
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} sim: ${sim.error}`);
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}

export interface WriteResult {
  hash: string;
  returnValue: unknown;
  landed: boolean;
}

/**
 * Submit a state-changing call with resilience. `confirm`, if provided, is a
 * predicate that re-reads chain state to decide whether the op landed; it is
 * consulted before any retry so we never blind-resubmit.
 */
export async function callWrite(
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  opts: { confirm?: () => Promise<boolean>; attempts?: number; onStatus?: (msg: string) => void } = {}
): Promise<WriteResult> {
  const attempts = opts.attempts ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) opts.onStatus?.(`RPC flaky — re-checking state & retrying (${attempt + 1}/${attempts})…`);
    // Before (re)submitting, if a prior attempt may have landed, check.
    if (attempt > 0 && opts.confirm && (await opts.confirm().catch(() => false))) {
      return { hash: "", returnValue: undefined, landed: true };
    }
    try {
      const s = server();
      const account = await s.getAccount(kp.publicKey());
      let tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(60)
        .build();
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        // A simulation error is deterministic (contract rejected) — surface it,
        // do not retry/resubmit.
        throw new ContractError(`${method} rejected: ${sim.error}`, sim.error);
      }
      tx = rpc.assembleTransaction(tx, sim).build();
      tx.sign(kp);
      const send = await s.sendTransaction(tx);
      if (send.status === "ERROR") throw new Error(`send error: ${JSON.stringify(send.errorResult)}`);
      const hash = send.hash;
      // poll
      for (let i = 0; i < 30; i++) {
        const got = await s.getTransaction(hash);
        if (got.status === "SUCCESS") {
          return { hash, returnValue: got.returnValue ? scValToNative(got.returnValue) : undefined, landed: true };
        }
        if (got.status === "FAILED") throw new ContractError(`tx failed: ${hash}`, hash);
        await sleep(1500);
      }
      throw new Error("tx confirmation timed out");
    } catch (e) {
      if (e instanceof ContractError) throw e; // deterministic rejection
      lastErr = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  // exhausted retries — final state check
  if (opts.confirm && (await opts.confirm().catch(() => false))) {
    return { hash: "", returnValue: undefined, landed: true };
  }
  throw lastErr ?? new Error("submit failed");
}

export class ContractError extends Error {
  detail: unknown;
  constructor(msg: string, detail: unknown) {
    super(msg);
    this.detail = detail;
  }
}

// ---------- high-level pool/asp ops ----------

export async function poolRoot(): Promise<string> {
  return BigInt(String(await callRead(POOL_ID, "get_root"))).toString();
}
export async function aspRoot(): Promise<string> {
  return BigInt(String(await callRead(ASP_ID, "get_root"))).toString();
}
export async function aspBlocklistRoot(): Promise<string> {
  return BigInt(String(await callRead(ASP_ID, "get_blocklist_root"))).toString();
}
export async function isSpent(nullifierDec: string): Promise<boolean> {
  return Boolean(await callRead(POOL_ID, "is_spent", [u256(nullifierDec)]));
}

/**
 * Reconstruct a contract's Merkle leaf set in index order from its events
 * (DepositEvent.commitment for the pool, LeafAdded.leaf for the ASP). This is
 * the real privacy-pool client model — the full tree comes from the chain, not
 * local assumptions, so paths are correct even with other depositors/identities.
 */
export async function getLeaves(contractId: string, field: "commitment" | "leaf"): Promise<string[]> {
  const s = server();
  const latest = (await s.getLatestLedger()).sequence;
  // Public RPC retains only ~recent ledgers of events; the demo contracts are
  // fresh so a window inside retention captures the whole tree. (A production
  // wallet would use an indexer.)
  const start = Math.max(latest - 8000, 1);
  const byIndex = new Map<number, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    let res;
    for (let r = 0; ; r++) {
      try {
        res = await s.getEvents(
          cursor
            ? { filters: [{ type: "contract", contractIds: [contractId] }], cursor, limit: 200 }
            : { startLedger: start, filters: [{ type: "contract", contractIds: [contractId] }], limit: 200 }
        );
        break;
      } catch (e) {
        if (r >= 3) throw e;
        await sleep(1200);
      }
    }
    for (const ev of res.events) {
      const v = scValToNative(ev.value) as Record<string, unknown>;
      if (v && typeof v.index !== "undefined" && typeof v[field] !== "undefined") {
        byIndex.set(Number(v.index as bigint), BigInt(v[field] as bigint).toString());
      }
    }
    if (res.events.length < 200) break;
    cursor = res.cursor;
  }
  const max = byIndex.size ? Math.max(...byIndex.keys()) : -1;
  const out: string[] = [];
  for (let i = 0; i <= max; i++) out.push(byIndex.get(i) ?? "0");
  return out;
}

// Pool leaves come from BOTH Deposit and ChangeNote events — each inserts a leaf
// and carries {commitment, index}. getLeaves keys by index, so the two event
// types merge into the correct full tree automatically (Phase R1).
export const getPoolLeaves = () => getLeaves(POOL_ID, "commitment");
export const getAspLeaves = () => getLeaves(ASP_ID, "leaf");

/** After a change spend, locate the freshly-minted change note's leaf index by
 * scanning pool leaves (Deposit + ChangeNote) for its commitment. Retries to
 * beat RPC event-indexing lag. Returns -1 if not yet visible. */
export async function findLeafIndex(commitmentDec: string, tries = 8): Promise<number> {
  for (let t = 0; t < tries; t++) {
    const leaves = await getPoolLeaves();
    const idx = leaves.indexOf(commitmentDec);
    if (idx >= 0) return idx;
    await sleep(2500);
  }
  return -1;
}

// ---------- receipt (selective disclosure) ----------

/**
 * Verify a receipt on-chain against the receipt verifier (read-only simulation
 * — instant, free, no signer). Returns true iff the proof verifies for the given
 * public inputs. The caller passes the VERIFIER'S OWN identity as `recipient`,
 * so a receipt bound to someone else fails here (non-replayability).
 */
export async function verifyReceiptSim(
  proofHex: string,
  pubHex: string
): Promise<boolean> {
  const s = server();
  const probe = Keypair.random().publicKey();
  const acct = new Account(probe, "0");
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(RECEIPT_VERIFIER_ID).call(
        "verify_bytes",
        xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")),
        xdr.ScVal.scvBytes(Buffer.from(pubHex, "hex"))
      )
    )
    .setTimeout(30)
    .build();
  const sim = await s.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return false; // contract rejected (trap / InvalidProof)
  return sim.result?.retval ? Boolean(scValToNative(sim.result.retval)) : false;
}

/** Submit a real on-chain verify tx (proves the receipt verifies on-chain; gives a tx hash). */
export async function verifyReceiptTx(kp: Keypair, proofHex: string, pubHex: string): Promise<WriteResult> {
  return callWrite(
    kp,
    RECEIPT_VERIFIER_ID,
    "verify_bytes",
    [xdr.ScVal.scvBytes(Buffer.from(proofHex, "hex")), xdr.ScVal.scvBytes(Buffer.from(pubHex, "hex"))],
    {}
  );
}

/** Find the on-chain SpendEvent whose nullifier matches (cross-check the payment really happened). */
export async function findSpendEvent(
  nullifierDec: string
): Promise<{ merchant: string; payout: number; txHash: string } | null> {
  const s = server();
  const latest = (await s.getLatestLedger()).sequence;
  let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    const res = await s.getEvents(
      cursor
        ? { filters: [{ type: "contract", contractIds: [POOL_ID] }], cursor, limit: 200 }
        : { startLedger: Math.max(latest - 8000, 1), filters: [{ type: "contract", contractIds: [POOL_ID] }], limit: 200 }
    );
    for (const ev of res.events) {
      const topics = (ev.topic ?? []).map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return 0;
        }
      });
      if (!topics.includes("Spend")) continue;
      const v = scValToNative(ev.value) as { merchant: bigint; payout: number; nullifier: bigint };
      if (BigInt(v.nullifier).toString() === nullifierDec) {
        return { merchant: BigInt(v.merchant).toString(), payout: Number(v.payout), txHash: ev.txHash };
      }
    }
    if (res.events.length < 200) break;
    cursor = res.cursor;
  }
  return null;
}

export interface SpendEvent {
  merchant: string;
  payout: number;
  nullifier: string;
  txHash: string;
  ledger: number;
}

/** Read pool SpendEvents at/after `sinceLedger`. This is the ONLY trustworthy
 * "paid" signal — a SpendEvent is emitted only after the proof verifies on
 * chain. It carries merchant + payout + nullifier; nothing else (no wallet,
 * balance, identity, or which note). */
export async function getSpendEvents(sinceLedger: number): Promise<SpendEvent[]> {
  const s = server();
  const latest = (await s.getLatestLedger()).sequence;
  const start = Math.max(sinceLedger, latest - 8000, 1);
  const out: SpendEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    let res;
    for (let r = 0; ; r++) {
      try {
        res = await s.getEvents(
          cursor
            ? { filters: [{ type: "contract", contractIds: [POOL_ID] }], cursor, limit: 200 }
            : { startLedger: start, filters: [{ type: "contract", contractIds: [POOL_ID] }], limit: 200 }
        );
        break;
      } catch (e) {
        if (r >= 3) throw e;
        await sleep(1200);
      }
    }
    for (const ev of res.events) {
      const topics = (ev.topic ?? []).map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return undefined;
        }
      });
      if (!topics.includes("Spend")) continue;
      const v = scValToNative(ev.value) as Record<string, unknown>;
      if (v && typeof v.merchant !== "undefined" && typeof v.payout !== "undefined") {
        out.push({
          merchant: BigInt(v.merchant as bigint).toString(),
          payout: Number(v.payout as bigint),
          nullifier: BigInt(v.nullifier as bigint).toString(),
          txHash: ev.txHash,
          ledger: ev.ledger,
        });
      }
    }
    if (res.events.length < 200) break;
    cursor = res.cursor;
  }
  return out;
}

export async function getLatestLedger(): Promise<number> {
  return (await server().getLatestLedger()).sequence;
}

/** Confirm a transaction succeeded on-chain (used by the mock anchor to verify a
 * spend before settling — it must not trust a "paid" claim from the client). */
export async function txSucceeded(txHash: string): Promise<boolean> {
  try {
    const got = await server().getTransaction(txHash);
    return got.status === "SUCCESS";
  } catch {
    return false;
  }
}

/**
 * Resolve the full pool leaf set such that its root is one the contract accepts
 * (is_known_root). Re-fetch events until it matches — overlaying the wallet's
 * own notes, which it always knows even when fresh-deposit events lag indexing.
 */
export async function resolvePoolLeaves(
  notes: { leafIndex: number; commitment: string }[]
): Promise<string[]> {
  for (let t = 0; t < 8; t++) {
    const leaves = await getPoolLeaves();
    for (const n of notes) {
      while (leaves.length <= n.leafIndex) leaves.push("0");
      leaves[n.leafIndex] = n.commitment;
    }
    const root = await merkleRootOf(leaves);
    if (await callRead(POOL_ID, "is_known_root", [u256(root)])) return leaves;
    await sleep(2500);
  }
  throw new Error("could not resolve a known pool root (RPC lag) — try again");
}

/**
 * Resolve the ASP leaf set so its root equals the LIVE asp root exactly (the
 * ASP keeps no root history). Overlays the wallet's own allowlist leaf.
 */
export async function resolveAspLeaves(myLeaf: string, myIndex: number): Promise<string[]> {
  const live = await aspRoot();
  for (let t = 0; t < 8; t++) {
    const leaves = await getAspLeaves();
    if (myIndex >= 0) {
      while (leaves.length <= myIndex) leaves.push("0");
      leaves[myIndex] = myLeaf;
    }
    if ((await merkleRootOf(leaves)) === live) return leaves;
    await sleep(2500);
  }
  throw new Error("could not resolve live ASP root (RPC lag) — try again");
}

/** Deposit a fixed-denomination note, PULLING real USDC from `kp` into the pool
 * (Phase R2-1). `kp` is both the tx source and the `from` whose source-account
 * credentials authorize the nested usdc.transfer(from→pool). Resilient via
 * expected-root confirm. */
export async function deposit(
  kp: Keypair,
  amount: number,
  commitmentDec: string,
  expectedRootDec: string,
  onStatus?: (m: string) => void
): Promise<WriteResult> {
  return callWrite(
    kp,
    POOL_ID,
    "deposit",
    [addrScv(kp.publicKey()), u32(amount), u256(commitmentDec)],
    {
      confirm: async () => (await poolRoot()) === expectedRootDec,
      onStatus,
    }
  );
}

export interface SpendArgs {
  proofHex: string;
  root: string;
  public_amount: string;
  ext_data_hash: string;
  input_nullifiers: [string, string];
  output_commitments: [string, string];
  asp_membership_root: string;
  asp_non_membership_root: string;
  merchant: string;
  payout: number;
  merchantAddr: string; // the merchant's Stellar address — receives the real USDC payout
  realNullifier: string;
}

/** Spend a note, SENDING real USDC (the payout) from the pool to `merchantAddr`
 * (Phase R2-1). The change stays a private note. Resilient via nullifier-presence
 * confirm. */
export async function spend(kp: Keypair, a: SpendArgs, onStatus?: (m: string) => void): Promise<WriteResult> {
  const args = [
    bytesScv(a.proofHex),
    u256(a.root),
    u256(a.public_amount),
    u256(a.ext_data_hash),
    vecU256(a.input_nullifiers),
    vecU256(a.output_commitments),
    u256(a.asp_membership_root),
    u256(a.asp_non_membership_root),
    u256(a.merchant),
    u32(a.payout),
    addrScv(a.merchantAddr),
  ];
  return callWrite(kp, POOL_ID, "spend", args, {
    confirm: async () => isSpent(a.realNullifier),
    onStatus,
  });
}

export { Address };
