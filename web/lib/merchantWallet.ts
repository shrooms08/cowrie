// Persistent merchant identity for the register (Phase R2-1). A merchant needs a
// real Stellar account with a USDC trustline to RECEIVE the on-chain payout. We
// auto-provision one (friendbot XLM + USDC trustline) and persist it, then embed
// its address in the buyer pay-link so the pool can send real USDC to it.
//
// Shares localStorage origin with the buyer wallet, so the buyer's Pay screen can
// fall back to this address for manually-typed (non-pay-link) merchant payments.
import { Keypair } from "@stellar/stellar-sdk";

const KEY = "cowrie.merchant.v1";

export interface MerchantWallet {
  stellarSecret: string;
  name: string;
}

export function loadMerchant(): MerchantWallet {
  if (typeof window !== "undefined") {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as MerchantWallet;
      } catch {
        /* fall through */
      }
    }
  }
  const m: MerchantWallet = { stellarSecret: Keypair.random().secret(), name: "Buka Express" };
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(m));
  return m;
}

export function saveMerchant(m: MerchantWallet): void {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(m));
}

export function merchantKeypair(m: MerchantWallet): Keypair {
  return Keypair.fromSecret(m.stellarSecret);
}

export function merchantPublicKey(m: MerchantWallet): string {
  return merchantKeypair(m).publicKey();
}
