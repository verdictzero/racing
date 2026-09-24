/**
 * Attach a file: store its bytes under a doc id the client minted.
 *
 *   PUT /api/workspaces/:id/documents/:docId
 *   body          the raw file bytes
 *   Content-Type  the file's type (may be absent)
 *   X-File-Name   the file name, encodeURIComponent-encoded
 *   → 200 { id, name, type, size }, the DocRef the client writes into the row
 *
 * The client mints the id, not the server, so the DocRef and its bytes can be named before either
 * exists — and so an import can keep the ids its rows already reference. That makes this a PUT:
 * the same request twice replaces the file instead of attaching it twice.
 *
 * The client should write the row's DocRef, through the document, only once this has answered.
 * The other order puts a document chip on everyone's screen that opens nothing.
 */
import { normalizeContentType } from '@raci/core';
import { putDocumentBlob, recordAudit } from '@raci/db';

export default defineEventHandler(async (event) => {
  const { session, workspaceId } = await requireDocumentWorkspace(event, 'editor');
  const docId = requireDocumentId(event);
  const name = documentFileName(getRequestHeader(event, 'x-file-name'));
  const bytes = await readDocumentUpload(event, name);
  const db = useDb();

  const stored = await putDocumentBlob(db, {
    workspaceId,
    id: docId,
    filename: name,
    contentType: normalizeContentType(getRequestHeader(event, 'content-type')),
    bytes,
    uploadedBy: session.userId,
  });

  await recordAudit(db, {
    organizationId: session.organizationId,
    workspaceId,
    userId: session.userId,
    action: 'document.upload',
    targetKind: 'document',
    targetId: docId,
    detail: { name: stored.filename, size: stored.byteSize },
  });

  return { id: stored.id, name: stored.filename, type: stored.contentType, size: stored.byteSize };
});
