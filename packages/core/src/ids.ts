/**
 * Identifiers.
 *
 * The legacy app mints ids with `Math.random().toString(36).slice(2, 10)` — 8 base-36 characters,
 * about 41 bits. That is fine when one browser tab is the only thing minting them and a collision
 * only has to be unlikely within one file. It is NOT fine once several clients mint ids
 * concurrently into a shared document and nothing downstream can tell a collision from an edit to
 * an existing row.
 *
 * So new ids are 128-bit, from the platform CSPRNG, and carry a type prefix. Legacy ids are left
 * exactly as they are on import: rewriting them would break every cross-reference in files people
 * already have (anchors, binds, deliverable refs), and the id's job is only to be unique, not to
 * be pretty.
 */

/** Prefixes match the legacy app's, so an id keeps saying what it points at. */
export const ID_PREFIX = {
  chart: 'c_',
  node: 'n_',
  flow: 'b_',
  step: 't_',
  edge: 'e_',
  group: 'g_',
  artifact: 'a_',
  entity: 'ent_',
  doc: 'doc_',
  division: 'dv_',
  branch: 'br_',
  team: 'tm_',
  person: 'p_',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += HEX[(b >> 4)! & 0xf]! + HEX[b & 0xf]!;
  return out;
}

/**
 * A fresh id for `kind`. 16 random bytes: at a billion ids the collision probability is around
 * 1e-21, which is what lets any client mint one without asking the server first — the property
 * the whole offline-capable, collaborative design rests on.
 */
export function newId(kind: IdKind): string {
  return ID_PREFIX[kind] + randomHex(16);
}

/** True when `id` looks like an id this module minted for `kind`. Legacy ids will NOT match. */
export function isIdOf(kind: IdKind, id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(ID_PREFIX[kind]);
}

/**
 * Accept an incoming id or mint one. Used all through the legacy import: a file's own ids are
 * authoritative because everything else in that file points at them.
 */
export function keepOrMint(kind: IdKind, existing: unknown): string {
  return typeof existing === 'string' && existing.length > 0 ? existing : newId(kind);
}
