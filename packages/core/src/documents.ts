/**
 * Process documents: the bytes behind a DocRef, and the text forms they travel in.
 *
 * A row's `documents[]` in the shared document carries metadata only ({id, name, type, size}). The
 * bytes live outside it — in IndexedDB in index.html, in `document_blob` here — keyed by the same
 * id, because a base64 file inside a CRDT would ride along in every update and sit in every
 * peer's memory.
 *
 * The bytes still cross one text boundary, and it is index.html's: the v0.39 JSON file embeds
 * each attachment as `dataUrl: "data:<type>;base64,…"` (Save hydrates every doc from IndexedDB
 * first, so the file is self-contained), and Load/Merge store those bytes back under the doc's
 * own id. The conversions here are the ones index.html does with FileReader.readAsDataURL and
 * docToBlob, written against Uint8Array so the browser and the server share one implementation.
 * The tests run index.html's own docToBlob against them, so a file this module writes is one the
 * single-file app can open.
 */

import type { Workspace } from './schema.js';

/**
 * index.html's MAX_DOC_BYTES: 3 MiB per file. There it is a soft cap, enforced where a file is
 * picked, and a larger file is refused with an alert rather than attached. The same number is the
 * limit on every path into the blob store, so no route stores a file the picker would refuse.
 */
export const MAX_DOC_BYTES = 3 * 1024 * 1024;

/**
 * index.html's fmtBytes, verbatim in behaviour: "0 B", "1023 B", "1.5 KB", "12 KB", "3.0 MB".
 * One decimal below 10 of a unit, none above. Kept identical so a size or a refusal reads the
 * same in both apps.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** The message index.html's picker alerts with for a file over the cap. */
export function oversizeMessage(name: string, size: number): string {
  return `"${name}" is ${formatBytes(size)} — over the ${formatBytes(MAX_DOC_BYTES)} per-file cap. Skipped.`;
}

// ---- base64 --------------------------------------------------------------------------------------
// Hand-rolled because this package runs in the browser and on the server alike: Node's Buffer is
// not in the browser, and btoa/atob work on "binary strings", which for a 3 MB file means a 3M-
// character intermediate and a char-by-char copy on both sides.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENCODE = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;
const PAD = 0x3d; // '='

/** Standard base64 (RFC 4648 §4), padded — what readAsDataURL writes. */
export function bytesToBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  const whole = bytes.length - (bytes.length % 3);
  let o = 0;
  for (let i = 0; i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = ENCODE[n >> 18]!;
    out[o++] = ENCODE[(n >> 12) & 63]!;
    out[o++] = ENCODE[(n >> 6) & 63]!;
    out[o++] = ENCODE[n & 63]!;
  }
  if (bytes.length > whole) {
    const two = bytes.length - whole === 2;
    const n = (bytes[whole]! << 16) | (two ? bytes[whole + 1]! << 8 : 0);
    out[o++] = ENCODE[n >> 18]!;
    out[o++] = ENCODE[(n >> 12) & 63]!;
    out[o++] = two ? ENCODE[(n >> 6) & 63]! : PAD;
    out[o++] = PAD;
  }
  // Every byte is ASCII, so decoding it as UTF-8 is the identity.
  return new TextDecoder().decode(out);
}

/**
 * Decode base64 exactly as the browser's atob does — the WHATWG "forgiving-base64 decode" — or
 * return null where atob would throw. ASCII whitespace is ignored and padding is optional; any
 * other character outside the alphabet, the URL-safe `-` and `_` included, is a failure.
 *
 * Matching atob rather than being more lenient is the point: index.html opens a document with
 * atob, so a dataUrl accepted here and refused there would be a file that imports cleanly and
 * then cannot be opened in the app it came from.
 */
