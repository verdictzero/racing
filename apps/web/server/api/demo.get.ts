/**
 * The built-in demo workspace, for the right rail's Demo button.
 *
 *   GET /api/demo   the legacy v0.39 workspace file index.html's Demo button builds
 *
 * Served on request rather than bundled into the page: it is 722 KB, and every visitor would
 * download it on every visit whether or not they ever press Demo. The page runs the reply through
 * `importLegacy` and hands the result to `replaceWorkspace` — the same path as Load, with a file
 * nobody had to pick.
 *
 * The JSON comes from `@raci/core/demo`, an entry point of its own that the package index never
 * re-exports, so this route's bundle is the only one that carries it.
 */

import { DEMO_WORKSPACE_JSON } from '@raci/core/demo';

export default defineEventHandler(async (event) => {
  await requireSession(event);
  // The same bytes for everyone until the next deploy, so a browser that asked once may keep it.
  setHeader(event, 'cache-control', 'private, max-age=3600');
  return DEMO_WORKSPACE_JSON;
});
