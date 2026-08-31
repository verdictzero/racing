/**
 * Fractional indexing — ordering keys that two people can insert between without a merge.
 *
 * WHY THIS EXISTS
 * The legacy model stored sibling order as array position: `parent.children[]`. That is the one
 * thing a CRDT cannot merge sensibly. Two people inserting "at index 2" of the same list produce
 * two different intents that array-index reconciliation cannot tell apart, and a move is
 * delete+insert, which under concurrency duplicates or destroys the row.
 *
 * So order is a STRING key on each node instead, and the list is whatever you get by sorting on
 * it. Inserting between two rows means minting a key strictly between their keys — a pure
 * function of its two neighbours, so two clients doing it concurrently produce two different keys
 * that both land in the right place. No coordination, no merge step.
 *
 * THE ENCODING
 * A key is the fractional part of a base-62 number in the open interval (0, 1): the key "V" means
 * 0.V, and "Vl" means 0.Vl. Because the interval is open at both ends there is always room before
 * the first row and after the last, so the integer-part machinery that the general-purpose
 * implementations carry is not needed here.
 *
 * Digits are ordered by ASCII, so lexicographic string comparison IS numeric comparison and the
 * database can sort on the column directly.
 *
 * THE ONE INVARIANT: no key may end in the lowest digit ('0'). "V0" and "V" denote the same
 * number, and the midpoint algorithm needs a unique representation to terminate. Every key this
 * module mints satisfies it; `isOrderKey` is how you check one that came from elsewhere.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62

export class OrderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderKeyError';
  }
}

/** True when `key` is a well-formed order key: non-empty, known digits, no trailing '0'. */
export function isOrderKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0) return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  return !key.endsWith('0');
}

/**
 * A string strictly between `a` and `b`.
 * `a === ''` means "before everything"; `b === null` means "after everything".
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new OrderKeyError(`order keys out of sequence: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
  }
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) {
    throw new OrderKeyError(`order key has a trailing zero: ${JSON.stringify(a.endsWith('0') ? a : b)}`);
  }

  if (b !== null) {
    // Walk past the shared prefix and recurse on what differs. A missing digit in `a` reads as
    // '0' because "V" and "V0…" start at the same place.
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a.length > 0 ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : BASE;

  // Room between the leading digits: take the one in the middle and stop.
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  }

  // Leading digits are adjacent. If `b` has more to give, borrow its first digit and let the
  // recursion find room underneath it.
  if (b !== null && b.length > 1) return b.slice(0, 1);

  // Otherwise descend into `a`'s tail: the answer is a's leading digit followed by something
  // after the rest of a.
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * Mint an order key that sorts strictly between `before` and `after`.
 * Pass null for either end to mean "nothing on that side".
 *
 *   keyBetween(null, null) -> the first key in an empty list
 *   keyBetween(last, null) -> append
 *   keyBetween(null, first) -> prepend
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && !isOrderKey(before)) {
    throw new OrderKeyError(`not an order key: ${JSON.stringify(before)}`);
  }
  if (after !== null && !isOrderKey(after)) {
    throw new OrderKeyError(`not an order key: ${JSON.stringify(after)}`);
  }
  if (before !== null && after !== null && before >= after) {
    throw new OrderKeyError(`${JSON.stringify(before)} does not sort before ${JSON.stringify(after)}`);
  }
  return midpoint(before ?? '', after);
}

/**
 * `n` evenly spread keys between two neighbours — for seeding a list, or for importing a
 * spreadsheet whose rows already have an order. Bisecting repeatedly instead of appending keeps
 * the keys short, which matters when a chart carries hundreds of rows.
 */
export function keysBetween(before: string | null, after: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(before, after)];
  const mid = keyBetween(before, after);
  const half = Math.floor(n / 2);
  return [...keysBetween(before, mid, half), mid, ...keysBetween(mid, after, n - half - 1)];
}

/** Sort helper: ascending by order key, with the id as a deterministic tie-break. */
export function byOrder<T extends { order: string; id: string }>(a: T, b: T): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  // Two nodes CAN end up sharing an order key — two clients inserting into an empty list with no
  // neighbours to bisect both mint the middle key. The list still has to be stable and identical
  // on every client, so the id decides. Nothing is lost; the rows just sit in id order.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
