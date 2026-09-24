/**
 * The built-in demo workspace — what the Demo button loads.
 *
 * ITS OWN ENTRY POINT, `@raci/core/demo`, and deliberately never re-exported from the package
 * index. It is 722 KB of JSON: reachable from the index, it would ride along in every client bundle
 * that imports anything at all from @raci/core, for every visitor, whether or not anyone ever
 * presses Demo. Behind its own entry only code that names it gets it — in practice the server's
 * `/api/demo` route, whose bundle it lands in as an ordinary JSON module.
 *
 * It is the legacy v0.39 file rather than a `Workspace`, for two reasons. It is the same file
 * index.html's Demo button builds, and the one every parity test runs against, so there is one
 * demo and not two that can drift. And the caller turns it into the flat model with `importLegacy`
 * exactly as it would any file a person loads, so Demo is Load with a file nobody had to pick.
 */

import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };

export const DEMO_WORKSPACE_JSON: Readonly<Record<string, unknown>> = demo;
