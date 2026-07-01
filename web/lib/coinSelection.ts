// Coin selection for arbitrary-amount spends (Phase R1).
//
// The circuit is 2-INPUT max. To pay `amount`, the wallet must cover it with AT
// MOST 2 unspent notes (a mix of fixed-denomination deposit notes and
// arbitrary-valued change notes). Whatever the chosen notes sum to beyond
// `amount` comes back as a single change note owned by the payer.
//
// Strategy (cash-like, minimize leftover change while keeping it to <=2 notes):
//   1. If any SINGLE note >= amount, spend the smallest such note (least change).
//   2. Else pick the 2 notes whose sum >= amount with the SMALLEST sum (least
//      change), i.e. tightest cover. This also naturally consumes small notes.
//   3. If no <=2-note combination covers the amount, return a "cannot cover"
//      result carrying the largest payable now (best single OR best pair), so the
//      UI can say exactly how much CAN be paid.
import type { Note } from "./wallet";

export interface Selection {
  ok: true;
  notes: Note[]; // 1 or 2 notes to spend
  total: number; // sum of selected notes
  change: number; // total - amount (>= 0), minted back to payer
}
export interface SelectionFail {
  ok: false;
  reason: "empty" | "uncoverable";
  largestPayable: number; // biggest amount coverable with <=2 notes right now
}
export type SelectionResult = Selection | SelectionFail;

/** Largest amount coverable with at most 2 notes = sum of the two largest notes
 * (or the single largest if only one note). */
export function largestPayable(notes: Note[]): number {
  const amts = notes.map((n) => n.amount).sort((a, b) => b - a);
  if (amts.length === 0) return 0;
  if (amts.length === 1) return amts[0];
  return amts[0] + amts[1];
}

export function selectCoins(allNotes: Note[], amount: number): SelectionResult {
  const spendable = allNotes.filter((n) => !n.spent && n.amount > 0);
  if (spendable.length === 0) return { ok: false, reason: "empty", largestPayable: 0 };
  if (!(amount > 0)) return { ok: false, reason: "uncoverable", largestPayable: largestPayable(spendable) };

  // 1. Best single note that covers (smallest such note => least change).
  const singles = spendable.filter((n) => n.amount >= amount).sort((a, b) => a.amount - b.amount);
  if (singles.length > 0) {
    const note = singles[0];
    return { ok: true, notes: [note], total: note.amount, change: note.amount - amount };
  }

  // 2. Best PAIR that covers (smallest covering sum => least change). O(n^2) over
  // a small wallet is fine. Ties broken by preferring to consume a smaller note.
  let best: { a: Note; b: Note; total: number } | null = null;
  for (let i = 0; i < spendable.length; i++) {
    for (let j = i + 1; j < spendable.length; j++) {
      const total = spendable[i].amount + spendable[j].amount;
      if (total < amount) continue;
      if (!best || total < best.total) best = { a: spendable[i], b: spendable[j], total };
    }
  }
  if (best) {
    return { ok: true, notes: [best.a, best.b], total: best.total, change: best.total - amount };
  }

  // 3. Cannot cover with <=2 notes.
  return { ok: false, reason: "uncoverable", largestPayable: largestPayable(spendable) };
}
