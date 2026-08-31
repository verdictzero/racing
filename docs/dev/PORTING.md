# Porting plan

What is left to bring across from `index.html`, sliced so several people can work at once.

`index.html` is ~17,000 lines and 473 top-level functions. It stays the product until this is done —
so nothing here is urgent in the sense that users are blocked, and everything here is urgent in the
sense that two implementations is a tax paid every week.

---

## How to port a slice

The same five steps every time.

1. **Find the logic in `index.html`.** It will be tangled with the DOM; that is the thing you are
   undoing.
2. **Move the *rules* into `packages/core`, with tests.** Anything a reviewer would call "a rule
   about RACI" — a cascade, a validation, an export's column order. It must not import a framework,
   the DOM, or any I/O.
3. **Move the *writes* into `packages/crdt/src/mutations.ts`.** One transaction each, one origin
   tag each.
4. **Build the Vue component** against those two seams. The component reads through core's selectors
   and writes through crdt's mutations, and never touches a `Y.Map`.
5. **Check the round trip still holds.** `pnpm test` — if `legacy.test.ts` fails, the two apps have
   forked. Fix the converter, do not update the expectation.

**Do not delete anything from `index.html`** until the Nuxt screen has shipped and been used. The
old screen is the fallback, and it costs nothing to keep.

---

## Slices

Ordered by dependency, not by importance. Anything marked **parallel** can be picked up at once by
different people.

### 1 · The chart cascade — `renderChart` (index.html:10574)

**Mostly done.** `apps/web/app/pages/w/[id]/index.vue`, on `packages/core/src/cascade.ts`.

`resolveCascade(chart, drillPath)` turns a drill path into the pane stack, and it is pure: it takes
a path and returns the panes plus **the path it could actually honour**, so a caller decides what to
do about a stale one. In `index.html` the same logic is tangled with the renderer and mutates the
chart's `drillPath` as a side effect of drawing.

- **The drill path is not document data.** Which row *you* have open is a fact about your screen.
  In the shared document it would mean one person drilling yanks everyone else's view. It lives in
  component state, and the `trimmed` flag is how a row deleted by someone else while you had it open
  collapses the stack instead of leaving an empty pane under a live breadcrumb.
- **Two things cascade, separately**: the owner column (each drilled row's primary doer; a row that
  designates none passes the ancestor's through rather than breaking the chain) and the org ref (a
  Program contributes its division, a Project its branch).
- **Cells go through `displayRaci`, never recomputed in the component.** It resolves the three cases
  the chart must tell apart — stated here, cascaded from above, and the Informed a blank cell means
  by convention — and each gets its own class so the difference is visible rather than implied.

**Still to do here:** zoom, dragging a pane to reposition it, auto-arrange, the chart-tab strip, and
the drill from a Task row into its anchored flow — that last one waits on slice 3. All chrome and
camera; the cascade itself is done.

**Note for whoever tests this:** all 810 rows of the demo state an owner of their own, so **nothing
in the demo ever exercises the inherited-owner path.** It has to be constructed; `cascade.test.ts`
does, under "the pane and the cells agree".

### 2 · ~~The roster~~ — `renderRoster` (index.html:11127)

**Done (Explore mode).** `apps/web/app/pages/w/[id]/roster.vue`.

The legacy app also has a **Full hierarchy** mode that prints all six directorates expanded at
once. That is a printing affordance more than a browsing one and has not come across; it is a small
piece of work on top of what is here.

**The roster is now flattened inside the CRDT** — `packages/crdt/src/roster.ts`. It used to be one
plain JSON value per directorate, on the reasoning that only the sync wrote it. This screen made
that false, and the old shape was the worst available: any two edits anywhere under one directorate
clobbered each other. It is now one record per unit with a parent pointer and an order key, the same
model as `nodes`. `flattenRoster` / `nestRoster` convert at the boundary, so `Workspace`,
`legacy.ts`, the exporters and every selector still see the nested tree — none of them changed.

- Mutations: `addRosterUnit`, `setRosterUnitField`, `setRosterLead`, `moveRosterUnit`,
  `deleteRosterUnit`, `rosterChildren`; `setDirectorate` / `setRoster` for the sync.
