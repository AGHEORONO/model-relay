/** Money is kept in integer cents to avoid float drift. */
export const toCents = (amount) => Math.round(amount * 100);
export const fromCents = (cents) => cents / 100;

/** Split `cents` into `parts` integer shares that add back up exactly. */
export function splitCents(cents, parts) {
  const base = Math.floor(cents / parts);
  const shares = Array(parts).fill(base);
  return shares;
}
