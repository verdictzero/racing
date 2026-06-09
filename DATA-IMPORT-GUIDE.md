# RACI Tool — Data Import Guide (for Claude)

A reference for populating `raci-matrix.html` with **real data**. The app is a single self-contained
HTML file with no build step; all state lives in one JSON object persisted to `localStorage`
(`raci-matrix-v8`) and importable/exportable as JSON.

> **Read the code, not just this guide, before a big import.** Source of truth: the constants and
> `migrateState`/`normalizeNodes` near the top of the `<script>` in `raci-matrix.html`
> (~lines 1818–2128), and `exportJSON`/`importJSON` (~3225, ~3412).

---

## 1. The mental model — two SEPARATE structures

Do not conflate these. They are different axes.

| | **RACI matrix columns** | **Roster / org directory** |
|---|---|---|
| What it is | The 7 parties that receive **R/A/C/I** on each activity | A standalone org chart (directory of who exists) |
| Key/const | `COLS` (7 fixed keys) | `ACTORS` (6 fixed keys) → `state.directorates` |
| Labels | `COL_LABELS` / `COL_SHORT` — **hardcoded in the file** (no runtime rename) | `state.actorLabels` — **editable at runtime / via JSON** |
| Used by | every activity row's `raci` object | the optional `node.org` assignment on Programs/Projects |

- **`COLS`** = `['hq','cos','mission','infra','cyber','sw','contacts']`, displayed as `Unit 1`…`Unit 7`.
  These are the columns of the chart. To rename or change their count you **must edit the file**
  (see §6).
- **`ACTORS`** = `['ocio','mission','infra','cyber','sw','vendor']`, default labels `DIRECTORATE A`…`F`.
  Labels are data (`state.actorLabels`) so they can be set in the import JSON without editing code.
- The roster is **optional**. A pure RACI chart needs only `activities`; the roster only matters if
  you want Programs/Projects tagged with a real Division/Branch (`node.org`).

### Tiers (the activity tree depth)
`TIER_LABELS = ['Portfolio','Program','Project','Task']`, `MAX_TIER = 3`. Depth is **implied by
nesting**, not stored on the node:
- depth 0 = Portfolio, 1 = Program, 2 = Project, 3 = Task. Children below depth 3 are dropped on import.

### The cascade rule (important when generating RACI values)
The **Accountable (A)** of a child activity is *inherited* from the **Responsible (R)** designated on
its parent, flowing down every level until a deeper level designates its own R. Implications for data
you generate:
- **At most one explicit `A` per row** (hard rule in the UI). Generate ≤1 `A` per activity.
- A row may have **multiple `R`s**, but if so set **`node.primaryR`** to the column key of the R that
  should cascade down as the children's A. With exactly one R, `primaryR` is implicit (omit it).
- You usually only need to put an explicit `A` on the **top level** (Portfolio); lower levels inherit
  it automatically from the parent's (primary) R. Putting an explicit A on a child overrides the
  inherited one.

---

## 2. Top-level `state` schema (what import expects)

`importJSON` runs the parsed JSON through `migrateState`, which fills defaults and drops unknown fields.
A **minimal** valid import is just `title` + `activities`; everything else defaults.

```jsonc
{
  "title": "string",                 // doc title (default 'ASIC RACI Tool Demo')
  "activities": [ /* Node[] */ ],    // the Portfolio-tier roots (the tree)
  "drillPath": [],                   // string[] of node ids currently drilled open; [] = top view
  "actorLabels": {                   // rename the 6 directorates (optional)
    "ocio": "…", "mission": "…", "infra": "…",
    "cyber": "…", "sw": "…", "vendor": "…"
  },
  "directorates": { /* see §4 */ },  // the roster; {} is fine if unused
  "collapsedDirectorates": {},
  "viewMode": "chart",               // 'chart' | 'roster'
  "showLegend": false,
  "chartSize": null,                 // or {w,h}
  "chartZoom": 1,                    // clamped 0.4..2.5
  "chartPos": {}                     // {tierIndex: {x,y}} manual pane positions
}
```

`migrateState` also **deletes** legacy keys (`workstreams`, `portfolios`, `nav`, etc.) — don't bother
including them.

---

## 3. Activity Node schema

```jsonc
{
  "id": "abc12xyz",        // optional; auto-generated (uid) if missing. Must be UNIQUE if provided.
  "name": "Activity name",
  "raci": {                // any subset of the 7 COLS keys; missing keys default to ''
    "hq": "AR",            // value = any combination of R/A/C/I; normalized to canonical R-A-C-I order
    "cos": "C",
    "mission": "", "infra": "", "cyber": "R", "sw": "", "contacts": "I"
  },
  "primaryR": "cyber",     // OPTIONAL. Column key of the R that cascades as children's A.
                           //   Only meaningful when this row has 2+ R's. Self-validates
                           //   (ignored if that column isn't an R). Preserved verbatim on import.
  "org": {                 // OPTIONAL roster tag (Programs→Division, Projects→Branch). See §4.
    "actor": "cyber",      // must be one of ACTORS
    "divisionId": "<id of a division in directorates[actor]>",
    "branchId": "<id of a branch in that division>"   // include for Projects; omit for Programs
  },
  "children": [ /* Node[] */ ]   // next tier down; capped at depth 3 (Tasks have no children)
}
```

**`raci` value rules** (enforced by `normalizeRaci` on import):
- Characters outside `R A C I` are stripped; case-insensitive; deduped; reordered to `R,A,C,I`.
  e.g. `"ira"` → `"RAI"` → stored `"RAI"`. Empty/absent → `""`.
- Honor the **one-A-per-row** rule yourself when authoring (import does not reject extra A's, but the
  UI will treat them as pre-existing and block *new* ones).

