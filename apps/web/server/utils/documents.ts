/**
 * What every /api/workspaces/:id/documents route does before its own work, and the Save export's
 * one call into the blob store.
 */

import { z } from 'zod';
import { MAX_DOC_BYTES, oversizeMessage, workspaceDocumentIds, type Workspace } from '@raci/core';
import { documentDataUrls, getWorkspace, type Database, type Role } from '@raci/db';
import type { H3Event } from 'h3';
import type { SessionContext } from './context';

const WorkspaceId = z.string().uuid();

/**
 * The caller, and the workspace the route names — which must be in the caller's organization.
 *
 * A workspace in another organization is a 404, not a 403: answering "that exists, but not for
 * you" would confirm the id to someone who should learn nothing from it. A malformed id is a 404
 * too, rather than reaching Postgres as a failed uuid cast and coming back as a 500.
 */
export async function requireDocumentWorkspace(
  event: H3Event,
  minimum: Role,
): Promise<{ session: SessionContext; workspaceId: string }> {
  const session = await requireRole(event, minimum);
  const id = WorkspaceId.safeParse(getRouterParam(event, 'id'));
  if (!id.success || !(await getWorkspace(useDb(), session.organizationId, id.data))) {
    throw createError({ statusCode: 404, statusMessage: 'No such workspace' });
  }
  return { session, workspaceId: id.data };
}

const DocId = z.string().min(1).max(256);

/**
 * The doc id in the route, decoded.
 *
 * Decoded because the id is the client's, or a file's, and can hold anything: a client puts it
 * through encodeURIComponent, and "Doc 1" or "a/b" has to be looked up as itself.
 */
export function requireDocumentId(event: H3Event): string {
  const id = DocId.safeParse(getRouterParam(event, 'docId', { decode: true }));
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid document id' });
  return id.data;
}

/**
 * An upload's bytes, refused before they are read when they are over the cap.
 *
 * The declared length is checked first, so an oversized file is turned away without being
 * buffered. A body that declares no length (a chunked stream) is refused outright: the only way
 * to cap one would be to read it. A browser PUTting a File always sends the length.
 */
export async function readDocumentUpload(event: H3Event, name: string): Promise<Uint8Array> {
  const declared = getRequestHeader(event, 'content-length');
  if (declared === undefined) {
    throw createError({
      statusCode: 411,
      statusMessage: 'Length Required',
      message: 'An upload has to declare its size in Content-Length.',
    });
  }
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Content-Length' });
  }
  if (length > MAX_DOC_BYTES) throw tooLarge(name, length);

  const body = (await readRawBody(event, false)) ?? new Uint8Array(0);
  // Node's parser stops at the declared length, so this only guards a runtime that does not.
  if (body.byteLength > MAX_DOC_BYTES) throw tooLarge(name, body.byteLength);
  return body;
}

function tooLarge(name: string, size: number) {
  // The sentence index.html alerts with, carried in `message`: statusMessage becomes the HTTP
  // reason phrase, which may only hold ASCII, and a file name often does not.
  return createError({
    statusCode: 413,
    statusMessage: 'Content Too Large',
    message: oversizeMessage(name, size),
  });
}

/**
 * The bytes of every document the workspace references, as the data URLs a v0.39 file embeds.
 * Only referenced ids are read: a blob whose row was deleted is still stored (undo can bring the
 * row back), but it is not part of the workspace a person would save.
 */
export function attachmentDataUrls(
  db: Database,
  workspaceId: string,
  workspace: Workspace,
): Promise<Map<string, string>> {
  return documentDataUrls(db, workspaceId, workspaceDocumentIds(workspace));
}
