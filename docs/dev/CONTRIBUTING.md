# Contributing

## Before you start

```bash
pnpm install
cp .env.example .env
pnpm stack:up && pnpm db:migrate
pnpm verify          # lint + typecheck + test. Should be green on a fresh clone.
```

If `pnpm verify` is not green before you have changed anything, that is a bug — say so rather than
working around it.

---

## The three rules

Everything else is a preference. These three are what keep the codebase coherent, and a change that
breaks one should be turned down in review.

### 1 · Domain rules live in `packages/core`

If a reviewer would call it "a rule about RACI" — a cascade, a validation, an export's column order,
what counts as a violation — it goes in `core`, with a test, and **nothing else re-implements it**.

`core` may not import a framework, the DOM, a database, or anything that does I/O. That constraint
is the whole value: it is what makes the rules testable in milliseconds and identical between the
app, the exporter and the API.

### 2 · Nothing outside `packages/crdt` touches a `Y.Map`

Every write goes through a function in `mutations.ts`. That buys three things and each of them
matters:

- one transaction per user-visible action, so a peer never sees a half-built row;
- an origin tag, so undo can be scoped to your own edits rather than ripping out a colleague's;
- **one list of everything that can change the document** — which is what a permission check and an
  audit trail can both be written against.

Adding a mutation is normal and expected. Reaching around them is not.

### 3 · Data crossing a boundary is parsed, not cast

A file someone emailed, a row from Postgres, a value another client wrote into the CRDT, a record
from LDAP — all of it goes through a Zod schema. `as SomeType` on external data is a promise;
`Schema.parse` is a check.

`@typescript-eslint/no-explicit-any` is an **error**, not a warning, for this reason.

---

## Conventions

**TypeScript.** Strict, plus `noUncheckedIndexedAccess`. `arr[0]` is `T | undefined` and you have to
say what happens when it is missing. This is deliberate and catches real bugs in tree code.

**Naming.** Say what a thing is, not what it is made of. `effectiveRaci`, not `computeRaciData`.

**Comments explain WHY.** The code already says what it does. A comment earns its place by recording
the reason a decision was made — especially when the obvious alternative is wrong. If a future reader
would reasonably ask "why not just…", answer it where they will ask.

Bad:
```ts
// Loop through the nodes
for (const node of nodes) { … }
```

Good:
```ts
// Collected before deleting, because deleting as we walk would drop children we have not visited.
const doomed = collectSubtree(nodes, id);
```

**Tests assert behaviour, not implementation.** `packages/crdt/src/convergence.test.ts` is the model:
it sets up two clients, partitions them, makes real concurrent edits, and asserts what the user ends
up with. Nothing in it knows how Yjs encodes an update.

**Commits explain the reasoning.** State what changed, and why the obvious alternative was not taken.
`git log` is the only place that survives a team turning over.

---

## Adding things

**A domain rule** → `packages/core`, with a test. Nothing else.

**A write** → `packages/crdt/src/mutations.ts`. One transaction, one origin tag.

**A database column** → edit `packages/db/src/schema.ts`, then `pnpm db:generate`, then read the
generated SQL. Drizzle is configured with `strict: true` and `verbose: true` precisely so a
migration that silently drops a column is something you see in review.

**A directory provider** → implement `DirectorySource` in `packages/directory/src/adapters/`, add a
case to `factory.ts`. Nothing else changes, and that is the test of whether the port is right.

**An API route** → `apps/web/server/api/`. Call `requireSession` or `requireRole` first — an
unauthenticated handler is not an oversight you notice later.

---

## Working on the legacy app

`index.html` is still the product. It has its own conventions and it is **excluded from lint and
typecheck** — linting 17,000 lines of ES5-era browser script would produce thousands of findings
nobody intends to act on.

It has one CI job of its own: `node scripts/check-legacy-app.mjs`. It parses every inline script and
checks two invariants:

- `APP_VERSION` has a matching entry in the version-history comment;
- **the file is still CRLF.** A tool that rewrites it as LF produces a diff touching all 17,000 lines,
  which buries the actual change and makes review impossible. If you edit it with a script, write the
  bytes back as CRLF.

Bump `APP_VERSION` and add a history entry for anything user-visible.

---

## Review checklist

- [ ] Is the domain rule in `core`, and only in `core`?
- [ ] Does every write go through a mutation?
- [ ] Is external data parsed rather than cast?
- [ ] Do the tests assert what a **user** would notice?
- [ ] If the change affects the document shape, does `legacy.test.ts` still pass? *(If not, the two
      apps have forked. That is not a test to update.)*
- [ ] Does the commit message say why, not just what?
- [ ] If it changes an architectural decision, is there an ADR?
