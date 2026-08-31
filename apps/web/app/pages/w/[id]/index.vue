<template>
  <div class="chart-screen">
    <div class="tools">
      <button :disabled="!canEdit" @click="excelOpen = true"
        title="Import a workbook, or download the blank one to fill in">⊞ Excel…</button>
      <span v-if="violations.length" class="note warn" :title="violationTitle">
        {{ violations.length }} advisory finding(s) — the rule engine is a reading list, never a blocker.
      </span>
    </div>

    <p v-if="!chart" class="note">
      This workspace has no charts yet.
      <button v-if="canEdit" @click="createChart">Create one</button>
    </p>

    <template v-else>
      <!-- The breadcrumb. Each capsule brings that level back into focus; the last is where you are. -->
      <nav class="crumbs" aria-label="Drill path">
        <button :disabled="!drill.length" @click="drillTo(0)">{{ tierName(0) }}</button>
        <template v-for="(crumb, i) in crumbs" :key="crumb.id">
          <span class="sep">›</span>
          <button :disabled="i === crumbs.length - 1" @click="drillTo(i + 1)">{{ crumb.name }}</button>
        </template>
      </nav>

      <!-- The stack. The focused pane is in front; the ones behind it are desaturated rather than
           transparent, so they cover each other cleanly instead of bleeding through. -->
      <div class="cascade">
        <section
          v-for="(pane, i) in panes"
          :key="pane.tier"
          class="pane"
          :class="{ focus: i === panes.length - 1 }"
          :style="paneStyle(i)"
        >
          <header class="pane-head">
            <span v-if="pane.parent" class="inbound">⤷</span>
            <span v-if="pane.parent" class="pane-parent">{{ pane.parent.name || '(untitled)' }}</span>
            <span v-if="pane.parent" class="sep">›</span>
            <span>{{ tierName(pane.tier) }} activities</span>
            <span class="pane-count">{{ pane.rows.length }}</span>
          </header>

          <table class="chart">
            <thead>
              <tr>
                <th class="c-toggle" />
                <th class="c-name">{{ tierName(pane.tier) }} activity</th>
                <th v-for="col in columns" :key="col" class="c-col" :title="columnLabel(col)">
                  {{ shortLabel(col) }}
                </th>
                <th class="c-act" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in pane.rows"
                :key="row.id"
                class="row"
                :class="{ open: pane.openId === row.id, err: severityOf(row.id) === 'err' }"
              >
                <td class="c-toggle">
                  <button
                    v-if="!pane.isLeafTier"
                    class="caret"
                    :class="{ open: pane.openId === row.id }"
                    :title="pane.openId === row.id ? 'Collapse' : 'Drill into breakdown'"
                    @click="toggleDrill(pane.tier, row.id)"
                  >{{ pane.openId === row.id ? '▾' : '▸' }}</button>
                  <span v-else class="caret leaf" title="The bottom tier — a task flow continues the drill (not yet ported)">·</span>
                </td>

                <td class="c-name">
                  <input
                    :value="row.name"
                    :disabled="!canEdit"
                    :placeholder="tierName(pane.tier)"
                    @change="rename(row.id, ($event.target as HTMLInputElement).value)"
                  >
                  <span v-if="orgBadge(pane, row)" class="org" :title="orgBadge(pane, row)!.full">
                    {{ orgBadge(pane, row)!.short }}
                  </span>
                </td>

                <td
                  v-for="col in columns"
                  :key="col"
                  class="cell"
                  :class="{ editing: editing?.nodeId === row.id && editing?.column === col }"
                  :title="cellTitle(pane, row, col)"
                  @click="canEdit && openCellEditor($event, row.id, col)"
                >
                  <span
                    v-for="letter in lettersOf(pane, row, col)"
                    :key="letter"
                    class="chip"
                    :class="[`l-${letter}`, sourceOf(pane, row, col)]"
                  >{{ letter }}</span>
                </td>

                <td class="c-act">
                  <span
                    v-if="severityOf(row.id)"
                    class="pin"
                    :class="severityOf(row.id)"
                    :title="pinTitle(row.id)"
                  >!</span>
                  <button v-if="canEdit" class="del" title="Delete this row and everything under it"
                    @click="remove(row.id)">×</button>
                </td>
              </tr>

              <tr v-if="!pane.rows.length" class="empty">
                <td :colspan="columns.length + 3">No {{ tierName(pane.tier).toLowerCase() }} activities yet.</td>
              </tr>
            </tbody>
          </table>

          <button v-if="canEdit && i === panes.length - 1" class="add" @click="addRow(pane)">
            + Add {{ tierName(pane.tier).toLowerCase() }} activity
          </button>
        </section>
      </div>

      <!-- The cell editor. Toggles rather than a text field: the letters are a fixed set, and
           typing "AR" when you meant "A R" is a mistake a picker cannot make. -->
      <div v-if="editing" class="raci-pop" :style="popStyle" @click.stop>
        <div class="rp-head">{{ columnLabel(editing.column) }}</div>
        <button
          v-for="letter in frameworkRoles"
          :key="letter"
          class="rp-opt"
          :class="{ on: editingLetters.includes(letter) }"
          @click="toggleLetter(letter)"
        >
          <span class="chip" :class="`l-${letter}`">{{ letter }}</span>
          <span class="rp-name">{{ roleLabel(letter) }}</span>
        </button>
        <button class="rp-close" @click="editing = null">Done</button>
      </div>
      <div v-if="editing" class="raci-scrim" @click="editing = null" />
    </template>

    <div v-if="excelOpen" class="xl-overlay" role="dialog" aria-modal="true"
      @click.self="closeExcel" @keydown.esc="closeExcel">
      <div class="xl-card">
        <h3>Excel</h3>
        <button class="xl-opt" @click="pickFile">
          <span class="xl-name">Import a workbook</span>
          <span class="xl-desc">Read a filled-in .xlsx and add it as a new chart. Nothing already
            here is changed.</span>
        </button>
        <a class="xl-opt" :href="`/api/workspaces/${session.workspaceId}/export?format=template`"
          @click="closeExcel">
          <span class="xl-name">Download the input template</span>
          <span class="xl-desc">A blank workbook in the shape this reads back, with the rules
            written on the first sheet.</span>
        </a>
        <a class="xl-opt" :href="`/api/workspaces/${session.workspaceId}/export?format=xlsx`"
          @click="closeExcel">
          <span class="xl-name">Export this workspace</span>
          <span class="xl-desc">One sheet per tier, plus the deliverables and entities.</span>
        </a>
        <button class="xl-close" @click="closeExcel">Cancel</button>
      </div>
    </div>

    <div v-if="preview" class="xl-overlay" role="dialog" aria-modal="true" @click.self="preview = null">
      <div class="xl-card wide">
        <h3>Import &ldquo;{{ preview.chart.title }}&rdquo;?</h3>
        <p class="xl-stat">
          {{ preview.stats.nodes }} activit{{ preview.stats.nodes === 1 ? 'y' : 'ies' }}
          from {{ preview.stats.rows }} row{{ preview.stats.rows === 1 ? '' : 's' }}
          across {{ preview.stats.sheets.join(', ') }},
          {{ preview.stats.columns }} party column{{ preview.stats.columns === 1 ? '' : 's' }}<template
            v-if="preview.stats.entities">, {{ preview.stats.entities }} entit{{ preview.stats.entities === 1 ? 'y' : 'ies' }}</template>.
        </p>
        <ul v-if="importNotes.length" class="xl-warn">
          <li v-for="(note, i) in importNotes" :key="i">{{ note }}</li>
        </ul>
        <p class="xl-stat">Added as a new chart. Nothing already in the workspace is changed.</p>
        <div class="xl-acts">
          <button class="primary" @click="commitImport">Import</button>
          <button @click="preview = null">Cancel</button>
        </div>
      </div>
    </div>

    <p v-if="importError" class="note bad">{{ importError }}</p>
    <input ref="fileInput" type="file" accept=".xlsx" hidden @change="onFile">
  </div>
