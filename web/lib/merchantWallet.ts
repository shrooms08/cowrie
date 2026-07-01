// Seedless MERCHANT identity (Phase R3). Symmetric with the buyer wallet, NOT
// real auth: "signing in" means claiming a business name and getting a real
// Stellar receiving account (with a USDC trustline) provisioned for it. Persisted
// locally under its OWN storage key so it never collides with the buyer wallet
// (cowrie.wallet.v1). Reopening /merchant keeps you as the same merchant.
import { Keypair } from "@stellar/stellar-sdk";

const KEY = "cowrie.merchant.v1";

export interface MerchantWallet {
  stellarSecret: string;
  name: string;
  createdAt: number;
}

/** The current merchant identity, or null if none has been created yet. Does NOT
 * auto-provision — the /merchant page decides when to create one. */
export function getMerchant(): MerchantWallet | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as MerchantWallet;
    return m.stellarSecret && m.name ? m : null;
  } catch {
    return null;
  }
}

/** Provision a fresh merchant identity for `name` (new receiving account).
 * Callers MUST pass a validated non-empty name (see lib/names.ts) — there is no
 * default/placeholder merchant. */
export function createMerchant(name: string): MerchantWallet {
  const m: MerchantWallet = { stellarSecret: Keypair.random().secret(), name: name.trim(), createdAt: Date.now() };
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(m));
  return m;
}

export function saveMerchant(m: MerchantWallet): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(m));
}

/** Forget the current merchant (demo "switch/reset merchant"). */
export function clearMerchant(): void {
  if (typeof window !== "undefined") localStorage.removeItem(KEY);
}

export function merchantKeypair(m: MerchantWallet): Keypair {
  return Keypair.fromSecret(m.stellarSecret);
}

export function merchantPublicKey(m: MerchantWallet): string {
  return merchantKeypair(m).publicKey();
}