- Selectors: `unitCounts`, `unitStat` in `org.ts`.
- `readWorkspace` still reads the old shape when a document has only that, so a workspace persisted
  by an earlier build opens with its roster intact. The first write migrates it.
- Watch for: a hand-created unit has `externalId: null`, and the sync deliberately preserves it. Do
  not "fix" that by assigning one — it is how "ours, not the directory's" is recorded, and minting
  one would make the next sync delete the unit.

**Still open:** `users.rosterPersonId`. Matching an account to a roster person — the thing that lets
the Tasks screen default to *your* unit — needs a person's `externalId` compared against the OIDC
subject at sign-in. Everything it needs now exists; nothing does it yet.

### 3 · The flow canvas — `renderBizcase` (index.html:11948) — **parallel**

The largest single UI surface: draggable steps, socket-to-socket handoffs, redirector waypoints,
nested subflow boxes with per-entry/exit ports, group frames, the minimap, marquee selection.

- Already in core: `Flow`, `FlowStep`, `FlowEdge`, `FlowGroup` schemas.
- Already in crdt: `addStep`, `moveStep`, `addEdge`, `addGroup`, `deleteStep`, `deleteGroup`.
- To write: essentially all of it. Suggest splitting again — (a) canvas, steps, drag; (b) edges,
  routing, redirectors; (c) groups and nested flows.
- Watch for: `moveStep` writes `x` and `y` as separate fields on purpose, so two people dragging
  different steps never fight over a coordinate pair. Keep it that way.
- Watch for: step positions **are** document data (unlike chart camera state) — where a box sits is
  something a person decided.

### 4 · ~~Object Gallery~~ — `renderObjects` (index.html:10427)

**Done.** `apps/web/app/pages/w/[id]/objects.vue`, on `packages/core/src/registry.ts`.

Worth reading before you start a slice of your own — it is the smallest complete example of the
shape every other screen should take. The component holds no rules at all: `objectRegistry` returns
the cards, `filterObjects` the filter, `artifactRefCount` the delete guard, and the file is layout
and event handlers. The two registries deliberately delete differently (a referenced deliverable
cannot be, a referenced entity can) — that asymmetry is the legacy behaviour and is explained in
the component header.

It also brought across the structure the remaining screens hang off:

- `apps/web/app/pages/w/[id].vue` is now the **workspace shell** — the live indicator, peer count,
  undo, and the route tabs. Each screen is a child route under `w/[id]/`.
- `useWorkspaceSession()` gives a screen the shared `Y.Doc` and a plain `Workspace` ref. **Use it.**
  Calling `useCollab` from a screen opens a second socket and a second undo manager for the same
  workspace, which is the bug it exists to prevent.
- `workspaceViolations(ws)` is how you lint. `chartViolations(chart)` on its own silently skips the
  supply check, and `flowViolations` without an anchor owner column invents a warning on every step
  of every anchored flow.

### 5 · ~~Tasks / work lens~~ — `renderWork` (index.html:10185)

**Done.** `apps/web/app/pages/w/[id]/tasks.vue`, on `packages/core/src/work.ts` and `org.ts`.

Two things it brought into core that other slices need:

- **`org.ts`** — `orgLabel`, `orgRefPath`, `scopeRelation`, `inheritedOrg`, `orgScopes`. Everything
  about resolving an OrgRef. The roster (slice 2) and the chart's org badges (slice 1) both want
  these; do not write them again.
- **`work.ts`** — `collectWork(ws, scope)`, the combined chart + flow walker.

**Still open in this slice:** `users.rosterPersonId` exists so the screen can default to *your* unit
instead of making you pick. Nothing sets it — matching an account to a roster person needs the
directory sync to write a person's `externalId` against the user's OIDC subject, and belongs with
slice 2. Until then the picker starts empty, which is correct but one click worse.

**Also not ported, stated rather than silently wrong:** a Chart-Linked flow (`mode: 'linked'`) binds
each step to a chart row and cascades that row's letters onto it, subject to `bindOverrides` and a
letter translation between frameworks. That subsystem belongs with slice 3. Until it lands,
`collectWork` treats a linked step exactly like a free one — it under-reports for a linked flow, and
never mis-reports.

