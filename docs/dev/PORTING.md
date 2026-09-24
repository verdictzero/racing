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

### 1 · ~~The chart cascade~~ — `renderChart` (index.html:10574)

**Done.** `apps/web/app/pages/w/[id]/index.vue` and `components/chart/`, on
`packages/core/src/cascade.ts`.

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

Zoom, pane dragging, the resize grip, Auto Arrange, the popovers (cell, column, row, org, flow),
the drill from a Task row into its anchored flow, copy/paste, the right-click menus and the Final
lock came across with the parity work (§10). **One layout quirk is kept on purpose:** index.html
re-renders the cascade for an edit or a drill but only re-lays it out for a zoom, a drag, a snap
back or a window resize, and those passes measure against the width the last one wrote — so each
widens the focused pane by one cascade indent until it reaches its natural width. The chart runs
the two kinds of pass where the source does (`layoutCascade(fresh)`), because that is what the
source looks like after you zoom.

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

### 3 · The flow canvas — `renderBizcase` (index.html:11948)

**Part (a) and (b) done.** `apps/web/app/pages/w/[id]/flow.vue`, on
`packages/core/src/flow-geometry.ts` (29 tests).

The arithmetic is all in core: `socketPoint`, `edgePath`, `edgePathVia`, `viaInsertIndex`,
`endpointBox`, `edgeGeometry`, `flowBounds`. In `index.html` every one of those answers comes out of
the DOM — `getBoundingClientRect`, CSS selectors, live measurement — so none of it could be tested
without a browser, which is how a real bug in the curve arithmetic survived (see below).

**One measurement is injected and only one:** a card's height, which is content-driven and genuinely
only the renderer knows. Width is fixed at `STEP_WIDTH`. The component measures, core computes.

- **Step positions ARE document data** — where a box sits is something a person decided and
  everyone should see. The camera (pan, zoom) is per-person and stays in the component. That split
  is the exact opposite of the chart screen's, and it is deliberate in both directions.
- `moveStep` writes `x` and `y` as separate fields on purpose, so two people dragging different
  steps never fight over a coordinate pair. Keep it that way.

