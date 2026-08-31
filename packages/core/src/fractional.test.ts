import { describe, it, expect } from 'vitest';
import { keyBetween, keysBetween, isOrderKey, byOrder, OrderKeyError } from './fractional.js';

describe('keyBetween', () => {
  it('mints a first key for an empty list', () => {
    const k = keyBetween(null, null);
    expect(isOrderKey(k)).toBe(true);
  });

  it('appends after a key', () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(b > a).toBe(true);
  });

  it('prepends before a key', () => {
    const a = keyBetween(null, null);
    const b = keyBetween(null, a);
    expect(b < a).toBe(true);
  });

  it('lands strictly between two neighbours', () => {
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    const b = keyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('keeps finding room between adjacent keys, however many times', () => {
    // The property that matters: you can always insert again. If this terminates, no sequence of
    // inserts at one spot can ever run out of space.
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    for (let i = 0; i < 500; i++) {
      const mid = keyBetween(lo, hi);
      expect(lo < mid, `iteration ${i}: ${lo} < ${mid}`).toBe(true);
      expect(mid < hi, `iteration ${i}: ${mid} < ${hi}`).toBe(true);
      expect(isOrderKey(mid)).toBe(true);
      lo = mid; // squeeze from the bottom so the interval keeps shrinking
    }
  });

  it('never produces a key with a trailing zero', () => {
    let prev: string | null = null;
    for (let i = 0; i < 200; i++) {
      const k: string = keyBetween(prev, null);
      expect(k.endsWith('0')).toBe(false);
      prev = k;
    }
  });

  it('rejects neighbours in the wrong order', () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(() => keyBetween(b, a)).toThrow(OrderKeyError);
  });

  it('rejects malformed keys rather than producing nonsense', () => {
    expect(() => keyBetween('!!', null)).toThrow(OrderKeyError);
    expect(() => keyBetween('V0', null)).toThrow(OrderKeyError);
    expect(() => keyBetween('', null)).toThrow(OrderKeyError);
  });
});

describe('concurrent insertion', () => {
  it('lets two clients insert at the same spot without coordinating', () => {
    // Both clients see [a, c] and both insert between. Neither knows about the other.
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    const clientOne = keyBetween(a, c);
    const clientTwo = keyBetween(a, c);

    // They mint the same key here, which is fine: both rows survive, and byOrder breaks the tie
    // deterministically so every client shows the same list.
    const rows = [
      { id: 'n_two', order: clientTwo },
      { id: 'n_one', order: clientOne },
      { id: 'n_c', order: c },
      { id: 'n_a', order: a },
    ].sort(byOrder);

    expect(rows.map((r) => r.id)).toEqual(['n_a', 'n_one', 'n_two', 'n_c']);
  });

  it('is order-independent: the same set of keys sorts the same however it arrives', () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const mid = keyBetween(a, b);
    const rows = [
      { id: '1', order: a },
      { id: '2', order: mid },
      { id: '3', order: b },
    ];
    const forwards = [...rows].sort(byOrder).map((r) => r.id);
    const backwards = [...rows].reverse().sort(byOrder).map((r) => r.id);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(['1', '2', '3']);
  });
});

describe('keysBetween', () => {
  it('returns n keys in ascending order', () => {
    const keys = keysBetween(null, null, 25);
    expect(keys).toHaveLength(25);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
    keys.forEach((k) => expect(isOrderKey(k)).toBe(true));
  });

  it('stays inside its bounds', () => {
    const lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    const keys = keysBetween(lo, hi, 10);
    keys.forEach((k) => {
      expect(k > lo).toBe(true);
      expect(k < hi).toBe(true);
    });
  });

  it('bisects rather than chains, so keys stay short on a big import', () => {
    // 800 rows is a realistic chart import. Appending one after another would grow the key by a
    // character every 62 rows; bisecting keeps them near log62(n).
    const keys = keysBetween(null, null, 800);
    const longest = Math.max(...keys.map((k) => k.length));
    expect(longest).toBeLessThanOrEqual(4);
  });

  it('returns nothing for a non-positive count', () => {
    expect(keysBetween(null, null, 0)).toEqual([]);
    expect(keysBetween(null, null, -3)).toEqual([]);
  });
});