### 6 · Exports — **parallel, one person each**

| Export | Where | Notes |
|---|---|---|
| ~~XML~~ | — | **Done.** `packages/core/src/export/xml.ts`, 25 tests. |
| ~~Mermaid~~ | — | **Done.** `packages/core/src/export/mermaid.ts`, chart and flow. |
| ~~Excel~~ | — | **Done.** `packages/core/src/export/xlsx.ts` + `zip.ts`, 34 tests. |
| ~~Excel template~~ | — | **Done.** Same file — `exportTemplate`, shares the writer. |
| PowerPoint | `exportPPTX` :16297 | Largest. |
| Print / PDF | `beforeprint` handler | CSS-only in the legacy app; may stay client-side. |

All of these are pure functions of the workspace, so **they belong in `packages/core`**, not in the
app. That also means they can be tested without a browser — which the legacy ones cannot.

The ones that are done set the pattern: take a `Workspace`, return a string or bytes, inject
anything non-deterministic (`now`). **Nothing may read the clock on its own** — the XLSX writer
stamps every ZIP entry 1980-01-01 for exactly this reason, so two exports of an unchanged workspace
are byte-identical and can be asserted on.

`export/zip.ts` is a store-only ZIP writer with no dependency, shared by any format that is a ZIP of
XML parts — which is both remaining Office formats. **PowerPoint should use it**; it does not need a
library either. `packages/core/src/export/order.ts` already gives you flow steps in
dependency order, and `stepIo()` derives a step's inputs and outputs from its handoffs. Reuse both
rather than writing them again. The download route (`apps/web/server/api/workspaces/[id]/export.get.ts`)
is where a new format gets hooked up — one case in a switch.

### 7 · ~~Excel import~~ — `importXlsx` (index.html, v0.37 section)

**Done.** `packages/core/src/import/` — `xlsx.ts`, `unzip.ts`, `xml.ts`. 42 tests.

Split in two, and the split is the point:

- `readWorkbook(bytes)` is I/O — unzip, inflate, parse XML — and is async.
- `importWorkbook(sheets)` is the rules, and is a **pure function of a grid of strings**.

Every question this importer has to answer well — where is the header row, which columns are the
hierarchy, which are parties, what does a row that skips a level mean — is a question about a grid,
so all of it is testable without a file.

**No dependency.** The inflater is `DecompressionStream('deflate-raw')`, a platform API in Node 18+
and every current browser. `import/xml.ts` is a purpose-built scanner rather than a parser, which is
only safe because the input is machine-generated SpreadsheetML.

**It runs in the browser.** The chart screen parses the chosen file client-side, shows a preview,
and writes through the CRDT on confirm — so there is no upload endpoint, and an import arrives as a
normal collaborative edit that peers see and undo can reach (`insertChart` is one transaction, so
one Ctrl+Z takes it back).

**`CONTEXT_HEADERS` is part of the file format, not a convenience.** Columns like `Org unit` and
`Division (inherited)` sit between the hierarchy and the parties and carry org names. Read as role
letters they would mine a `C` out of "DIRECTORATE C" and shift every real party column along by one
— silently, on every row. **Adding a context column to the exporter without adding its header to
that list corrupts every re-import**, in both apps.

### 8 · Themes — five palettes (index.html:141–500)

Structural CSS plus five palettes, already cleanly separated in the legacy stylesheet. Mostly a
copy-across into CSS custom properties. Keep the theme a device preference, out of the document.

### 9 · Field guides — `docs/*.html`

Three guides, currently inlined into `index.html` and rendered in iframes. In Nuxt they can be real
routes. Low priority, easy, and a good way to learn the codebase.

---

## Not a slice: things that should NOT come across

- **Whole-state snapshot undo.** Replaced by Yjs's `UndoManager`. The legacy approach cannot survive
  collaboration — restoring a snapshot would roll everyone back to when you started.
- **`localStorage` persistence.** Replaced by Postgres. Keep a local cache for offline editing if you
  like, but it is not the store.
