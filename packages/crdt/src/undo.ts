/**
 * Undo, scoped to one person.
 *
 * The single-file app snapshots the whole state and restores it wholesale. That cannot survive
 * collaboration: restoring a snapshot would roll back everyone's work to the moment YOU started,
 * silently destroying edits made in between by people who never touched what you undid.
 *
 * Yjs solves it properly. A Y.UndoManager tracks only the changes carrying a given origin, so
 * Ctrl+Z walks back this user's own edits and steps over everyone else's — even when they are
 * interleaved in the same rows.
 */

import * as Y from 'yjs';
import { maps } from './doc.js';
import { LOCAL_ORIGIN } from './mutations.js';

export interface UndoOptions {
  /** Edits within this many ms merge into one undo step. Matches the legacy app's feel. */
  readonly captureTimeout?: number;
  /** Extra origins to track — the directory sync passes its own so a sync is undoable as a unit. */
  readonly trackedOrigins?: Set<unknown>;
}

/**
 * An undo manager over every collection a person can edit.
 *
 * `trackedOrigins` is the whole mechanism: mutations tag themselves LOCAL_ORIGIN, remote updates
 * arrive with the provider's origin, and repair writes carry REPAIR_ORIGIN. Only the first is
 * tracked, so undo can never reach a colleague's edit or fight the repair pass.
 */
export function createUndoManager(doc: Y.Doc, opts: UndoOptions = {}): Y.UndoManager {
  const m = maps(doc);
  const scope = [
    m.charts,
    m.chartOrder,
    m.nodes,
    m.flows,
    m.steps,
    m.edges,
    m.groups,
    m.artifacts,
    m.entities,
    m.roster,
    m.meta,
  ];
  return new Y.UndoManager(scope, {
    captureTimeout: opts.captureTimeout ?? 500,
    trackedOrigins: opts.trackedOrigins ?? new Set([LOCAL_ORIGIN]),
  });
}
