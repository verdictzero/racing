/**
 * A workspace's contents, read from the SQL projection rather than the CRDT.
 *
 * Listing charts and flows does not need the document loaded, and loading one per page view would
 * make the gallery the most expensive screen in the app.
 */
import { getWorkspace, listWorkspaceContents } from '@raci/db';

export default defineEventHandler(async (event) => {
  const session = await requireSession(event);
  const id = getRouterParam(event, 'id')!;
  const db = useDb();

  const workspace = await getWorkspace(db, session.organizationId, id);
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'No such workspace' });

  const query = getQuery(event);
  const contents = await listWorkspaceContents(db, session.organizationId, id, {
    kind: query.kind === 'chart' || query.kind === 'flow' ? query.kind : undefined,
    query: typeof query.q === 'string' ? query.q : undefined,
  });

  return { workspace: { id: workspace.id, name: workspace.name }, contents };
});
