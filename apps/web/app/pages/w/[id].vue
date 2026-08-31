<template>
  <section>
    <header class="bar">
      <h1>{{ workspace?.name ?? 'Workspace' }}</h1>
      <span class="status" :data-state="collab?.status.value">
        {{ statusLabel }}
      </span>
      <span v-if="collab && collab.peers.value > 1" class="dim">
        {{ collab.peers.value }} people here
      </span>
      <span class="spacer" />
      <button :disabled="!canEdit" @click="addRow">+ Add row</button>
      <button :disabled="!canEdit" @click="collab?.undo.undo()">Undo</button>
    </header>

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

    <p v-if="violations.length" class="note warn">
      {{ violations.length }} advisory finding(s) — the rule engine is a reading list, never a blocker.
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * The vertical slice: a chart rendered straight out of the collaborative document.
 *
 * Every read goes through @raci/core's selectors, and every write through @raci/crdt's mutations.
 * Nothing here knows what a Y.Map is, which is the point — when the rest of the UI is ported it
 * gets the same two seams and no direct access to the CRDT.
 *
 * This is NOT the finished chart screen. The cascade layout, drilling, the flow canvas, the roster
 * and the exports are all still in index.html; see docs/dev/PORTING.md for the order they come
 * across in. What this proves is that the pipeline works end to end: Postgres → Yjs → core
 * selectors → DOM, and back again with two browsers seeing each other's edits.
 */
import {
  chartColumns,
  chartViolations,
  COL_SHORT_DEFAULT,
  effectiveRaci,
  tierLabel,
  walkInOrder,
  depthOf,
  type Chart,
  type EffectiveRow,
  type ChartNode,
} from '@raci/core';
import { addNode, addChart, readChart, renameNode, setNodeRaci } from '@raci/crdt';

const route = useRoute();
const workspaceId = route.params.id as string;

const { data: payload } = await useFetch(`/api/workspaces/${workspaceId}`);
const { data: me } = await useFetch('/api/auth/me');
const workspace = computed(() => payload.value?.workspace);
const canEdit = computed(() => me.value?.user?.role === 'editor' || me.value?.user?.role === 'admin');

const collab = shallowRef<ReturnType<typeof useCollab> | null>(null);
const chart = shallowRef<Chart | null>(null);
const chartId = computed(() => chart.value?.id ?? null);

onMounted(() => {
  const session = useCollab(workspaceId);
  collab.value = session;

  // One observer over the whole document. Re-reading the chart on any change is O(rows) and the
  // charts here are hundreds of rows, not millions — a fine-grained binding would be a lot of
  // machinery to save a millisecond.
  const refresh = () => {
    const first = [...session.doc.getMap('charts').keys()][0];
    chart.value = first ? readChart(session.doc, first) : null;
  };
  session.doc.on('update', refresh);
  refresh();

  onBeforeUnmount(() => {
    session.doc.off('update', refresh);
    session.destroy();
  });
});

const statusLabel = computed(() => {
  switch (collab.value?.status.value) {
    case 'connected': return 'live';
    case 'connecting': return 'connecting…';
    default: return 'offline — your edits are kept and will sync';
  }
});

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

const violations = computed(() => (chart.value ? chartViolations(chart.value) : []));

const shortLabel = (col: string) =>
  chart.value?.custom
    ? (chart.value.custom.cols.find((c) => c.key === col)?.short || col)
    : (COL_SHORT_DEFAULT[col as keyof typeof COL_SHORT_DEFAULT] ?? col);

const tierName = (depth: number) =>
  chart.value ? tierLabel(chart.value, depth) : 'Row';

function cellTitle(row: Row, col: string) {
  const cell = row.effective[col];
  if (!cell || !cell.letters) return 'No responsibility assigned';
  return cell.source === 'inherited'
    ? `${cell.letters} — inherited from the row above; type here to override`
    : cell.letters;
}

function rename(nodeId: string, name: string) {
  if (collab.value) renameNode(collab.value.doc, nodeId, name);
}
function setCell(nodeId: string, col: string, letters: string) {
  if (collab.value) setNodeRaci(collab.value.doc, nodeId, col, letters.toUpperCase());
}
function addRow() {
  if (collab.value && chartId.value) {
    addNode(collab.value.doc, { chartId: chartId.value, name: '' });
  }
}
function createChart() {
  if (collab.value) addChart(collab.value.doc, 'New chart');
}
</script>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.bar h1 { font-size: 18px; margin: 0; }
.spacer { flex: 1; }
.status { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); }
.status[data-state='connected'] { color: #51cf66; border-color: #2b6b3a; }
.status[data-state='offline'] { color: #ffa94d; border-color: #7a4a12; }
.dim, .note { color: var(--dim); font-size: 12px; }
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
