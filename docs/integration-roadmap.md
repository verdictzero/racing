# Chart ↔ Business Case Integration Roadmap

*Drafted 2026-07-22 against v0.16 alpha. Line numbers reference `index.html` at commit `7ebfa4b`.*

## Product goal

One system serving both ends of the org:

- **Upper management** establishes RACI responsibility at the Portfolio/Program/Project level and can trust that branch-level flows implement what they signed.
- **Branch/team members** can answer: *what tasks is my team doing, what are the inputs to each task (what + from whom), and what are the outputs (what + to whom)* — from a tasking / RACI / organizational perspective.

## Decisions (product owner, 2026-07-22)

| # | Fork | Decision |
|---|------|----------|
| 1 | Drill experience | **Jump + breadcrumb** — drilling a Task with a linked flow switches to the bizcase view with a persistent `Portfolio › Program › Project › Task` breadcrumb and a charter strip carrying the inherited RACI context. (Embedded cascade pane deferred; data model is identical, so it can be added later.) |
| 2 | Inputs/outputs | **Global artifact registry** — first-class deliverable entities; edges become typed handoffs; producer/consumer validation; exec-facing flow-health roll-up. |
| 3 | Assignment depth | **Team level** — org refs extend to `teamId` (not `personId`). "My tasks" = "my team's tasks." Person-level is a possible later extension via the same choke point. |
| 4 | Authority | **Warn, branch can override** — cascaded exec context arrives as dashed inherited defaults; explicit overrides allowed but visually distinct and flagged in both the exec violations UI and the flow. |

Defaults applied for secondary forks:

- Standalone (tabletop) bizcases remain permanent first-class; the selector groups **Attached** vs **Standalone**.
- Link cardinality: many flows may anchor to one chart node; a flow anchors to at most one node.
- Bizcase `task.parties` re-keys from per-**letter** to per-**column** (lossless migration), unifying the responsibility shape with charts.
- Execution status (`todo/doing/done`) stays **out of scope** — this tool defines responsibility and flow; it is not a project tracker. The dormant field is left alone.
- Export priority: the printable per-branch/team **run book** (from My Work) ships first; XLSX/PPTX/XML flow parity after.
- Operating model assumed: one maintainer edits, others receive exports. Import-merge is still hardened (id-remap + post-merge dangling-id check) because merge is the only sharing path.

## Current-state findings (what the integration must fix)

Confirmed by code audit (7 agents, 2026-07-22):

1. **Zero content links between subsystems.** Bizcases are declared "fully independent of state.charts" (comment ~3464-66). No shared IDs, no promote/copy, no cross-navigation. Only live crossover: `state.columnActor` → `whoFooterHtml` in popovers.
2. **Branch-worker journey breaks at four points:**
   - *Name → tasks:* assignment refs bottom out at **branch** (`normalizeOrgRef` 3559-67 drops anything deeper). Teams/people in the roster are pure decoration — no assignment references a `teamId`/`personId`.
   - *Unit → tasks:* org badges on rows (4515-40) are display-only; no "everything assigned to Branch X" view anywhere.
   - *Task → inputs/outputs:* chart tasks have no edges; bizcase edges carry only a condition `label` (`makeBizEdge` 3482); the Input/Output sockets (4937-38) are cosmetic.
   - *Task → to whom:* handoffs resolve at best to a branch; `columnPerson` (3205-11) resolves only the directorate lead.
3. **Exec-side holes:** violations engine (4278, 6626) and all five structured exports (XML 6284, Mermaid 6337, XLSX 6444, PPTX 6605, print naming 6281) are chart-only — bizcase content never reaches a deck/spreadsheet.
4. **Model mismatch:** chart RACI is keyed per **column**; bizcase parties per **letter** (3475-78) — two columns both holding R can name only one executing party.
5. **Latent bug:** the bizcase popover's who-footer vanishes whenever the *active chart tab* is free-form (`whoFooterHtml` 3251-57 reads `isFreeChart()`/`ac()` — unrelated chart state).
6. **Dead weight:** retired Kanban/Workflow renderers (~4763-4831) and heatmap/amap/search CSS (1609-1727) inflate the file; bizcase `task.status` and `description` fields exist with no UI.
7. **Depth mismatch summary:** chart columns = directorate; `node.org` = branch; bizcase parties = branch; roster = person. The team/person layers are unreachable from every assignment structure — the single precise reason the branch journey cannot complete.