</template>

<script setup lang="ts">
/**
 * The chart cascade — PORTING.md slice 1, the screen the whole tool is about.
 *
 * A nested RACI is read by drilling. The top pane shows the Portfolio rows; open one and a Program
 * pane appears in front of it holding that row's breakdown, with the panes behind desaturated so
 * the stack reads as depth. All of the thinking is `resolveCascade` in core; this arranges it.
 *
 * THE DRILL PATH IS NOT DOCUMENT DATA, and that is the single most important thing about this file.
 * Which row YOU have open is a fact about your screen. Putting it in the shared document would mean
 * one person drilling yanks everyone else's view mid-sentence. It lives in component state, and
 * `resolveCascade` hands back the path it could honour so a row deleted by someone else while you
 * had it open collapses the stack instead of leaving an empty pane under a live breadcrumb.
 *
 * CELLS ARE READ THROUGH `displayRaci`, never recomputed here. It resolves three cases the chart
 * has to tell apart and a renderer must not re-derive: a letter the row states, one that cascaded
 * down from an ancestor, and the Informed a blank cell means by convention. Each gets its own
 * class, so the difference is visible rather than implied.
 *
 * NOT PORTED YET, and worth saying rather than leaving to be discovered: zoom, dragging a pane to
 * reposition it, auto-arrange, and the drill from a Task row into its anchored flow (that one waits
 * on the flow canvas, slice 3). All of those are camera and chrome; the cascade itself is here.
 */
