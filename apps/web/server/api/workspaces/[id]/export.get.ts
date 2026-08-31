/**
 * Download a workspace in one of the document formats.
 *
 *   /api/workspaces/:id/export?format=xml
 *   /api/workspaces/:id/export?format=mermaid&chartId=c_…
 *   /api/workspaces/:id/export?format=mermaid&flowId=b_…
 *   /api/workspaces/:id/export?format=json          the v0.39 file index.html reads
 *
 * The JSON format is the interoperability one and matters most: it is what lets someone take
 * their work back to the single-file app, or email it to a colleague who has no account. As long
 * as this works, adopting the server version is not a one-way door.
 */

import { z } from 'zod';
import { exportChartMermaid, exportFlowMermaid, exportLegacy, exportXml } from '@raci/core';
import { readWorkspace } from '@raci/crdt';
import { getWorkspace, loadDoc, recordAudit } from '@raci/db';

const Query = z.object({
  format: z.enum(['xml', 'mermaid', 'json']).default('json'),
  chartId: z.string().optional(),
  flowId: z.string().optional(),
});

/** A filename that survives a download on every OS. */
function safeFilename(name: string, extension: string): string {
  const base = name.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_') || 'workspace';
  return `${base.slice(0, 80)}.${extension}`;
}

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const id = getRouterParam(event, 'id')!;
  const query = Query.parse(getQuery(event));
  const db = useDb();

  const record = await getWorkspace(db, session.organizationId, id);
  if (!record) throw createError({ statusCode: 404, statusMessage: 'No such workspace' });

  // An export reads the whole document, unlike the gallery listing, so it goes to the CRDT rather
  // than the projection.
  const { doc } = await loadDoc(db, id);
  const workspace = readWorkspace(doc);

  await recordAudit(db, {
    organizationId: session.organizationId,
    workspaceId: id,
    userId: session.userId,
    action: 'workspace.export',
    detail: { format: query.format },
  });

  let body: string;
  let contentType: string;
  let extension: string;

  switch (query.format) {
    case 'xml':
      body = exportXml(workspace, { chartId: query.chartId, generatedBy: session.displayName });
      contentType = 'application/xml; charset=utf-8';
      extension = 'xml';
      break;

    case 'mermaid':
      if (query.flowId) {
        if (!workspace.flows[query.flowId]) {
          throw createError({ statusCode: 404, statusMessage: 'No such flow in this workspace' });
        }
        body = exportFlowMermaid(workspace, query.flowId);
      } else {
        if (query.chartId && !workspace.charts[query.chartId]) {
          throw createError({ statusCode: 404, statusMessage: 'No such chart in this workspace' });
        }
        body = exportChartMermaid(workspace, { chartId: query.chartId });
      }
      contentType = 'text/vnd.mermaid; charset=utf-8';
      extension = 'mmd';
      break;

    case 'json':
      body = JSON.stringify(exportLegacy(workspace), null, 2);
      contentType = 'application/json; charset=utf-8';
      extension = 'json';
      break;
  }

  setHeader(event, 'content-type', contentType);
  setHeader(
    event,
    'content-disposition',
    `attachment; filename="${safeFilename(record.name, extension)}"`,
  );
  // Exports reflect a document that changes continuously; a cached one would be wrong the moment
  // anybody edits.
  setHeader(event, 'cache-control', 'no-store');
  return body;
});