**Still to do — part (c) and the rest:** dragging a socket to draw a new handoff, creating
redirector waypoints (the geometry renders and inserts them; no gesture makes one yet), group
frames and collapsing (`endpointBox` already handles a collapsed frame's mating points), nested
subflow per-port sockets, the minimap, and marquee selection.

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
- `viewViolations(ws, { view, chartId, flowId })` is how a screen lints. It is index.html's
  `recomputeViolations` + `lintFlow`, run over what the legacy app runs them over (the chart in
  front; in the flow view the open flow, elsewhere every flow anchored to that chart) and returned
  as its RECORDS — one per row or step, as severe as the worst issue on it. The pill counts those:
  `violationPillText(records)` words it exactly as index.html does ("410 warnings",
  "2 errors · 3 warnings"). `chartViolations(chart)` on its own silently skips the supply check.

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

`collectWork` is a line-for-line port of index.html's `collectWorkItems`, Chart-Linked flows
included: a linked step reads its letters through `createLintContext(ws).stepRaci(flow, step)` —
index.html's `bizStepRaci`, `bindOverrides` and all. Use that resolution rather than writing a
second one; the flow rules, the exports and the lens all go through it.

### 6 · ~~Exports~~

**Done, and byte for byte.** Every download the rail and the Export menu offer is what index.html
writes for the same workspace:

| Export | Where | Parity |
|---|---|---|
| Save (`.json`) | `legacy.ts` `exportLegacy`, the view written in by the page | byte-identical |
| XML | `export/xml.ts` | byte-identical |
| Mermaid, chart and flow | `export/mermaid.ts` | byte-identical |
| Excel, and the blank template | `export/xlsx.ts` + `zip.ts` | every part identical |
| PowerPoint | `export/pptx.ts` + `document-text.ts` | every part identical |
| Ingest Kit (`.md`) | `ingest-kit.ts` | byte-identical |
| Print / PDF | index.html's print CSS, `#print-head` filled on `beforeprint` | pixel-identical |

"Every part" because the one byte that differs in a ZIP is each entry's date field: the legacy
writes 0, `zip.ts` writes 1980-01-01. `scripts/capture-legacy-parity.mjs` runs index.html headless
and records what it wrote; the tests hold the ports to it, so a change on either side fails with the
name of the part that moved. Rerun the capture when index.html changes an export.

All of these are pure functions of the workspace in `packages/core`, and **nothing may read the
clock on its own**: a Final chart's signed date is printed in the locale and zone the page passes
(`locale`, `tz` on the export route), and the Ingest Kit takes `now`.

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

### ~~8 · Themes — five palettes (index.html:141–500)~~

**Done**, and now simply part of §10: the palettes arrive with the rest of index.html's stylesheet
in `legacy.css`. Same storage key as the legacy app, so a browser that has used `index.html` keeps
the theme it was already set to; same `contrast` → `hc-dark` migration; applied by a script in the
document head before first paint. It stays a device preference and is never written to the shared
document.

### ~~9 · Field guides~~

**Done.** The Help view shows the three guides in iframes, as index.html does. They are served from
the copies embedded in index.html (`help-doc-src*`, extracted verbatim into
`apps/web/server/assets/guides/`), not from `docs/*.html`, which have drifted from what the
product actually shows.

### 10 · The interface itself

Every slice above tracked a FEATURE, and the port reached five working screens that still read as a
different product. The fix was a change of method, not more styling:

1. **The stylesheet is the source's, whole and untouched.** `apps/web/app/assets/css/legacy.css`
   is index.html lines 7–4543, verbatim. Nothing in it is edited, and no component restyles a class
   the source styles. If something looks wrong, the DOM is wrong.
2. **Each screen emits the source's DOM.** A Vue page reproduces its `render*` function's markup —
   the same elements, ids, classes, nesting and `data-*` attributes — so the source's selectors
   match. Each page's root is `<div class="ws-page">`, which is `display: contents`, so the screen's
   markup behaves as `#ws-main`'s own children, as it is in the source.
3. **Behaviour is delegated on the same attributes, in the source's order.** Click, double-click,
   mousedown, context-menu and keyboard handlers key on the `data-*` attributes the source's
   handlers key on, and are checked in the order the source checks them.
4. **What the rebuild needs and the source has no equivalent for** goes in `ours.css`, commented,
   and is kept to a minimum: the sign-in line and Sign out under the rail, the brand as a link back
   to the workspace list.

**How it is checked.** Both apps are driven through the same script in headless Chromium — the
source over `file://` with the demo in its localStorage, the rebuild against a copy of the demo —
and screenshotted after every step; a pixel diff flags any region that differs. Every screen, the
panels, the overlays, the menus, the Final lock, zoom and pane dragging, print layout, and the five
themes at 1600 and 1000 px wide were compared this way. Where the output is a file rather than a
screen, the file is compared: Save, the Ingest Kit, PowerPoint, Mermaid and the Excel template are
byte-identical to index.html's, and `scripts/capture-legacy-parity.mjs` pins them in the tests.

**Where the rebuild differs on purpose.**

| What | Why |
|---|---|
| No startup splash, no "save your work" nag | Both say work lives only in this browser and is lost without Save. Here every edit is already on the server. |
| Sign-in line and Sign out under the rail; the brand links to the workspace list | The single file had no accounts and no list. |
| Drill path, pane positions, zoom, pane size, Legend, the Tasks unit are per person, in localStorage | In a shared document they would move everyone's screen. Save writes them into the file and Load reads them back, as the source's state does. |
| Load, Demo and Clear replace the document for everyone in the workspace | The source replaced one browser's state. They keep its prompts word for word (Demo and Clear ask, Load does not) and are one undoable step for the person who did it. |
| Clear keeps the workspace's own flows and deliverables | The source's comment says Clear keeps the flows; its code rebuilds from `defaultState()`, which swaps them for the demo's. |
| The Details panel's storage note | The source's says documents live in this browser's IndexedDB. |
| Attachments are stored on the server | See `packages/db/src/documents.ts`. Save embeds their bytes, as the source's does. |

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
                                 isOwnerOverride, the violation record types
packages/core/src/violations.ts  viewViolations, violationRecords, flowsToLint, violationPillText,
                                 violationIndex, workspaceViolations — the rules, run as index.html
                                 runs them. Start here.
packages/core/src/chart-rules.ts chartRecords, chartViolations — recomputeViolations' chart walk
packages/core/src/flow-rules.ts  flowRecords, flowViolations, flowHealth, embedWouldCycle — lintFlow
packages/core/src/lint-context.ts
                                 createLintContext (stepRaci, anchor, bind), legacyTree,
                                 legacyChartShape — the document as the legacy rules read it
packages/core/src/registry.ts    objectRegistry, computeArtifactUses, computeEntityUses,
                                 artifactRefCount, filterObjects, orphanArtifacts,
                                 terminalArtifacts, walkChartRows
packages/core/src/cascade.ts     resolveCascade, cascadeCrumbs, pathToOpen — the drill stack
packages/core/src/flow-geometry.ts
                                 socketPoint, edgePath, edgePathVia, edgeGeometry, flowBounds
packages/core/src/org.ts         orgLabel, scopeRelation, inheritedOrg, orgScopes, orgRefPath
packages/core/src/work.ts        collectWork, summarizeWork — "what does my unit own"
packages/core/src/legacy.ts      importLegacy (+ the file's attachment bytes), exportLegacy, tierLabel
packages/core/src/documents.ts   MAX_DOC_BYTES, formatBytes, encodeDataUrl, decodeDataUrl,
                                 prepareEmbeddedDocument, workspaceDocumentIds — attachment bytes
packages/core/src/export/       exportXml, exportChartMermaid, exportFlowMermaid, exportXlsx,
                                 exportTemplate, writeWorkbook, zipBytes, chartToPptx, and in
                                 document-text.ts the legacy's printed vocabulary they share
packages/core/src/import/       importXlsx, readWorkbook, importWorkbook, findHeaderRow, unzip
packages/crdt/src/roster.ts      flattenRoster, nestRoster — the roster's flat storage
packages/crdt/src/mutations.ts   every write that currently exists
packages/db/src/repositories.ts  every query that currently exists
packages/db/src/documents.ts     the attachment blob store, keyed (workspace, doc id); served by
                                 /api/workspaces/:id/documents/:docId (PUT, GET, DELETE) and
                                 /api/workspaces/:id/documents/import
```

**`effectiveRaci` vs `displayRaci`** — they answer different questions and the difference matters.
`effectiveRaci` is what is actually assigned, and a blank cell is blank. `displayRaci` adds the
convention that a blank cell means Informed, which is what the chart prints and what **both document
exports write** (index.html does the same, so the two apps only agree if you use it). Do not reach
for `displayRaci` in a lens that asks who owns what: a unit does not own work because a blank cell
defaulted to Informed, and `collectWork` would report every unit as Informed on everything.

The rule engine is a PORT, not a design: every rule id, severity and message is index.html's, and
so is which rows and flows get linted. Rules the legacy app does not raise are not raised here —
"this deliverable is never consumed" (a terminal report is what a process is usually for; it
surfaces as `terminalArtifacts`), "this flow input has no producer" (unfalsifiable in a flow; the
real rule is `inputNoProducer`, on a chart row), an unreachable step, an owner overriding the chart
cascade (a marker — `isOwnerOverride` — never a chart rule). To change a rule, change it in
index.html first; the parity test below will then say exactly what to port.

`pnpm test` runs in about fifteen seconds. Run it often.

There are three fixtures, and all are real files rather than hand-written ones:

- `demo-workspace.json` — the 810-row demo, dumped out of `index.html` v0.39.
- `foreign-workbook.xlsx` — written by **openpyxl**, not by this repo. Our writer emits inline
  strings in a store-only ZIP; Excel emits shared strings in deflated parts, so a reader tested only
  against our own output would pass everything and still open nothing a user has. Regenerate with
  `scripts/make-foreign-workbook.py`.
- `legacy-violations.json` — index.html's own `_violations` and warnings pill, read out of the real
  file in headless Chromium, for the demo and for a workspace built to make every rule fire.
  `violations.test.ts` checks the port against it, and fails with the function's name if a rule
  function in index.html changes after the capture. Regenerate with
  `scripts/capture-legacy-violations.mjs` (it needs a Playwright install; see its header).

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