- **The IndexedDB blob store.** Replaced by `document_blob`.
- **Camera state in the document** (`drillPath`, `chartZoom`, `chartPos`, flow `view`). Per-person.
  The legacy app already excludes it from its undo signature for the same reason; in a shared
  document it would mean one person's scroll position yanking everyone else's.
- **The `columnActor` global**, if a better model emerges. It is carried across as-is for now.

---

## Reference: what already exists

Before writing anything, check whether it is already done:

```
packages/core/src/tree.ts        childrenOf, pathTo, subtreeOf, planMove, depthOf, findCycles…
packages/core/src/raci.ts        effectiveRaci, inheritedOwnerColumn, primaryDoerColumn,
                                 isOwnerOverride, chartViolations
packages/core/src/flow-rules.ts  flowViolations, flowHealth, reachableSteps, embedWouldCycle
packages/core/src/violations.ts  workspaceViolations — lint everything, correctly. Start here.
packages/core/src/registry.ts    objectRegistry, computeArtifactUses, computeEntityUses,
                                 artifactRefCount, filterObjects, orphanArtifacts,
                                 terminalArtifacts, walkChartRows
packages/core/src/cascade.ts     resolveCascade, cascadeCrumbs, pathToOpen — the drill stack
packages/core/src/org.ts         orgLabel, scopeRelation, inheritedOrg, orgScopes, orgRefPath
packages/core/src/work.ts        collectWork, summarizeWork — "what does my unit own"
packages/core/src/legacy.ts      importLegacy, exportLegacy, tierLabel
packages/core/src/export/       exportXml, exportChartMermaid, exportFlowMermaid, exportXlsx,
                                 exportTemplate, writeWorkbook, zipBytes, topologicalOrder, stepIo
packages/core/src/import/       importXlsx, readWorkbook, importWorkbook, findHeaderRow, unzip
packages/crdt/src/roster.ts      flattenRoster, nestRoster — the roster's flat storage
packages/crdt/src/mutations.ts   every write that currently exists
packages/db/src/repositories.ts  every query that currently exists
```

**`effectiveRaci` vs `displayRaci`** — they answer different questions and the difference matters.
`effectiveRaci` is what is actually assigned, and a blank cell is blank. `displayRaci` adds the
convention that a blank cell means Informed, which is what the chart prints and what **both document
exports write** (index.html does the same, so the two apps only agree if you use it). Do not reach
for `displayRaci` in a lens that asks who owns what: a unit does not own work because a blank cell
defaulted to Informed, and `collectWork` would report every unit as Informed on everything.

Two rules the engine deliberately does NOT raise, so do not "fix" them:

- **"this deliverable is never consumed"** — a terminal report is what a process is usually for.
  It surfaces as `terminalArtifacts`, an annotation on the gallery card.
- **"this flow input has no producer"** — unfalsifiable in a flow, because a handoff registers its
  source step as the producer. It is a real rule about a chart row, and lives in `chartViolations`.

`pnpm test` runs in about fifteen seconds. Run it often.

There are two fixtures, and both are real files rather than hand-written ones:

- `demo-workspace.json` — the 810-row demo, dumped out of `index.html` v0.39.
- `foreign-workbook.xlsx` — written by **openpyxl**, not by this repo. Our writer emits inline
  strings in a store-only ZIP; Excel emits shared strings in deflated parts, so a reader tested only
  against our own output would pass everything and still open nothing a user has. Regenerate with
  `scripts/make-foreign-workbook.py`.

---

## One performance rule

**The flat tree has no child pointers.** `childrenOf(nodes, parentId)` scans the whole node map, so
calling it inside a traversal is quadratic — on the 810-row demo that cost 84ms for a single walk,
which is a visible stall on a screen that re-renders on every keystroke of a shared document.

Build the index once and pass it down:

```ts
const index = childIndex(chart.nodes);
for (const node of walkInOrder(chart.nodes, index)) { … }
```

`walkInOrder`, `subtreeOf`, `subtreeDepth` and `descendantCount` all take an optional index and
build their own if you omit it — fine for one call, wrong in a loop. `tree.test.ts` has a scaling
test that fails if the quadratic shape comes back. Do not cache an index across edits: the document
changes under you, and a stale index renders rows that no longer exist.
