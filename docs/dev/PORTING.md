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

**The biggest slice, and the one everything else waits on.** The nested drill-down cascade: panes
per tier, drill path, auto-arrange, zoom, per-pane positioning.

- Already in core: `tree.ts` (navigation, moves), `raci.ts` (cascade, rules), `fractional.ts`.
- Already in crdt: `addNode`, `moveNode`, `deleteNode`, `duplicateNode`, `renameNode`, `setNodeRaci`.
- To write: the cascade layout, drill state (**client-side only** — camera is per-person and must
  not be in the shared document), the pane chrome, the RACI popover, the violation pins.
- Watch for: `effectiveRaci` already returns a `source` per cell (`explicit` | `inherited`) —
  render the inherited ones dashed as the legacy app does, do not recompute it in the component.

### 2 · The roster — `renderRoster` (index.html:11127) — **parallel**

Directorate → division → branch → team → people, in both Explore (boxes) and Full modes.

- Already in core: the `Roster` schema.
- Already in directory: the sync that populates it.
- To write: the tree UI, the leadership cards, and the *edit* mutations — the roster is currently
  written only by the sync, so `setDirectorate` is the sole mutation and finer ones are needed.
- Watch for: a hand-created unit has `externalId: null`, and the sync deliberately preserves it. Do
  not "fix" that by assigning one.

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

### 4 · Object Gallery — `renderObjects` (index.html:10427) — **parallel**

The smallest real screen, and a good first slice for someone new.

- Already in core: `Artifact`, `Entity` schemas.
- Already in crdt: `addArtifact`, `deleteArtifact`, `addEntity`, `deleteEntity`.
- To write: cards, facets, filter, and the "where is this used" reverse index — which is
  **not yet in core** and should go there as a selector, since the rules engine needs the same index.

### 5 · Tasks / work lens — `renderWork` (index.html:10185)

"What does my unit own", across charts and flows.

- To write: the org-scope picker and the combined walker, as a core selector.
- Depends on: nothing structural. Can start any time.
- Watch for: `users.rosterPersonId` exists precisely so this can default to *your* unit rather than
  making you pick it every time. Nothing sets it yet — matching an account to a roster person is
  part of this slice.

### 6 · Exports — **parallel, one person each**

| Export | Where | Notes |
|---|---|---|
| ~~XML~~ | — | **Done.** `packages/core/src/export/xml.ts`, 25 tests. |
| ~~Mermaid~~ | — | **Done.** `packages/core/src/export/mermaid.ts`, chart and flow. |
| Excel | `exportXLSX` :15693 | Needs a server-side writer; the legacy one builds the file by hand in the browser. |
| Excel template | `exportTemplate` :15837 | Pairs with the importer. |
| PowerPoint | `exportPPTX` :16297 | Largest. |
| Print / PDF | `beforeprint` handler | CSS-only in the legacy app; may stay client-side. |

All of these are pure functions of the workspace, so **they belong in `packages/core`**, not in the
app. That also means they can be tested without a browser — which the legacy ones cannot.

The two that are done set the pattern: take a `Workspace`, return a string, inject anything
non-deterministic (`now`). `packages/core/src/export/order.ts` already gives you flow steps in
dependency order, and `stepIo()` derives a step's inputs and outputs from its handoffs. Reuse both
rather than writing them again. The download route (`apps/web/server/api/workspaces/[id]/export.get.ts`)
is where a new format gets hooked up — one case in a switch.

### 7 · Excel import — `importXlsx` (index.html, v0.37 section) — **parallel**

Header-row detection, tier inference, party columns, the Entities and Document sheets. Pure logic
over a parsed workbook, so it belongs in core with the parsing injected.

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
packages/core/src/legacy.ts      importLegacy, exportLegacy, tierLabel
packages/crdt/src/mutations.ts   every write that currently exists
packages/db/src/repositories.ts  every query that currently exists
```

`pnpm test` runs in about five seconds. Run it often.
