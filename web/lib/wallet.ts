// Seedless local wallet. On first load we silently provision:
//   - a Stellar keypair (pays fees + signs Soroban txns; friendbot-funded)
//   - a BN254 identity scalar (private note key) — used to derive the pubkey the
//     ASP allowlists and to sign nullifiers.
// Persisted in localStorage. NO seed phrase is ever shown.
// Production note (README): real Cowrie uses passkey / social login; the demo
// auto-provisions a local key for a seedless feel.
import { Keypair } from "@stellar/stellar-sdk";

const KEY = "cowrie.wallet.v1";

export interface Note {
  id: string;
  amount: number; // value in USDC (deposit: a fixed denomination; change: arbitrary)
  blinding: string; // decimal field element
  leafIndex: number; // pool tree index (from a Deposit or ChangeNote event)
  commitment: string; // decimal
  spent: boolean;
  createdAt: number;
  kind?: "deposit" | "change"; // change notes are minted as the remainder of a spend
}

export interface Payment {
  merchant: string;
  amount: number; // the merchant payout (arbitrary amount, Phase R1)
  txHash: string;
  at: number;
  noteId?: string; // the slot-1 spent note (backs the receipt + matches SpendEvent)
  merchantField?: string; // merchant id as a field element (bound in the spend proof)
  nullifier?: string; // the SpendEvent nullifier this payment published (= slot-1 input)
  change?: number; // change minted back to the payer (0 if exact)
  spentNoteIds?: string[]; // all notes consumed (1 or 2)
}

export interface WalletState {
  stellarSecret: string;
  walletPriv: string; // BN254 identity scalar (decimal)
  handle: string; // cowrie id, e.g. "ama"
  hideBalance: boolean;
  notes: Note[];
  payments: Payment[];
  aspIndex?: number; // this wallet's allowlist leaf index (from vouch)
}

const HANDLES = ["ama", "kofi", "zola", "nia", "tariq", "ada", "ife", "sade", "kato", "lela"];

function randScalarDecimal(): string {
  const b = new Uint8Array(31); // < BN254 modulus
  crypto.getRandomValues(b);
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x.toString();
}

function fresh(): WalletState {
  const kp = Keypair.random();
  const handle = HANDLES[Math.floor(Math.random() * HANDLES.length)];
  return {
    stellarSecret: kp.secret(),
    walletPriv: randScalarDecimal(),
    handle,
    hideBalance: false,
    notes: [],
    payments: [],
  };
}

export function loadWallet(): WalletState {
  if (typeof window === "undefined") return fresh();
  const raw = localStorage.getItem(KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as WalletState;
    } catch {
      /* fall through */
    }
  }
  const w = fresh();
  localStorage.setItem(KEY, JSON.stringify(w));
  return w;
}

export function saveWallet(w: WalletState): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(w));
}

export function stellarKeypair(w: WalletState): Keypair {
  return Keypair.fromSecret(w.stellarSecret);
}

export function balance(w: WalletState): number {
  return w.notes.filter((n) => !n.spent).reduce((s, n) => s + n.amount, 0);
}

export function addNote(w: WalletState, n: Note): WalletState {
  return { ...w, notes: [...w.notes, n] };
}

export function markSpent(w: WalletState, noteId: string): WalletState {
  return { ...w, notes: w.notes.map((n) => (n.id === noteId ? { ...n, spent: true } : n)) };
}

export function newBlinding(): string {
  return randScalarDecimal();
}
