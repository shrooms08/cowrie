// Local name claims (Phase R4). Names are a LOCAL claim in this demo — a
// production version would use an on-chain name registry for global uniqueness.
// Here there is a single local user, so no collisions are possible; these
// helpers only validate/normalize shape.

/** A buyer handle is a slug used as "<handle>.cowrie": lowercase letters, digits
 * and hyphens, 2–20 chars. */
export function slugifyHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}
export function isValidHandle(raw: string): boolean {
  const s = slugifyHandle(raw);
  return s.length >= 2 && s.length <= 20;
}

/** A merchant/business name: printable, 2–40 chars, no control chars. */
export function isValidBusinessName(raw: string): boolean {
  const n = raw.trim();
  return n.length >= 2 && n.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N} .,'&_-]*$/u.test(n);
}
export function normalizeBusinessName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 40);
}
