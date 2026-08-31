# ADR-0004 — A workspace is stored as its update log, not as relational rows

**Status:** accepted · **Date:** 2026-08-31

## Context

Given ADR-0003, the CRDT document is the thing clients edit. It has to be persisted. There are two
ways to do that, and they are not equivalent.

## Decision

**Store the Yjs update log. Derive everything else from it.**

```
doc_update        append-only Yjs updates — the source of truth
doc_snapshot      periodic compaction, so loading is O(recent) not O(all history)
workspace_index   a derived projection for listing, searching and permission checks
```

Charts and rows have **no tables of their own**.

### Why not shred into rows

It is tempting: you would get SQL over the domain for free. It is the wrong trade here, because the
CRDT is the document of record — it is what merges, what carries causality, and what every client
already agrees on. Shredding it on write means reconstructing intent from a diff, and **any mismatch
between the shredder and the CRDT is a silent divergence** between what a user sees and what the
database believes. That class of bug is very hard to notice and very hard to recover from.

### Why the log is not simply "one row per workspace, overwritten"

Appending is what makes concurrent writes trivial. Two clients saving in the same instant produce
two `INSERT`s, which cannot conflict — no row to lock, no version to compare. A single overwritten
row would make the database the bottleneck the CRDT was chosen to avoid.

### The projection

`workspace_index` carries what SQL is genuinely better at: listing charts and flows, searching them,
and answering "may this user see this" without loading a CRDT into memory. It is **derived, never
authoritative**, and is rebuilt wholesale rather than patched — a diff-based update would be a
second implementation of the same truth and a second thing to get subtly wrong.

**If the projection and the log disagree, the log wins.** Because it can always be rebuilt, its
shape can change with no data migration at all.

## Consequences

**Good**

- Writes never conflict.
- Full history for free: `doc_update` is an audit trail of every change, with the user and origin
  attached.
- The projection can be reshaped freely, which matters a lot while the UI is still being built.
- Compaction is additive: the snapshot is durable *before* what it covers is pruned, so a compaction
  that dies halfway leaves redundant history — costing space and losing nothing.

**Bad**

- **No ad-hoc SQL over chart contents.** "Every row where Cyber is Accountable" cannot be a query
  against the log; it needs either the projection extended or the document loaded. This is the real
  cost and it will be felt when reporting requirements arrive.
- Loading a workspace means replaying updates. Bounded by snapshot frequency
  (`COLLAB_SNAPSHOT_EVERY`, default 200).
- Bytes, not rows, in the main table — so no meaningful inspection with `psql`. `pnpm db:studio`
  shows the projection; the document needs the app.
- Storage grows with edit history between compactions.

## Alternatives rejected

**Relational rows as the source of truth, CRDT as a cache.** Inverts the trust relationship and puts
the shredder on the critical path for correctness rather than for convenience.

**A document store (JSONB blob per workspace).** Loses append-only concurrency — every save is a
read-modify-write of the whole document, which is the conflict this design removes.

**An off-the-shelf Yjs persistence provider (y-leveldb, y-redis).** Would work, and would put the
workspace outside Postgres, away from the users, memberships and audit trail it has to be consistent
with. One database is worth more here than a slightly better fit.

## See also

`packages/db/src/schema.ts` · `packages/db/src/doc-store.ts`
