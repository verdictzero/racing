/**
 * Replace the whole document — what Load, Demo and Clear do.
 *
 * index.html does all three by assigning a new state object. Here the workspace is a document other
 * people have open, so a replacement has to be a change every peer can apply and agree on: ONE
 * transaction that empties every top-level map and loads the new workspace into them.
 *
 *   - One transaction, so a peer receives one update and never renders the state in between — an
 *     empty workspace, or the old flows beside the new charts — and an undo manager tracking the
 *     origin sees one step.
 *   - Every map, including the pre-flattening `roster` map that nothing writes any more but
 *     `readWorkspace` still falls back to when `rosterUnits` is empty. Leaving it would let a Clear
 *     bring an old document's roster back from the dead.
 *   - Cleared, then loaded, rather than diffed: a record that exists on both sides is still
 *     rewritten. A diff would be smaller on the wire, but it would also let fields of the old record
 *     that the new one does not set survive the replacement, and a replace that is not a replace is
 *     worse than a slightly larger update.
 *
 * What no replace can do is reach a peer that has not seen it yet. A record another person ADDS at
 * the same moment survives the merge, because the clear only deleted what it could see; an edit
 * they make to a record the replace removed is lost with that record. Both converge — every peer
 * ends up with the same document — which is the guarantee a CRDT gives and all this relies on.
 *
 * `origin` defaults to 'load', like `loadWorkspace`, which the undo manager does not track. Passing
 * `LOCAL_ORIGIN` makes the replacement one undoable step, as it is in index.html — but check the
 * undo manager's scope first: `createUndoManager` does not track `rosterUnits` today, so undoing a
 * Clear made that way would bring back everything except the roster.
 */

import type * as Y from 'yjs';
import type { Workspace } from '@raci/core';
import { loadWorkspace, maps } from './doc.js';

export function replaceWorkspace(doc: Y.Doc, ws: Workspace, origin: unknown = 'load'): void {
  const m = maps(doc);
  doc.transact(() => {
    for (const map of Object.values(m)) map.clear();
    // `loadWorkspace` opens a transaction of its own. Inside this one it simply joins it — Yjs runs a
    // nested `transact` as part of the outer transaction and ignores the inner origin — so the clear
    // and the load commit together, once, under `origin`.
    loadWorkspace(doc, ws);
  }, origin);
}
