# ADR-0001 — Chart rows are stored flat, with fractional order keys

**Status:** accepted · **Date:** 2026-08-31 · **Supersedes:** the nested `children[]` array in `index.html`

## Context

A chart is a tree: Portfolio → Program → Project → Task. `index.html` stores it the obvious way —
each node holds a `children[]` array, and sibling order is array position.

That representation is fine for one editor. It breaks under concurrent editing in three ways:

1. **A move is a delete plus an insert.** Two people moving different rows at the same time produce
   two splices against the same array. Merging them duplicates a row or loses one, and nothing in
   the merge can tell which was intended.
2. **A subtree is one value.** Two people editing different rows under one parent are writing to the
   same array, so they conflict for no reason at all.
3. **Array indices are not stable identities.** "Insert at index 2" means different things to two
   clients who have seen different sets of edits.

## Decision

A chart holds a **flat map of nodes**. Each node carries:

- `parentId` — the row above it, or `null` for a root;
- `order` — a **fractional index**: a base-62 string in the open interval (0, 1).

Children of a parent are whatever you get by filtering on `parentId` and sorting on `order`.

Order keys are minted **between two neighbours**, as a pure function of those two values. Two
clients inserting at the same spot therefore produce two keys that both land in the right place,
with no coordination. The interval is open at both ends, so there is always room before the first
row and after the last.

Digits are ASCII-ordered, so lexicographic string comparison *is* numeric comparison — Postgres can
sort on the column with no special handling.

## Consequences

**Good**

- Every edit is small, independent and commutative. A rename touches one field of one node; a
  reparent touches two. Neither can collide with an edit to a sibling.
- Reordering never rewrites siblings. Dragging a row in a 500-row chart writes one string.
- Moving a row between charts is two field writes, not a cross-document splice.
- The shape maps directly onto a database table, which is what makes the SQL projection possible.

**Bad — and this is the real cost**

- **Cycles become representable.** Two people, each moving one of two rows under the other, both
  make a legal single-node edit; the merge is a ring. No CRDT prevents this — it is inherent to
  editing a tree without a lock. It is handled by detection and deterministic repair
  (`packages/crdt/src/repair.ts`), never by prevention.
- **Orphans become representable.** A row added under a parent that someone else deletes at the same
  moment survives with a dangling `parentId`. Same treatment: re-rooted where a person can see it,
  never deleted.
- Reading the tree is a filter-and-sort rather than a pointer walk. Irrelevant at these sizes
  (hundreds of rows), and it is why `packages/core/src/tree.ts` exists.
- Order keys grow slowly under repeated insertion at one spot. Tested to 500 successive bisections;
  keys stay under 10 characters.

## Alternatives rejected

**Keep the nested array and lock the document while editing.** Simplest by far, and it makes
realtime collaboration a lie — which is the requirement.

**Nested arrays with a Y.Array per level.** Yjs's move support is still experimental, and
reparenting across two Y.Arrays is exactly the delete-plus-insert problem in a different costume.

**Integer order with renumbering.** Renumbering is a write to every sibling, which is the conflict
storm this design exists to avoid.

**Server-assigned order.** Requires a round trip before a row can be placed, which defeats offline
editing and makes every drag feel slow.

## See also

`packages/core/src/fractional.ts` · `packages/core/src/tree.ts` · [ADR-0003](0003-realtime-collaboration.md)
