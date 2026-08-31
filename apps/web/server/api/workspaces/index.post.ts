/**
 * Create a workspace, optionally seeded from a legacy v0.39 JSON file.
 *
 * The import path is what makes this usable on day one: an organization's existing work is in
 * those files, and a tool they have to re-key everything into is a tool they will not adopt.
 */
import { z } from 'zod';
import { importLegacy } from '@raci/core';
import { docFromWorkspace } from '@raci/crdt';
import { appendUpdate, createWorkspace, recordAudit } from '@raci/db';
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
  if (body.legacy !== undefined) {
    const imported = importLegacy(body.legacy);
    report = imported.report;
    const doc = docFromWorkspace(imported.workspace);
    await appendUpdate(db, {
      workspaceId: workspace.id,
      update: Y.encodeStateAsUpdate(doc),
      userId: session.userId,
      origin: 'import',
    });
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
