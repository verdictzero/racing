# Changelog — ASIC RACI Tool

Scheme: `MAJOR.MINOR`, alpha while below 1.0. The authoritative per-release notes live in the
header comment of `index.html` (next to `APP_VERSION`, which is bumped on every shipped change
set). This file is the readable index; [`docs/changelog.html`](docs/changelog.html) is the same
history laid out as a page.

---

## 0.35 — 13 Aug 2026

**Redirectors on a handoff.** Drag any noodle in a task flow and it bends around whatever is in
the way, leaving a handle you can drag again or double-click to remove. A click without travel
still opens the handoff popover.

Routing lives on the edge (`edge.via[]`), not in `b.tasks`. A routed handoff is still one handoff
from A to B, so derived IO, group boundary crossings, the flow table, the rules and all five
exports are untouched by how the line gets there. Handles ride in their own SVG layer above the
cards — a handle a card covers is a handle you cannot grab, and steering around a card is exactly
when you reach for one. A branch condition now rides the middle of the route rather than the
straight line between the ends.

- **Added** — a third field guide, *How do I use this tool*: every screen and gesture in the order
  you meet them, plus a cheat sheet of the ones clicking around never reveals
  (`docs/how-to.html`, mirrored inline as `#help-doc-src3`).
- **Fixed** — the right rail widened to 244px and the product name no longer wraps; the version
  chip drops to its own line.
- **Fixed** — the breadcrumb's tier label on a filled chip now reads off `--on-fill`. It was ink at
  62%, which works only while every tier fill is bright; `hc-light` deepens its fills.
- **Fixed** — hiding the flow gallery now names the way back.

## 0.34 — 13 Aug 2026

- **Changed** — the Free-Form / Chart-Linked picker *is* the mode strip's label now, right-justified
  where the badge used to be. The toolbar copy is gone: it was one fact in two places.
- **Removed** — DACI and RAPID on task flows. `BIZ_FRAMEWORKS` is `['raci']`, so a legacy file
  naming either normalizes to RACI on load rather than becoming unreachable state. Charts keep
  RACI and RASCI.
- **Added** — high contrast becomes a family of three: `hc-light` (white paper, black rules, hues
  deepened rather than brightened), `hc-dark` (the previous `contrast` palette, unchanged) and
  `hc-neon`. All three share one structural stylesheet via a `[data-theme^="hc-"]` prefix selector.
  A stored `contrast` preference migrates to `hc-dark` in both the pre-paint bootstrap and
  `applyTheme`.
- **Fixed** — group membership survives a drag. A step used to leave its frame the moment it was
  dropped past the frame's edge, and the frame froze mid-drag so that edge was where it *had* been.
  The frame now follows its members live; hold <kbd>Alt</kbd> / <kbd>⌥</kbd> while dragging to
  take one out deliberately, announced by a hint chip in the frame's own header.

## 0.33 — 13 Aug 2026

- **Changed** — Chart / Roster / Tasks get the same boxed treatment the task flow already had, in
  R-blue against the flow's green. One box component used twice, each carrying its hue in
  `--vt-hue-rgb`; high contrast redraws both as 2px hued edges.

## 0.32 — 11 Aug 2026

**Draft / Final on every chart and every flow.** Both states are always labelled — a DRAFT marking
that appeared only when something was wrong would teach people to read "no marking" as "approved".

- Final locks the artifact three ways: affordances removed at render, fields made inert, and a
  capture-phase gate for what neither reaches. `enforceLocks()` runs on every save and puts back
  anything that moved, whatever path produced it. An accident guard, not a permission system.
- A Final flow reading rows from a Draft chart is flagged per step (`flowFinalDraftSource`).
- Status reaches all five exports: an XLSX Document sheet and Status column, XML attributes, a
  Mermaid header, PowerPoint stamps, and a diagonal DRAFT watermark on every printed page.

## 0.31 — 11 Aug 2026

- **Added** — two explicit flow modes. **Chart-Linked**: every step names the org-chart row it
  implements (`task.bind`) and reads that row's RACI live. **Free-Form**: RACI authored on the
  step, and what every pre-0.31 flow was. Switching is lossless both ways.
- **Changed** — the task flow gets its own box in the rail, apart from the three chart lenses.

## 0.30 — 7 Aug 2026

- **Added** — flow gallery: every flow as a card carrying a sketch of its actual graph.
- **Added** — nested flows. A card dragged onto the canvas becomes one box referencing that whole
  flow — a reference, not a copy. Reference loops are blocked at the source and flagged on import.
- **Added** — per entry/exit mating points on a nested box, so a procedure that ends two ways can
  feed two different next steps. Ports store the selection, not a count; empty means "all of them".
- **Added** — groups: labelled frames that are visual, conceptual and functional. An expanded frame
  is derived from its members' bounding box; collapsed, it becomes one box whose sockets are its
  real boundary crossings.
- **Fixed** — flow noodles read their colours from the live theme instead of baked literals.

## 0.29 — 7 Aug 2026

- **Added** — Light and High Contrast themes alongside the default Dark, from a segmented control
  in the toolbar (arrow keys move through it), remembered per device under its own storage key.
- **Fixed** — no dark flash on load: an inline `<head>` bootstrap stamps the stored theme on
  `<html>` before the first paint.
- The theme is a device preference, not document data — left out of the exported JSON, and it
  survives Load / Merge / Demo / Clear. An unset preference is deliberately *not* resolved against
  the OS, so a fresh browser always opens dark.

---

Earlier history (0.1 – 0.28) is in the `index.html` header comment.
