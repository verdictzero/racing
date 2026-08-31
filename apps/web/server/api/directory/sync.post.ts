/**
 * Run a directory sync now. Admin only.
 *
 * `dryRun` reads the directory and reports what WOULD change without writing anything — the thing
 * you want before the first real sync against a production AD, when nobody is yet sure the tier
 * mapping is right.
 */
import { z } from 'zod';

const Body = z.object({
  workspaceId: z.string().uuid(),
  dryRun: z.boolean().optional(),
});

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin');
  const body = Body.parse(await readBody(event));

  const workspace = await import('@raci/db').then((db) =>
    db.getWorkspace(useDb(), session.organizationId, body.workspaceId),
  );
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'No such workspace' });

  return syncDirectoryIntoWorkspace({
    organizationId: session.organizationId,
    workspaceId: body.workspaceId,
    startedBy: session.userId,
    dryRun: body.dryRun,
  });
});