## Architecture summary

- **Link:** `bizCase.anchor: {chartId, nodeId} | null` — stored on the flow side; charts need no new field. `flowsForNode()` derives the reverse. Dangling anchors degrade to standalone (data never deleted).
- **Org refs:** `normalizeOrgRef` extends to `{actor, divisionId?, branchId?, teamId?}` (teamId requires branchId — same containment rule as today). This one choke point deepens `node.org`, bizcase `parties`, and `artifact.ownerRef` at once.
- **Parties:** `bizTask.parties[colKey] = orgRef` (was `parties[letter]`). Migration: copy each legacy letter-ref onto every column whose `raci` holds that letter — lossless in effect (old model never distinguished columns sharing a letter).
- **Artifacts:** `state.artifacts: [{id:'a_'+uid, name, type, ownerRef, description, doc}]`. `type` ∈ document/data/decision/approval/briefing/other. `doc` reuses the node-document shape (3586-92) so the IndexedDB offload pipeline (`eachDocInState` 3840-43, `storageReplacer` 3811) covers it.
- **IO:** chart nodes and biz tasks gain `inputs[]`/`outputs[]` (artifact ids); biz edges gain `artifactIds[]` alongside `label` (the code's own "future hook" at 3480-82). Step-level IO in flows is *derived* from incoming/outgoing edges — never stored redundantly.
- **Cascade into flows:** an anchored flow renders with the chart's inherited-chip semantics — the anchor's effective owner column (via `inheritedOwnerCol` 3213 + `cascadeDown` 6280) shows as a dashed inherited A on steps that don't override; `effectiveRaci` (6266) is reused verbatim (legal: biz task `raci` is keyed by the same global `COLS`).
- **Reconciliation (warn-only):** a flow-rule pass parallel to `recomputeViolations` (6626) feeds the existing pin/toast/popover UI: no owner and no inherited A; explicit owner conflicting with the cascaded owner; decision point (2+ out-edges, 4912) with unlabeled branch; unreachable step; doer column with no party at team/branch depth; `inputWithoutProducer`; `outputNeverConsumed`; `handoffWithoutArtifact`.
- **My Work (team lens):** new view scoped by a Directorate→Division→Branch→Team picker (`state.workScope`, volatile — excluded from undo history). Combined walker: charts matched by cascade-accumulated org context (`resolveCascade` 3945-68 pattern), bizcases by `parties[colKey]` prefix-match. Cards read as work orders: name, letters + column, ancestry breadcrumb, inputs (artifact + from step + producing unit), outputs (artifact + to step + consuming unit), jump links.
- **Navigation:** `bizJumpToTask(bizCaseId, taskId)` — the symmetric twin of `jumpToViolation` (6697): switch view, set active case, center the node via `b.view` pan, flash.

## Phases

### Phase 0 — Groundwork (de-risk before adding ~1000+ lines) ✅ DONE (v0.17, commits `495003d` + `cded074`)
1. Delete dead code: Kanban/Workflow renderers, heatmap/amap/search CSS.
2. Fix `whoFooterHtml`: take an explicit chart-context parameter instead of reading `isFreeChart()`/`ac()`.
3. Extend `normalizeOrgRef` with `teamId`; extend `orgLabel` (3970), `partyLabel` (3991), `partyHierarchy` (3998); add a Team select to the Responsible Party sidebar (`renderBizPartyPanel` 5683).
4. Re-key `parties` letter → column (migration in the bizCases block of `migrateState` 3745-96); sidebar targets `{taskId, colKey}`.
5. Give bizcase task `description` a UI (it exists in the model, 3478, but nowhere to type it).

### Phase 1 — Anchor + navigation (decision 1a) ✅ DONE (v0.18, commit `94f8518`)
1. `bizCase.anchor` + migration (backfill null, drop dangling → standalone).
2. Task-tier rows get a `⤵ flow` affordance: open anchored flow / "Create flow" (seeded with the row's `effectiveRaci`) / "Attach existing…".
3. Bizcase view, when anchored: ancestry breadcrumb (via `pathToNode` 6685) with click-back to the chart drill, plus a charter strip (anchor name, effective RACI chips, inherited-A indicator, inherited Division/Branch badges).
4. `bizJumpToTask`; Details rail "Linked flows" section; row-eye popover flow chip; selector grouped Attached/Standalone.
5. `importJSON` merge (7140-68): remap `anchor.chartId` through the old→new chart-id map.

### Phase 2 — Inherited context + warn-only reconciliation (decision 4a) ✅ DONE (v0.19)
1. Anchored flows render cascade-aware chips (dashed inherited A; explicit overrides visually distinct).
2. Inherited party defaults on cards from anchor org refs + `columnActor` (dashed capsules until explicitly set).
3. Flow-rule pass feeding the existing violations UI; pins on flow cards; include bizcase in the `render()` recompute (remove the skip at 4278).

### Phase 3 — Artifact spine (decision 2a) ✅ DONE (v0.20)
1. `state.artifacts` registry + management UI (reference counts, orphan flags, delete guarded when referenced).
2. `inputs[]`/`outputs[]` on chart nodes and biz tasks; `artifactIds[]` on edges; edge popover multi-select ("adopt into producer outputs / consumer inputs" one-click fixer).
3. Flow table: "Hands off" column; topological row order from in-degree-0 tasks (replacing insertion order, 4969).
4. Derived per-render indexes (`artifactProducers`/`artifactConsumers`); the three artifact rules; flow-health chip on anchored chart rows (roll-up %).
5. Details rail Inputs/Outputs sections; row-eye Consumes/Produces blocks.
6. Merge hardening: artifact id remap + post-merge dangling-id invariant scan.

### Phase 4 — My Work + run book (decision 3b) ✅ DONE (v0.21)
1. Fourth view `work` in `ALL_VIEW_MODES` (3553) + `render()` dispatch; scope picker to Team depth; `state.workScope` volatile.
2. Combined chart+bizcase walker; work-order cards with jump links both ways.
3. Print run book: `beforeprint` (7178-91) gains a `work` branch with a unit title band — the first branch-facing export in the app.

### Phase 5 — Export parity
1. XLSX Flows sheet (step, parties to team depth, inputs, outputs, condition) keyed by anchor ancestry; Artifacts sheet.
2. PPTX: one slide per anchored flow's step table. XML: `<flow>` under the anchored activity + `<artifacts>` section. Mermaid: flow graph export.
3. Fix `fileBase` (6281) to use the bizcase name when exporting from the bizcase view.

## Implementation deviations (recorded as built)

- **Flow-step IO is derived-only** (from `edge.artifactIds`), never stored on biz tasks — the roadmap's "never stored redundantly" line won over the data-model sketch that gave biz tasks `inputs[]/outputs[]`. Chart nodes keep stored boundary IO (no edges exist at chart level to derive from).
- **`outputNeverConsumed` is not a violation** — terminal deliverables are legitimate, so unconsumed artifacts surface as registry annotations (orphan flag / ref-counts) instead of warnings, avoiding the warn-storm risk the designers flagged.
- Artifact `ownerRef`/`doc` exist in the model but have no UI yet (owner picker and attached spec docs ride a later phase).

## Known limitations accepted for now

- **Free-form charts stay excluded** from roster-linked features (they delete org refs at 3596) — anchoring/My Work silently skip them; the UI should say so rather than hide it.
- **No server:** exec-authors / branch-reads implies a distribution habit (export → import merge). The merge id-remap is the most dangerous code in the plan; the Phase 3 invariant scan exists for this reason.
- **Registry hygiene** (duplicate artifact names) is mitigated by pick-before-create typeahead + reference counts, not solved.
- Undo snapshots grow with the registry; doc bytes are already stripped from history, so this is expected to stay within quota.
