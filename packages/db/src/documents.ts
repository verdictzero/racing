/**
 * Attachment bytes: the store behind a DocRef.
 *
 * The shared document holds each attachment's metadata; the bytes are here, one row per
 * (workspace, doc id). See `documentBlobs` in schema.ts for why the key has to include the
 * workspace — doc ids come from clients and from files, and are not unique across workspaces.
 *
 * TENANCY works as it does in doc-store.ts: every function takes a workspace id and filters on it,
 * and the caller resolves that id through `getWorkspace(db, orgId, id)` first, which is where the
 * organization filter lives. What this file guarantees is the other half — no path reaches a doc
 * by its id alone, so knowing an id from a file never reaches another workspace's bytes.
 *
 * Only the inline `bytes` column is implemented. `storage_key` exists for a deployment that keeps
 * the bytes in object storage; a write here always clears it, since the bytes it wrote are inline.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { encodeDataUrl, prepareEmbeddedDocument, type EmbeddedDocument } from '@raci/core';
import type { Database } from './client.js';
import { documentBlobs } from './schema.js';

/** A stored document without its bytes — what a listing needs. */
export interface DocumentBlobInfo {
  readonly id: string;
  readonly workspaceId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly uploadedBy: string | null;
  readonly createdAt: Date;
}

export interface DocumentBlob extends DocumentBlobInfo {
  /** Null only in a deployment that keeps the bytes in object storage, under `storageKey`. */
  readonly bytes: Uint8Array | null;
  readonly storageKey: string | null;
}

const INFO = {
  id: documentBlobs.id,
  workspaceId: documentBlobs.workspaceId,
  filename: documentBlobs.filename,
  contentType: documentBlobs.contentType,
  byteSize: documentBlobs.byteSize,
  uploadedBy: documentBlobs.uploadedBy,
  createdAt: documentBlobs.createdAt,
};

const FULL = { ...INFO, bytes: documentBlobs.bytes, storageKey: documentBlobs.storageKey };

export interface PutDocumentParams {
  readonly workspaceId: string;
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly uploadedBy: string | null;
}

/**
 * Store a document's bytes, replacing whatever that workspace held under the id.
 *
 * An upsert rather than an insert because the id is the client's: a retried upload, or an import
 * that re-stores ids its rows already reference, must land on the same row rather than fail. One
 * statement, so two uploads racing for one id leave one of them whole, never a mix.
 */
export async function putDocumentBlob(
  db: Database,
  params: PutDocumentParams,
): Promise<DocumentBlobInfo> {
  const stored = {
    filename: params.filename,
    contentType: params.contentType,
    byteSize: params.bytes.byteLength,
    bytes: params.bytes,
    storageKey: null,
    uploadedBy: params.uploadedBy,
    createdAt: new Date(),
  };
  const [row] = await db
    .insert(documentBlobs)
    .values({ workspaceId: params.workspaceId, id: params.id, ...stored })
    .onConflictDoUpdate({ target: [documentBlobs.workspaceId, documentBlobs.id], set: stored })
    .returning(INFO);
  return row!;
}

/** One document with its bytes, or null when the workspace holds nothing under that id. */
export async function getDocumentBlob(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<DocumentBlob | null> {
  const [row] = await db
    .select(FULL)
    .from(documentBlobs)
    .where(and(eq(documentBlobs.workspaceId, workspaceId), eq(documentBlobs.id, id)))
    .limit(1);
  return row ?? null;
}

/** Several documents with their bytes. Ids the workspace holds nothing under are left out. */
export async function getDocumentBlobs(
  db: Database,
  workspaceId: string,
  ids: readonly string[],
): Promise<DocumentBlob[]> {
  if (ids.length === 0) return [];
  return db
    .select(FULL)
    .from(documentBlobs)
    .where(and(eq(documentBlobs.workspaceId, workspaceId), inArray(documentBlobs.id, [...ids])));
}

/** Every document a workspace holds, metadata only — a listing must not drag every file along. */
export async function listDocumentBlobs(
  db: Database,
  workspaceId: string,
): Promise<DocumentBlobInfo[]> {
  return db
    .select(INFO)
    .from(documentBlobs)
    .where(eq(documentBlobs.workspaceId, workspaceId))
    .orderBy(asc(documentBlobs.createdAt), asc(documentBlobs.id));
}

/** Remove a document's bytes. True when there was something to remove. */
export async function deleteDocumentBlob(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(documentBlobs)
    .where(and(eq(documentBlobs.workspaceId, workspaceId), eq(documentBlobs.id, id)))
    .returning({ id: documentBlobs.id });
  return rows.length > 0;
}

// ---- the legacy file ---------------------------------------------------------------------------------

export interface StoreEmbeddedResult {
  readonly stored: number;
  /** Each refusal with a sentence a person can read, e.g. the over-the-cap message. */
  readonly skipped: Array<{ id: string; reason: string }>;
}

/**
 * Store the attachments a v0.39 file embeds, under the ids its rows already reference.
 *
 * Each is held to the rules an upload is held to (see prepareEmbeddedDocument): one over the size
 * cap, or one whose bytes do not decode, is skipped and reported rather than failing the rest.
 * An import is somebody's whole workspace, and one bad attachment must not cost them the others.
 */
export async function storeEmbeddedDocuments(
  db: Database,
  params: {
    readonly workspaceId: string;
    readonly uploadedBy: string | null;
    readonly docs: readonly EmbeddedDocument[];
  },
): Promise<StoreEmbeddedResult> {
  let stored = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  // One at a time: a decoded file is up to MAX_DOC_BYTES, and holding every one of a large
  // workspace's at once is how an import runs the server out of memory.
  for (const embedded of params.docs) {
    const prepared = prepareEmbeddedDocument(embedded);
    if (!prepared.ok) {
      skipped.push({ id: prepared.id, reason: prepared.reason });
      continue;
    }
    await putDocumentBlob(db, {
      workspaceId: params.workspaceId,
      id: prepared.doc.id,
      filename: prepared.doc.name,
      contentType: prepared.doc.type,
      bytes: prepared.doc.bytes,
      uploadedBy: params.uploadedBy,
    });
    stored++;
  }
  return { stored, skipped };
}

/**
 * The stored bytes behind `ids`, as the data URLs a v0.39 file embeds — the input exportLegacy
 * needs to write a file index.html opens with its attachments. Ids with nothing stored are
 * absent, and the export writes those as '', as index.html does for bytes it cannot find.
 *
 * Read in batches so no more than a batch of files is in memory as bytes at once; the data URLs
 * themselves have to be held, since the file being written contains all of them.
 */
export async function documentDataUrls(
  db: Database,
  workspaceId: string,
  ids: readonly string[],
  batchSize = 20,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += batchSize) {
    for (const blob of await getDocumentBlobs(db, workspaceId, ids.slice(i, i + batchSize))) {
      if (blob.bytes) out.set(blob.id, encodeDataUrl(blob.bytes, blob.contentType));
    }
  }
  return out;
}