import {
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  cascadeCrumbs,
  chartColumns,
  displayRaci,
  framework,
  importXlsx,
  normalizeRaci,
  orgLabel,
  resolveCascade,
  tierLabel,
  workspaceViolations,
  type CascadePane,
  type ChartNode,
  type ImportedWorkbook,
  type Violation,
} from '@raci/core';
import {
  addChart,
  addNode,
  deleteNode,
  insertChart,
  insertEntities,
  renameNode,
  setColumnLabels,
  setNodeRaci,
} from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

/** Camera state. Per-person, never in the shared document — see the header. */
const drill = ref<string[]>([]);

// The first chart, until the chart-tab strip comes across.
const chart = computed(() => Object.values(session.workspace.value.charts)[0] ?? null);
const columns = computed(() => (chart.value ? chartColumns(chart.value) : []));
const fw = computed(() => framework(chart.value?.framework));
const frameworkRoles = computed(() => fw.value.roles);

const cascade = computed(() =>
  chart.value ? resolveCascade(chart.value, drill.value) : null,
);
const panes = computed(() => cascade.value?.panes ?? []);
const crumbs = computed(() => (cascade.value ? cascadeCrumbs(cascade.value) : []));

/**
 * A row someone else deleted leaves a path pointing at nothing.
 *
 * `resolveCascade` never throws on one — it returns the path it could honour — but the local state
 * has to follow, or the next drill would rebuild the same broken stack.
 */
watch(cascade, (next) => {
  if (next?.trimmed && next.path.length !== drill.value.length) drill.value = [...next.path];
});

// ---- violations ---------------------------------------------------------------------------------
// Through the workspace wrapper, not chartViolations directly: the supply check needs the
// workspace-wide producer index, and the chart-scoped form would silently skip it.
const violations = computed(() =>
  chart.value ? (workspaceViolations(session.workspace.value).charts.get(chart.value.id) ?? []) : [],
);
const byNode = computed(() => {
  const map = new Map<string, Violation[]>();
  for (const v of violations.value) {
    const list = map.get(v.nodeId);
    if (list) list.push(v);
    else map.set(v.nodeId, [v]);
  }
  return map;
});
const severityOf = (nodeId: string): 'err' | 'warn' | null => {
  const found = byNode.value.get(nodeId);
  if (!found?.length) return null;
  return found.some((v) => v.severity === 'err') ? 'err' : 'warn';
};
const pinTitle = (nodeId: string) =>
  (byNode.value.get(nodeId) ?? []).map((v) => v.message).join('\n');
const violationTitle = computed(() =>
  violations.value.slice(0, 8).map((v) => v.message).join('\n'),
);

// ---- labels -------------------------------------------------------------------------------------
const tierName = (tier: number) => (chart.value ? tierLabel(chart.value, tier) : 'Row');
const columnLabel = (col: string) =>
  chart.value?.custom?.cols.find((c) => c.key === col)?.label ??
  session.workspace.value.columnLabels[col] ??
  COL_LABELS_DEFAULT[col as keyof typeof COL_LABELS_DEFAULT] ??
  col;
