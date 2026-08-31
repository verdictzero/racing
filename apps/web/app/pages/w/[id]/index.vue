<template>
  <div>
    <div class="tools">
      <button :disabled="!canEdit || !chartId" @click="addRow">+ Add row</button>
      <span v-if="violations.length" class="note warn">
        {{ violations.length }} advisory finding(s) — the rule engine is a reading list, never a blocker.
      </span>
    </div>

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
  COL_SHORT_DEFAULT,
  effectiveRaci,
  tierLabel,
  walkInOrder,
  depthOf,
  workspaceViolations,
  type EffectiveRow,
  type ChartNode,
} from '@raci/core';
import { addNode, addChart, renameNode, setNodeRaci } from '@raci/crdt';

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
</script>

<style scoped>
.tools { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.note { color: var(--dim); font-size: 12px; }
.note.warn { color: #ffd43b; }
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
