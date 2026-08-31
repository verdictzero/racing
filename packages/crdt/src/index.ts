/**
 * @raci/crdt — the workspace as a collaborative document.
 *
 * Wraps Yjs so the rest of the app never touches a Y.Map directly: the document layout lives in
 * doc.ts, every legal write lives in mutations.ts, and repair.ts restores the tree invariants that
 * a merge can break. The domain rules themselves stay in @raci/core, which knows nothing about
 * any of this.
 */

export * from './doc.js';
export * from './mutations.js';
export * from './repair.js';
export * from './undo.js';
export * from './roster.js';
