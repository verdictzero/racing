/**
 * Download a workspace in one of the document formats.
 *
 *   /api/workspaces/:id/export?format=xml
 *   /api/workspaces/:id/export?format=mermaid&chartId=c_…
 *   /api/workspaces/:id/export?format=mermaid&flowId=b_…
 *   /api/workspaces/:id/export?format=json          the v0.39 file index.html reads
 *   /api/workspaces/:id/export?format=xlsx          a workbook, one sheet per tier
 *   /api/workspaces/:id/export?format=template      the blank workbook the importer reads back
 *   /api/workspaces/:id/export?format=pptx&chartId=c_…&locale=en-US&tz=America/New_York
 *                                                   one chart as a PowerPoint deck
 *
 * The JSON format is the interoperability one and matters most: it is what lets someone take
 * their work back to the single-file app, or email it to a colleague who has no account. As long
 * as this works, adopting the server version is not a one-way door.
 */

import { z } from 'zod';
import {
  PPTX_CONTENT_TYPE,
  chartFileBase,
  chartToPptx,
  chartsInTabOrder,
  exportChartMermaid,
  exportFlowMermaid,
  exportLegacy,
  exportTemplate,
  exportXlsx,
  exportXml,
} from '@raci/core';
import { readWorkspace } from '@raci/crdt';
import { getWorkspace, loadDoc, recordAudit } from '@raci/db';

const Query = z.object({
  format: z.enum(['xml', 'mermaid', 'json', 'xlsx', 'template', 'pptx']).default('json'),
  chartId: z.string().optional(),
  flowId: z.string().optional(),
  /**
   * How the deck's "signed" date is written. index.html prints it in the reader's own locale and
   * timezone, so the page passes the browser's; without them it is the server's, which on a UTC
   * host moves an evening signature in the Americas onto the next day.
   */
  locale: z.string().max(64).optional(),
  tz: z.string().max(64).optional(),
});

/**
 * Keep only what this server's `Intl` understands. An unknown locale or zone is dropped rather than
 * failing the download: the date then prints the server's way, a far smaller loss than no deck.
 */
function dateStyle(locale: string | undefined, timeZone: string | undefined) {
  const accepted = (options: { locale?: string; timeZone?: string }) => {
    try {
      const zone = options.timeZone ? { timeZone: options.timeZone } : undefined;
      return !!new Intl.DateTimeFormat(options.locale, zone);
    } catch {
      return false;
    }
  };
  return {
    locale: locale && accepted({ locale }) ? locale : undefined,
    timeZone: timeZone && accepted({ timeZone }) ? timeZone : undefined,
  };
}

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

  // A workbook is bytes, everything else is text. Kept as a union rather than base64'ing the
  // binary case, because h3 sends a Uint8Array as-is and encoding it would only make it bigger.
  let body: string | Uint8Array;
  let contentType: string;
  let extension: string;
  let filename = query.format === 'template' ? 'raci-template' : record.name;

  const SPREADSHEET =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

    case 'xlsx':
      if (query.chartId && !workspace.charts[query.chartId]) {
        throw createError({ statusCode: 404, statusMessage: 'No such chart in this workspace' });
      }
      body = exportXlsx(workspace, { chartId: query.chartId });
      contentType = SPREADSHEET;
      extension = 'xlsx';
      break;

    // The blank template does not depend on the workspace's content, only on its column labels —
    // so a workspace that renamed its parties gets a template with those names on it.
    case 'template':
      body = exportTemplate(workspace);
      contentType = SPREADSHEET;
      extension = 'xlsx';
      break;

    // One chart — the tab in front of the person who asked, or the first tab when they did not
    // say. Named after the chart as index.html names it, since a deck is about one chart.
    case 'pptx': {
      const chart = query.chartId ? workspace.charts[query.chartId] : chartsInTabOrder(workspace)[0];
      if (!chart) {
        throw createError({ statusCode: 404, statusMessage: 'No such chart in this workspace' });
      }
      body = chartToPptx(workspace, chart.id, dateStyle(query.locale, query.tz));
      contentType = PPTX_CONTENT_TYPE;
      extension = 'pptx';
      filename = chartFileBase(chart);
      break;
    }
  }

  setHeader(event, 'content-type', contentType);
  setHeader(event, 'content-disposition', `attachment; filename="${safeFilename(filename, extension)}"`);
  // Exports reflect a document that changes continuously; a cached one would be wrong the moment
  // anybody edits.
  setHeader(event, 'cache-control', 'no-store');
  return body;
});
