/**
 * Open or download an attached file.
 *
 *   GET /api/workspaces/:id/documents/:docId              inline — a PDF or image opens in the tab
 *   GET /api/workspaces/:id/documents/:docId?download=1   attachment — always saved
 *
 * index.html opens a document chip in a new tab and downloads from the Details panel; these are
 * the same two gestures, as URLs a link can point at. Anyone who can read the workspace can read
 * its documents, the same line the chart itself is drawn on.
 */
import { getDocumentBlob } from '@raci/db';

export default defineEventHandler(async (event) => {
  const { workspaceId } = await requireDocumentWorkspace(event, 'viewer');
  const docId = requireDocumentId(event);

  const doc = await getDocumentBlob(useDb(), workspaceId, docId);
  // No bytes also covers a row that names a file whose bytes never arrived — an import that
  // skipped one over the cap — which is as absent as a file can be.
  if (!doc?.bytes) throw createError({ statusCode: 404, statusMessage: 'No such document' });

  const download = getQuery(event).download;
  setResponseHeaders(event, documentResponseHeaders(doc, download === '1' || download === 'true'));
  return doc.bytes;
});