export function base64ToBytes(text: string): Uint8Array | null {
  let s = /[\t\n\f\r ]/.test(text) ? text.replace(/[\t\n\f\r ]+/g, '') : text;
  if (s.length % 4 === 0) {
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
  }
  if (s.length % 4 === 1) return null;

  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? DECODE[c]! : -1;
    if (v < 0) return null;
    // Only the low 12 bits are ever still owed a byte, so the mask keeps `acc` small without
    // changing what is read out of it.
    acc = ((acc << 6) | v) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ---- data URLs -------------------------------------------------------------------------------------

/** RFC 9110 §8.3.1 media-type: `type/subtype`, then parameters, printable ASCII throughout. */
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[^"\\\\\\x00-\\x08\\x0a-\\x1f\\x7f-\\uffff]|\\\\[\\t\\x20-\\x7e])*"';
const MEDIA_TYPE = new RegExp(
  `^${TOKEN}/${TOKEN}(?:[ \\t]*;[ \\t]*(?:${TOKEN}=(?:${TOKEN}|${QUOTED}))?)*$`,
);

/**
 * A content type that is safe to store and to send back as a header, or '' for "unknown".
 *
 * A doc's type arrives from a request header, from a data URL, or from the `type` field of a file
 * someone may have edited by hand. The stored value is later written verbatim into a
 * Content-Type header, where a stray newline or non-ASCII character makes Node throw — so every
 * one is checked against the HTTP media-type grammar on the way IN, and anything else is recorded
 * as unknown rather than failing every later download of that file.
 */
export function normalizeContentType(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  return value.length <= 255 && MEDIA_TYPE.test(value) ? value : '';
}

/** The media type without its parameters, lower-cased: `Text/HTML; charset=x` → `text/html`. */
export function contentTypeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Bytes as the data URL index.html embeds in a saved file. A file with no known type is written
 * as application/octet-stream, which is what readAsDataURL itself writes for one.
 */
export function encodeDataUrl(bytes: Uint8Array, type: string): string {
  return `data:${normalizeContentType(type) || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

export interface DecodedDataUrl {
  /** The data URL's own media type, parameters kept, base64 flag dropped. '' when it names none. */
  readonly type: string;
  readonly bytes: Uint8Array;
}

/**
 * A data URL's bytes, decoded as index.html's docToBlob decodes them, or null where docToBlob
 * would fail: base64 through atob, anything else through decodeURIComponent and then UTF-8.
 *
 * One departure: a base64 payload may be wrapped across lines. docToBlob's regex stops at a line
 * break and so cannot open such a file, but the atob behind it strips the breaks, so the bytes
 * are intact — and once stored here, the rebuild's Save writes them back unwrapped, in a form
 * index.html does open.
 */
export function decodeDataUrl(dataUrl: string): DecodedDataUrl | null {
  const m = /^data:([^,]*),(.*)$/is.exec(dataUrl);
  if (!m) return null;
  const header = m[1]!;
  const payload = m[2]!;
  // docToBlob tests for ";base64," anywhere in the URL; in anything it can decode, that is the end
  // of the header. Reading it there keeps a percent-encoded payload that happens to contain the
  // text from being fed to atob.
  const base64 = /;base64$/i.test(header);
  const type = normalizeContentType(base64 ? header.slice(0, -';base64'.length) : header);

  if (base64) {
    const bytes = base64ToBytes(payload);
    return bytes ? { type, bytes } : null;
  }
  try {
    return { type, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null; // a malformed percent-escape: docToBlob's decodeURIComponent throws on it too
  }
}

// ---- documents in a file ---------------------------------------------------------------------------

/** One attachment as a v0.39 file carries it: the DocRef's identity plus its bytes. */
export interface EmbeddedDocument {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly dataUrl: string;
}

/** An embedded document decoded and checked, ready for the blob store. */
export interface PreparedDocument {
  readonly id: string;
  readonly name: string;
  /** The data URL's own type first, then the DocRef's — the order docToBlob reads them in. */
  readonly type: string;
  readonly bytes: Uint8Array;
}

export type PreparedEmbeddedDocument =
  | { readonly ok: true; readonly doc: PreparedDocument }
  | { readonly ok: false; readonly id: string; readonly reason: string };

/**
 * Decode one embedded document and hold it to the upload rules, so a file brought in through an
 * import is held to exactly what a file attached through the picker is.
 *
 * A refusal carries a sentence for a person, not a code: the one caller that shows it is an
 * import report, and index.html answers the same two failures with an alert.
 */
export function prepareEmbeddedDocument(doc: EmbeddedDocument): PreparedEmbeddedDocument {
  const name = doc.name || 'document';
  const decoded = decodeDataUrl(doc.dataUrl);
  if (!decoded) {
    return {
      ok: false,
      id: doc.id,
      reason: `Failed to read "${name}" — its embedded data is not a valid data URL. Skipped.`,
    };
  }
  if (decoded.bytes.length > MAX_DOC_BYTES) {
    return { ok: false, id: doc.id, reason: oversizeMessage(name, decoded.bytes.length) };
  }
  return {
    ok: true,
    doc: {
      id: doc.id,
      name,
      type: decoded.type || normalizeContentType(doc.type),
      bytes: decoded.bytes,
    },
  };
}

/**
 * Every doc id the workspace references: chart rows' documents and deliverables' spec docs —
 * the two places index.html's eachDocInState walks. Flow steps carry no documents.
 */
export function workspaceDocumentIds(ws: Workspace): string[] {
  const ids = new Set<string>();
  for (const chart of Object.values(ws.charts)) {
    for (const node of Object.values(chart.nodes)) {
      for (const doc of node.documents) ids.add(doc.id);
    }
  }
  for (const artifact of Object.values(ws.artifacts)) {
    if (artifact.doc) ids.add(artifact.doc.id);
  }
  return [...ids];
}
