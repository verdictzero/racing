/**
 * Remove an attached file's bytes.
 *
 *   DELETE /api/workspaces/:id/documents/:docId → 204
 *
 * What index.html's deleteDocument does to IndexedDB when a document is removed from a row. The
 * row's DocRef is the client's to remove, through the document, as it is the client's to add.
 *
 * A 204 whether or not anything was stored: the caller wants the bytes gone, and a retried
 * delete, or one for a file whose upload never landed, has got what it asked for.
 */
import { deleteDocumentBlob, recordAudit } from '@raci/db';

export default defineEventHandler(async (event) => {
  const { session, workspaceId } = await requireDocumentWorkspace(event, 'editor');
  const docId = requireDocumentId(event);
  const db = useDb();

  if (await deleteDocumentBlob(db, workspaceId, docId)) {
    await recordAudit(db, {
      organizationId: session.organizationId,
      workspaceId,
      userId: session.userId,
      action: 'document.delete',
      targetKind: 'document',
      targetId: docId,
    });
  }

  return sendNoContent(event, 204);
});
