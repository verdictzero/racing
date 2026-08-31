<template>
  <div>
    <div class="tools">
      <button :disabled="!canEdit || !chartId" @click="addRow">+ Add row</button>
      <button :disabled="!canEdit" title="Import a workbook, or download the blank one to fill in"
        @click="excelOpen = true">⊞ Excel…</button>
      <span v-if="violations.length" class="note warn">
        {{ violations.length }} advisory finding(s) — the rule engine is a reading list, never a blocker.
      </span>
    </div>

    <!-- The chooser: two doors, because "import" and "give me the shape to fill in" are the two
         things a person arrives wanting and only one of them is obvious from a file picker. -->
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

    <!-- The preview. An import is not reversible by looking at it afterwards, so what it found and
         what it could not place are shown BEFORE anything is written. -->
    <div v-if="preview" class="xl-overlay" role="dialog" aria-modal="true" @click.self="preview = null">
      <div class="xl-card wide">
        <h3>Import “{{ preview.chart.title }}”?</h3>
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

    <p v-if="!chartId" class="note">
      This workspace has no charts yet.
      <button v-if="canEdit" @click="createChart">Create one</button>
    </p>

    <table v-else class="chart">
      <thead>
        <tr>
          <th class="name">Activity</th>
          <th v-for="col in columns" :key="col">{{ shortLabel(col) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.node.id">
          <td class="name" :style="{ paddingLeft: 8 + row.depth * 20 + 'px' }">
            <input
              :value="row.node.name"
              :disabled="!canEdit"
              :placeholder="tierName(row.depth)"
              @change="rename(row.node.id, ($event.target as HTMLInputElement).value)"
            >
          </td>
          <td v-for="col in columns" :key="col" class="cell">
            <input
              class="raci"
              :value="row.effective[col]?.letters ?? ''"
              :disabled="!canEdit"
              :class="{ inherited: row.effective[col]?.source === 'inherited' }"
              :title="cellTitle(row, col)"
              @change="setCell(row.node.id, col, ($event.target as HTMLInputElement).value)"
            >
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
/**
 * The chart screen — the vertical slice that proves the pipeline.
 *
 * Every read goes through @raci/core's selectors, every write through @raci/crdt's mutations.
 * Nothing here knows what a Y.Map is, which is the point.
 *
 * This is NOT the finished chart screen. The cascade layout, drilling, per-tier panes, the RACI
 * popover and the violation pins are all still in index.html — see docs/dev/PORTING.md slice 1,
 * which is the biggest remaining piece of work in the repo.
 */
import {
  chartColumns,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  effectiveRaci,
  tierLabel,
  walkInOrder,
  depthOf,
  workspaceViolations,
  type EffectiveRow,
  type ChartNode,
} from '@raci/core';
import { importXlsx, type ImportedWorkbook } from '@raci/core';
import {
  addChart,
  addNode,
  insertChart,
  insertEntities,
  renameNode,
  setColumnLabels,
  setNodeRaci,
} from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

// The first chart, until the chart picker comes across with slice 1.
const chart = computed(() => Object.values(session.workspace.value.charts)[0] ?? null);
const chartId = computed(() => chart.value?.id ?? null);
const columns = computed(() => (chart.value ? chartColumns(chart.value) : []));

interface Row {
  node: ChartNode;
  depth: number;
  effective: EffectiveRow;
}

const rows = computed<Row[]>(() => {
  const c = chart.value;
  if (!c) return [];
  return walkInOrder(c.nodes).map((node) => ({
    node,
    depth: depthOf(c.nodes, node.id),
    effective: effectiveRaci(c, c.nodes, node.id),
  }));
});

// Through the workspace wrapper, not chartViolations directly: the supply check needs the
// workspace-wide producer index, and calling the chart-scoped form would silently skip it.
const violations = computed(() =>
  chartId.value ? (workspaceViolations(session.workspace.value).charts.get(chartId.value) ?? []) : [],
);

const shortLabel = (col: string) =>
  chart.value?.custom
    ? (chart.value.custom.cols.find((c) => c.key === col)?.short || col)
    : (COL_SHORT_DEFAULT[col as keyof typeof COL_SHORT_DEFAULT] ?? col);

const tierName = (depth: number) => (chart.value ? tierLabel(chart.value, depth) : 'Row');

function cellTitle(row: Row, col: string) {
  const cell = row.effective[col];
  if (!cell || !cell.letters) return 'No responsibility assigned';
  return cell.source === 'inherited'
    ? `${cell.letters} — inherited from the row above; type here to override`
    : cell.letters;
}

const rename = (nodeId: string, name: string) => renameNode(session.doc, nodeId, name);
const setCell = (nodeId: string, col: string, letters: string) =>
  setNodeRaci(session.doc, nodeId, col, letters.toUpperCase());
const addRow = () => {
  if (chartId.value) addNode(session.doc, { chartId: chartId.value, name: '' });
};
const createChart = () => addChart(session.doc, 'New chart');

// ---- Excel -------------------------------------------------------------------------------------
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
      'The party column headers differ from this workspace’s. Importing renames them for every ' +
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
.note.warn { color: #ffd43b; }
.note.bad { color: #ff8787; }

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
.chart { border-collapse: collapse; width: 100%; }
.chart th { text-align: left; font-size: 11px; color: var(--dim); font-weight: 600;
  padding: 6px 8px; border-bottom: 1px solid var(--border); }
.chart td { border-bottom: 1px solid var(--border); padding: 0; }
.chart td.name { min-width: 320px; }
.chart input { font: inherit; width: 100%; background: transparent; color: inherit;
  border: 0; padding: 6px 8px; }
.chart input:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.chart .raci { width: 64px; text-align: center; letter-spacing: 1px; font-weight: 600; }
.chart .raci.inherited { color: var(--dim); font-style: italic; }
</style>