const shortLabel = (col: string) =>
  chart.value?.custom?.cols.find((c) => c.key === col)?.short ??
  session.workspace.value.columnShort[col] ??
  COL_SHORT_DEFAULT[col as keyof typeof COL_SHORT_DEFAULT] ??
  col;
const roleLabel = (letter: string) => fw.value.meta[letter]?.label ?? letter;

// ---- cells --------------------------------------------------------------------------------------
const rowCells = (row: ChartNode) =>
  chart.value ? displayRaci(chart.value, chart.value.nodes, row.id) : {};

const lettersOf = (_pane: CascadePane, row: ChartNode, col: string) =>
  (rowCells(row)[col]?.letters ?? '').split('').filter(Boolean);

const sourceOf = (_pane: CascadePane, row: ChartNode, col: string) =>
  rowCells(row)[col]?.source ?? 'none';

function cellTitle(_pane: CascadePane, row: ChartNode, col: string): string {
  const cell = rowCells(row)[col];
  const name = columnLabel(col);
  if (!cell) return name;
  if (cell.source === 'inherited') {
    return `${name}: ${cell.letters} — cascaded from the row above. Set a letter here to override it.`;
  }
  if (cell.source === 'default') {
    return `${name}: Informed — the default for a cell nobody has set.`;
  }
  return `${name}: ${cell.letters}`;
}

/** The org unit a row belongs to: its own if it states one, otherwise the pane's inherited context. */
function orgBadge(pane: CascadePane, row: ChartNode) {
  const ref = row.org ?? pane.inheritedOrg.branch ?? pane.inheritedOrg.division;
  return ref ? orgLabel(session.workspace.value, ref) : null;
}

/** Behind panes are desaturated and dimmed rather than made transparent, so they do not bleed. */
function paneStyle(i: number) {
  const depth = panes.value.length - 1 - i;
  if (depth === 0) return {};
  return { filter: `saturate(0.16) brightness(${Math.max(0.6, 0.92 - depth * 0.08).toFixed(3)})` };
}

// ---- drilling -----------------------------------------------------------------------------------
const toggleDrill = (tier: number, nodeId: string) => {
  drill.value = drill.value[tier] === nodeId ? drill.value.slice(0, tier) : [...drill.value.slice(0, tier), nodeId];
};
const drillTo = (depth: number) => { drill.value = drill.value.slice(0, depth); };

// ---- editing ------------------------------------------------------------------------------------
const editing = ref<{ nodeId: string; column: string; x: number; y: number } | null>(null);
const popStyle = computed(() =>
  editing.value ? { left: `${editing.value.x}px`, top: `${editing.value.y}px` } : {},
);
const editingLetters = computed(() => {
  if (!editing.value || !chart.value) return '';
  return chart.value.nodes[editing.value.nodeId]?.raci[editing.value.column] ?? '';
});

/** Anchored under the cell that was clicked, and kept on screen at the right-hand edge. */
function openCellEditor(event: MouseEvent, nodeId: string, column: string) {
  const box = (event.target as HTMLElement).closest('td')?.getBoundingClientRect();
  editing.value = {
    nodeId,
    column,
    x: Math.min(box?.left ?? 80, window.innerWidth - 220),
    y: (box?.bottom ?? 80) + 4,
  };
}

/**
 * Toggle one letter on the cell.
 *
 * Writes only what the row itself states. A cascaded owner is not written back when you touch a
 * different letter — doing so would freeze an inheritance that should keep following its ancestor.
 */
function toggleLetter(letter: string) {
  if (!editing.value) return;
  const current = new Set(editingLetters.value.split('').filter(Boolean));
  if (current.has(letter)) current.delete(letter);
  else current.add(letter);
  setNodeRaci(session.doc, editing.value.nodeId, editing.value.column, normalizeRaci([...current].join('')));
}

const rename = (nodeId: string, name: string) => renameNode(session.doc, nodeId, name);

function addRow(pane: CascadePane) {
  if (!chart.value) return;
  addNode(session.doc, { chartId: chart.value.id, parentId: pane.parent?.id ?? null, name: '' });
}

