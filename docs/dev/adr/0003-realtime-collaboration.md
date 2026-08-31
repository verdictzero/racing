# ADR-0003 — Realtime collaborative editing, via Yjs

**Status:** accepted · **Date:** 2026-08-31

## Context

`index.html` assumes one editor. State lives in one object, undo is a whole-state snapshot, and
sharing is "export a file and email it". The roadmap's own note says the operating model is *"one
maintainer edits, others receive exports."*

The requirement for the rebuild is several people editing one workspace at once.

## Decision

**Yjs**, with the workspace as one CRDT document per workspace.

### Why one document per workspace, not one per chart

Charts and flows reference each other: a flow anchors to a chart row, a step binds to one, both
point into the shared deliverable registry. Splitting them across documents would put those
references across a consistency boundary — a chart row could be deleted while a flow in another
document still bound to it, with no transaction able to see both.

### Why every record is a `Y.Map`

A plain object stored in a `Y.Map` is one opaque value: last writer wins for the **whole record**.
Two people editing a row's name and one of its RACI cells at the same moment would lose one of the
two edits outright. As a `Y.Map`, each field merges independently.

`raci` and `parties` go one level further and are nested `Y.Map`s, because two people assigning
different columns of one row is the *normal case* in a responsibility matrix, not a conflict.

### Why some fields are deliberately NOT per-field

`documents`, `inputs`, `outputs`, `artifactIds`, `via` and `ports` stay plain arrays. They are
short, they are edited as a unit ("attach this deliverable"), and a `Y.Array` per field on every row
is not worth what it would cost. Last-writer-wins on a five-element list is an accepted trade.

Text fields are plain strings, not `Y.Text`. Character-level merging inside a short label would cost
a `Y.Text` object per field on every record — 810 rows × 2 fields on the demo workspace alone — for
a case that barely arises. Any single field can be promoted to `Y.Text` later without disturbing the
rest.

## Consequences

**Good**

- Offline editing works. A client reconnects, exchanges state vectors, and gets only what it missed.
- Undo becomes correct rather than dangerous. Yjs's `UndoManager` scoped by origin tag walks back
  *your* edits and steps over your colleague's — where the legacy snapshot-restore would roll
  everyone back to the moment you started.
- No operational transform server, no central lock, no write conflicts to resolve in the UI.

**Bad**

- **Convergence is not correctness.** Every replica agrees on the same state; nothing guarantees the
  state is a *tree*. See ADR-0001. Handled by deterministic post-merge repair.
- Document size grows with edit history until compaction runs. See ADR-0004.
- Yjs is now a hard dependency of the domain's storage shape. Replacing it would mean rewriting
  `packages/crdt` — which is exactly why the domain rules live in `packages/core`, which knows
  nothing about it.
- Debugging a merge is harder than debugging a lock. The two-client test harness in
  `packages/crdt/src/convergence.test.ts` exists so those cases are reproducible rather than
  anecdotal.

## Alternatives rejected

**Optimistic locking (a version column, reject stale writes).** Far simpler, and it was the original
recommendation. Rejected because it is not collaborative editing: two people editing one chart means
one of them loses their work and retypes it.

**Operational transform.** Mature (it is what Google Docs uses), but it needs a central authoritative
server to order operations, which rules out offline editing and makes the server a single point of
failure for editing rather than just for persistence.

**Row-level locking in the UI.** Predictable, and it makes the product worse: you cannot edit a row
someone else has open, which on a chart being reviewed in a meeting is most of them.

## See also

`packages/crdt/src/doc.ts` · `packages/crdt/src/repair.ts` · `apps/web/server/routes/api/collab.ts`
