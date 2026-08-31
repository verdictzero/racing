# ADR-0002 — The Nuxt app is grown beside `index.html`, not instead of it

**Status:** accepted · **Date:** 2026-08-31

## Context

`index.html` is ~17,000 lines of browser script in one file: five views, a drag-and-drop flow
canvas, an undo system, five themes, six export formats, an Excel importer, and a rules engine. It
has no build step, no tests, and no types.

It is also **in daily use and works**. Its single-file design is a genuine feature on a government
network: no install, no server, no approval to run, and it can be emailed.

Rebuilding it needs a database, an identity provider and a collaboration server — none of which fit
in a file you can email.

## Decision

**Extract the domain first; keep both apps working throughout.**

1. Lift the domain logic out of `index.html` into `packages/core` — typed, tested, no DOM.
2. Build the Nuxt app on top of those packages.
3. Keep `index.html` shipping, unchanged, until the Nuxt app reaches parity.
4. **Both apps read and write the same file format.** `packages/core/src/legacy.ts` converts in both
   directions, and `legacy.test.ts` asserts the round trip against the real demo workspace.

Point 4 is the load-bearing one. While it holds, a user can move between the two apps freely, the
rebuild can ship in slices, and an unfinished screen is not a blocker because the old app still has
it.

## Consequences

**Good**

- No flag day. No period where nothing is shippable.
- The riskiest logic — the cascade, the rules engine, the Excel importer — gets test coverage
  *before* it moves, not after.
- Each screen can be ported independently, so several people can work in parallel. See PORTING.md.
- If the rebuild is paused for a quarter, nothing is lost and the old app still works.

**Bad**

- Two implementations of the same features coexist for a while. A bug fixed in one may need fixing
  in the other; the commit should say so.
- `index.html` is excluded from lint and typecheck (it would produce thousands of findings nobody
  intends to act on). It gets its own CI job that parses it and checks its invariants —
  `scripts/check-legacy-app.mjs`.
- The legacy format constrains the new model. Where the new model wants to differ — flat rows, sparse
  RACI cells — `legacy.ts` absorbs the difference, and it will keep growing until the old app retires.

## The one thing that must not break

If `legacy.test.ts`'s round-trip tests ever fail, the two apps have forked and users can no longer
move between them. That is not a normal test failure; it means the migration strategy has stopped
working. Fix the converter, do not update the expectation.

## See also

`packages/core/src/legacy.ts` · `docs/dev/PORTING.md`