**`org` rules** (enforced by `normalizeNodes`):
- Kept only if `actor ∈ ACTORS` **and** `divisionId` is a string. `branchId` optional.
- The ids must match **real** ids in `directorates` or the badge silently won't resolve (no error).
- Convention: Programs (depth 1) carry a **Division** (`{actor,divisionId}`); Projects (depth 2) carry
  a **Branch** (`{actor,divisionId,branchId}`). Tasks inherit Division+Branch for display.

---

## 4. Roster (`directorates`) schema

Keyed by the 6 `ACTORS`. Each: `{ lead, divisions[] }`. A `lead`/`chief` is `{id,name}` or `null`.

```jsonc
"directorates": {
  "ocio": {
    "lead": { "id": "l1", "name": "Jane Doe" },
    "divisions": [
      {
        "id": "d1", "name": "Division A1",
        "chief": { "id": "c1", "name": "John Smith" },
        "branches": [
          {
            "id": "b1", "name": "Branch A1.1",
            "chief": null,
            "teams": [
              {
                "id": "t1", "name": "Team A1.1.1", "chief": null,
                "people": [ { "id": "p1", "name": "Alex Lee", "title": "Engineer" } ]
              }
            ]
          }
        ]
      }
    ]
  },
  "mission": { "lead": null, "divisions": [] },
  "infra":   { "lead": null, "divisions": [] },
  "cyber":   { "lead": null, "divisions": [] },
  "sw":      { "lead": null, "divisions": [] },
  "vendor":  { "lead": null, "divisions": [] }
}
```

Hierarchy: **Directorate → Division → Branch → Team → Person**. ids auto-generate if omitted, but to
reference a Division/Branch from a `node.org` you must set explicit ids and reuse them.
(Legacy `branch.people` is auto-migrated into a default team.)

---

## 5. How to actually import

The app reads `state` from `localStorage['raci-matrix-v8']` on load (falling back to seeded demo data).
Three ways to get real data in:

1. **Import JSON button (preferred, no code edit).** Produce a `.json` file matching §2 and have the
   user click **Import JSON** in the header → it runs `migrateState` and replaces state. Round-trips
   with **Export JSON**.
2. **Seed localStorage directly.** Set `localStorage['raci-matrix-v8']` to the JSON string (e.g. via
   devtools console `localStorage.setItem('raci-matrix-v8', '<json>')` then reload). Same shape as §2.
3. **Replace the demo generator.** Edit `defaultState()` / `seedData()` in the file so a fresh load
   (or **Reset**) produces the real data. Use only if the data should ship inside the HTML.

Validate by exporting first: load the app, **Export JSON**, and study the shape — that exact shape
always re-imports cleanly.

---

## 6. Editing the file (only when data alone can't do it)

| Goal | Edit |
|---|---|
| Rename the 7 RACI columns to real party names | `COL_LABELS` and `COL_SHORT` (~line 1840). |
| Change the **number** of RACI columns | `COLS` array **and** matching `COL_LABELS`+`COL_SHORT` keys. `ACTOR_WIDE`/`columnsForTier` are optional tweaks. |
| Rename the 6 directorates | No edit — set `state.actorLabels` in the JSON. |
| Change the **number** of directorates | `ACTORS` and `ACTOR_LABELS_DEFAULT` (~line 1821). |
| Change tier names/depth | `TIER_LABELS` (~line 1853); `MAX_TIER` derives from it. |

When you change `COLS` or `ACTORS`, bump `STORAGE_KEY` (~line 1818) so stale localStorage doesn't
fight the new schema.

---

## 7. Procedure for me (Claude) to import a real dataset

1. **Clarify the mapping** with the user: what are their 7 (or N) RACI parties? their tier names? do
   they want a roster? If parties ≠ 7 generic units, decide rename vs. recount (§6).
2. If renaming/recounting columns or directorates is needed, make those file edits first and bump
   `STORAGE_KEY`.
3. Build the `state` JSON per §2–§4:
   - Tree under `activities` (Portfolio→Program→Project→Task), names from the real data.
   - Per row: assign `raci`, keeping **≤1 A** and setting `primaryR` when 2+ R's.
   - Lean on the cascade: put explicit A mainly at the top, let lower levels inherit.
   - Optionally build `directorates` and tag Programs/Projects with `org` (reuse ids).
4. Write it to a `.json` file in the repo and either (a) have the user Import JSON, or (b) seed
   localStorage, or (c) fold into `seedData()`.
5. **Verify headlessly** (a real browser exists): load the file in `chromium --headless --dump-dom`
   and confirm chart blocks/chips render and there are no JS errors; optionally inject a small script
   that calls `resolveCascade()`/`effectiveRaci()` to assert the A's land where expected
   (see the verification approach already used on this project).

---

## 8. Minimal working example (re-imports cleanly)

```json
{
  "title": "Acme Modernization RACI",
  "activities": [
    {
      "name": "Cloud Migration",
      "raci": { "hq": "A", "cyber": "R", "sw": "R", "infra": "C", "contacts": "I" },
      "primaryR": "cyber",
      "children": [
        {
          "name": "Landing Zone Buildout",
          "raci": { "infra": "R", "sw": "C" },
          "children": [
            { "name": "Network Design", "raci": { "infra": "R" }, "children": [] }
          ]
        }
      ]
    }
  ]
}
```

What this produces: the Portfolio "Cloud Migration" is Accountable=Unit1(hq), Responsible=Unit5(cyber)
& Unit6(sw) with **cyber** designated to cascade → its child Program "Landing Zone Buildout" inherits
**A = cyber**, and is itself R on infra → the Project "Network Design" inherits **A = infra**.