function remove(nodeId: string) {
  if (!chart.value) return;
  deleteNode(session.doc, chart.value.id, nodeId);
  // Drilling into a row that no longer exists would leave an empty pane. The watcher above catches
  // it too, but collapsing here keeps the click and the redraw in the same frame.
  const at = drill.value.indexOf(nodeId);
  if (at >= 0) drill.value = drill.value.slice(0, at);
}

const createChart = () => addChart(session.doc, 'New chart');

// ---- Excel --------------------------------------------------------------------------------------
const excelOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const preview = shallowRef<ImportedWorkbook | null>(null);
const importError = ref('');

const closeExcel = () => { excelOpen.value = false; };
const pickFile = () => { excelOpen.value = false; fileInput.value?.click(); };

/**
 * Parsed in the browser, not on the server.
 *
 * `importXlsx` is pure and portable — the inflater is a platform API — so there is no upload
 * endpoint and no round trip before the preview. It also means the import lands through the same
 * collaborative document as every other edit: peers see it arrive, and undo can reach it.
 */
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // so choosing the same file twice fires again
  if (!file) return;

  importError.value = '';
  try {
    preview.value = await importXlsx(new Uint8Array(await file.arrayBuffer()), { fileName: file.name });
  } catch (err) {
    preview.value = null;
    importError.value = err instanceof Error ? err.message : 'Could not read that workbook.';
  }
}

/** Party columns are workspace-wide, so renaming them is worth saying out loud before it happens. */
const renamedColumns = computed(() => {
  const found = preview.value;
  if (!found) return [];
  const current = session.workspace.value.columnLabels;
  return Object.entries(found.labels).filter(([key, label]) => {
    const existing = current[key] ?? COL_LABELS_DEFAULT[key as keyof typeof COL_LABELS_DEFAULT] ?? key;
    return label && label !== existing;
  });
});

const importNotes = computed(() => {
  const notes = [...(preview.value?.warnings ?? [])];
  if (renamedColumns.value.length > 0) {
    notes.push(
      'The party column headers differ from this workspace\u2019s. Importing renames them for every ' +
        'organization chart, not just this one.',
    );
  }
  return notes;
});

function commitImport() {
  const found = preview.value;
  if (!found) return;
  insertChart(session.doc, found.chart);
  insertEntities(session.doc, found.entities);
  if (renamedColumns.value.length > 0) setColumnLabels(session.doc, found.labels, found.shorts);
  preview.value = null;
}
</script>

