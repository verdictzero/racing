/**
 * Create a workspace, optionally seeded from a legacy v0.39 JSON file.
 *
 * The import path is what makes this usable on day one: an organization's existing work is in
 * those files, and a tool they have to re-key everything into is a tool they will not adopt.
 */
import { z } from 'zod';
import { clearedWorkspace, emptyWorkspace, importLegacy } from '@raci/core';
import { docFromWorkspace } from '@raci/crdt';
import { appendUpdate, createWorkspace, recordAudit, storeEmbeddedDocuments } from '@raci/db';
import * as Y from 'yjs';

const Body = z.object({
  name: z.string().min(1).max(200),
  /** A workspace JSON file exported by index.html. */
  legacy: z.unknown().optional(),
});

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'editor');
  const body = Body.parse(await readBody(event));
  const db = useDb();

  const workspace = await createWorkspace(db, {
    organizationId: session.organizationId,
    name: body.name,
    createdBy: session.userId,
  });

  let report = null;
  if (body.legacy === undefined) {
    // index.html can never be without a chart — its ac() makes an "Untitled chart" the moment there
    // is none — so a new workspace starts where the source's Clear leaves it: one blank chart, the
    // six directorates empty, the default labels. An empty document would open on a bare screen
    // with no tab, no pane and nothing to click.
    await appendUpdate(db, {
      workspaceId: workspace.id,
      update: Y.encodeStateAsUpdate(docFromWorkspace(clearedWorkspace(emptyWorkspace()))),
      userId: session.userId,
      origin: 'create',
    });
  } else {
    const imported = importLegacy(body.legacy);
    const doc = docFromWorkspace(imported.workspace);
    await appendUpdate(db, {
      workspaceId: workspace.id,
      update: Y.encodeStateAsUpdate(doc),
      userId: session.userId,
      origin: 'import',
    });

    // The file carries each attachment's bytes inline, as index.html's Save writes them. The
    // document keeps only the metadata, so the bytes go to the blob store under the ids the
    // imported rows already hold. One that cannot be kept — over the size cap, or undecodable —
    // becomes a warning in the report rather than the end of an import that is otherwise fine.
    const documents = await storeEmbeddedDocuments(db, {
      workspaceId: workspace.id,
      uploadedBy: session.userId,
      docs: imported.attachments,
    });
    report = {
      ...imported.report,
      documents: documents.stored,
      warnings: [...imported.report.warnings, ...documents.skipped.map((s) => s.reason)],
    };
  }

  await recordAudit(db, {
    organizationId: session.organizationId,
    workspaceId: workspace.id,
    userId: session.userId,
    action: 'workspace.create',
    detail: report ? { imported: report } : {},
  });

  return { workspace: { id: workspace.id, name: workspace.name }, report };
});