<style scoped>
.tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.note { color: var(--dim); font-size: 12px; }
.note.warn { color: #ffd43b; cursor: help; }
.note.bad { color: #ff8787; }

.crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.crumbs button { font-size: 12px; background: none; border: 0; padding: 2px 4px;
  color: var(--accent); cursor: pointer; }
.crumbs button:disabled { color: var(--text); cursor: default; font-weight: 600; }
.crumbs .sep, .pane-head .sep { color: var(--dim); font-size: 10px; }

/* The stack. Panes overlap so the ones behind peek out at the top edge, which is what makes the
   depth legible without a legend. */
.cascade { display: flex; flex-direction: column; }
.pane { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  overflow: hidden; margin-top: -6px; }
.pane:first-child { margin-top: 0; }
.pane.focus { border-color: var(--accent); box-shadow: 0 -6px 18px rgba(0, 0, 0, .35); }
.pane-head { display: flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: 12px;
  background: var(--bg); border-bottom: 1px solid var(--border); }
.pane-parent { font-weight: 600; }
.inbound { color: var(--accent); }
.pane-count { margin-left: auto; color: var(--dim); font-size: 11px;
  border: 1px solid var(--border); border-radius: 9px; padding: 0 7px; }

.chart { border-collapse: collapse; width: 100%; }
.chart th { text-align: left; font-size: 10px; color: var(--dim); font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; padding: 5px 8px;
  border-bottom: 1px solid var(--border); }
.chart td { border-bottom: 1px solid var(--border); padding: 0 4px; }
.chart tr:last-child td { border-bottom: 0; }
.row.open { background: rgba(77, 171, 247, .07); }
.row.err .c-name input { color: #ff8787; }
.empty td { color: var(--dim); font-size: 12px; padding: 10px 12px; }

.c-toggle { width: 30px; text-align: center; }
.c-name { min-width: 280px; }
.c-name input { font: inherit; width: 100%; background: transparent; color: inherit;
  border: 0; padding: 6px 4px; }
.c-name input:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.c-col { width: 58px; text-align: center; }
.c-act { width: 54px; text-align: right; white-space: nowrap; }

.caret { background: none; border: 0; color: var(--dim); cursor: pointer; font-size: 12px;
  padding: 2px 4px; }
.caret:hover { color: var(--accent); }
.caret.open { color: var(--accent); }
.caret.leaf { cursor: default; opacity: .4; }

.org { font-size: 10px; color: var(--dim); border: 1px solid var(--border);
  border-radius: 9px; padding: 0 6px; margin-left: 6px; white-space: nowrap; }

.cell { text-align: center; cursor: pointer; padding: 3px 2px; }
.cell:hover { background: rgba(255, 255, 255, .04); }
.cell.editing { outline: 1px solid var(--accent); outline-offset: -1px; }
.chip { display: inline-block; min-width: 17px; font-size: 10px; font-weight: 700;
  border-radius: 4px; padding: 1px 3px; margin: 0 1px; border: 1px solid transparent; }
.chip.l-A { background: #7a4a12; color: #ffd8a8; }
.chip.l-R { background: #1c5c33; color: #b2f2bb; }
.chip.l-S { background: #1b4a5c; color: #99e9f2; }
.chip.l-C { background: #4a3a6b; color: #d0bfff; }
.chip.l-I { background: #2c313a; color: #adb5bd; }
/* Inherited and defaulted cells read as ghosts: present, but not stated here. */
.chip.inherited, .chip.default { background: transparent; color: var(--dim);
  border-style: dashed; border-color: var(--border); font-weight: 600; }
.chip.default { opacity: .55; }

.pin { color: #ffd43b; font-weight: 700; cursor: help; margin-right: 4px; }
.pin.err { color: #ff6b6b; }
.del { background: none; border: 0; color: var(--dim); cursor: pointer; font-size: 14px;
  padding: 2px 5px; }
.del:hover { color: #ff6b6b; }
.add { margin: 8px 12px 10px; border-style: dashed; font-size: 12px; }

.raci-scrim { position: fixed; inset: 0; z-index: 40; }
.raci-pop { position: fixed; z-index: 41; background: var(--bg-2); border: 1px solid var(--accent);
  border-radius: 8px; padding: 6px; min-width: 190px; display: flex; flex-direction: column;
  gap: 2px; box-shadow: 0 8px 24px rgba(0, 0, 0, .5); }
.rp-head { font-size: 11px; color: var(--dim); padding: 2px 6px 4px; }
.rp-opt { display: flex; align-items: center; gap: 8px; background: none; border: 0;
  border-radius: 5px; padding: 4px 6px; cursor: pointer; font: inherit; color: inherit;
  text-align: left; }
.rp-opt:hover { background: var(--bg); }
.rp-opt.on { background: rgba(77, 171, 247, .14); }
.rp-name { font-size: 12px; }
.rp-close { margin-top: 4px; font-size: 12px; }

.xl-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: 50;
  display: flex; align-items: center; justify-content: center; padding: 20px; }
.xl-card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px;
  padding: 18px; width: min(440px, 100%); display: flex; flex-direction: column; gap: 8px; }
.xl-card.wide { width: min(560px, 100%); }
.xl-card h3 { margin: 0 0 6px; font-size: 15px; }
.xl-opt { display: flex; flex-direction: column; gap: 3px; text-align: left; text-decoration: none;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  color: inherit; cursor: pointer; font: inherit; }
.xl-opt:hover { border-color: var(--accent); }
.xl-name { font-weight: 600; font-size: 13px; }
.xl-desc { font-size: 12px; color: var(--dim); }
.xl-close { align-self: flex-end; margin-top: 4px; }
.xl-stat { margin: 0; font-size: 12px; color: var(--dim); }
.xl-warn { margin: 4px 0; padding-left: 18px; font-size: 12px; color: #ffd43b; }
.xl-warn li { margin-bottom: 4px; }
.xl-acts { display: flex; gap: 8px; margin-top: 8px; }
.xl-acts .primary { border-color: var(--accent); color: var(--accent); }
</style>
