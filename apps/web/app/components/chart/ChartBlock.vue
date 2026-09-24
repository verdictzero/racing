<template>
  <!-- index.html's renderChartBlock. Behaviour is delegated from the page on the source's own
       data-* attributes, exactly as the source wires it, so this is markup only. -->
  <div class="chart-block" :class="focus ? 'focus' : 'faded'" :data-tier="pane.tier" :data-depth="depth" :style="layerStyle">
    <div class="chart-head" :data-chart-head="pane.tier" title="Drag to move this pane · double-click to snap it back">
      <template v-if="pane.tier > 0"><span class="ch-inbound">⤷</span>{{ ' ' }}</template>
      <template v-if="pane.tier === 0">
        <template v-if="free"><TierSpan />{{ ' Activities' }}</template>
        <template v-else>Portfolio Activities</template>
      </template>
      <template v-else>
        {{ pane.parent?.name || ('Untitled ' + tierLabel(chart, pane.tier - 1)) }} <span class="ch-sep">›</span> <TierSpan />{{ ' Activities' }}
      </template>
    </div>
    <table class="chart">
      <thead>
        <tr>
          <th class="ch-toggle" />
          <th class="ch-name">{{ tierLbl }} activity</th>
          <th class="ch-desc" title="Activity definition / description">Definition</th>
          <th class="ch-docs" title="Attached process documents">Documents</th>
          <th v-for="k in cols" :key="k" class="ch-col" :class="{ 'col-editable': canEditCols }"
            :title="canEditCols ? 'Click the name to rename this party' : colLabel(k)">
            <button v-if="focus" class="col-view" :data-col-view="k"
              :title="`Node view — every activity where ${colLabel(k)} holds a role`">👁</button>
            <template v-if="canEditCols">
              <button v-if="cols.length > 1" class="col-del" :data-col-del="k"
                title="Remove this party column (discards its letters on every row)">×</button>
              <span class="col-edit" contenteditable="true" spellcheck="false" :data-col-edit="k">{{ colLabel(k) }}</span>
            </template>
            <template v-else>{{ colLabel(k) }}</template>
          </th>
          <th class="ch-del"><button v-if="canEditCols" class="col-add" data-col-add="1" title="Add a party column">+</button></th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!pane.rows.length" class="ch-empty-row"><td :colspan="cols.length + 5">No {{ tierLbl.toLowerCase() }} activities yet.</td></tr>
        <tr v-for="node in pane.rows" :key="node.id" class="chart-row"
          :class="{ open: pane.openId === node.id, 'violation-err': vio(node.id)?.severity === 'err', 'row-active': activeNodeId === node.id }"
          :data-id="node.id">
          <td class="ch-toggle">
            <template v-if="leaf">
              <button class="ch-caret flow" :class="{ 'has-flow': flowsFor(node.id).length }" :data-flow-btn="node.id"
                :title="flowTitle(node.id)">⤵</button>
            </template>
            <button v-else class="ch-caret" :class="{ open: pane.openId === node.id }" :data-drill="node.id" :data-tier="pane.tier"
              :title="pane.openId === node.id ? 'Collapse' : 'Drill into breakdown'">{{ pane.openId === node.id ? '▾' : '▸' }}</button>
          </td>
          <td class="ch-name"><button class="row-view" :data-row-view="node.id"
            :title="`Node view — how each party lands on this ${tierLbl.toLowerCase()}`">👁</button><span class="ch-name-edit"
            :contenteditable="canEdit ? 'true' : 'false'" spellcheck="false" :data-node-id="node.id" data-field="name"
            :data-placeholder="`${tierLbl} name`">{{ node.name }}</span><button v-if="leaf && health(node.id)"
            class="flow-health" :class="health(node.id)!.cls" :data-flow-btn="node.id"
            :title="`Flow health ${health(node.id)!.pct}% — steps with an owner and a doer, handoffs naming a deliverable. Click for the flow.`">⤵ {{ health(node.id)!.pct }}%</button><ChartOrgRow
            :chart="chart" :node="node" :tier="pane.tier" :inherited="pane.inheritedOrg" /></td>
          <td v-if="!(node.description || '').trim()" class="desc-cell" :data-open-details="node.id" title="Click to add a definition"><span class="desc-empty">+ Add definition</span></td>
          <td v-else class="desc-cell" :data-open-details="node.id" :title="node.description.trim()"><span class="desc-snippet">{{ node.description.trim() }}</span></td>
          <td v-if="!node.documents.length" class="docs-cell empty" :data-attach-direct="node.id" title="Click to attach a process document"><span class="docs-empty">+ Attach document</span></td>
          <td v-else class="docs-cell" :data-open-details="node.id"
            :title="`${node.documents.length} document${node.documents.length === 1 ? '' : 's'} — click a chip to open, click empty area to manage`">
            <div class="docs-chip-list"><span v-for="d in node.documents" :key="d.id" class="docs-chip" :data-doc-open="`${node.id}|${d.id}`"
              :title="`Open ${d.name} (${fmtBytes(d.size)})`"><span class="dc-icon">{{ docIconFor(d.name, d.type) }}</span><span class="dc-name">{{ d.name }}</span></span></div>
          </td>
          <td v-for="k in cols" :key="k" class="chart-cell" :class="{ 'needs-primary': needsPrimary(node) }" :data-id="node.id" :data-col="k" :title="cellTip(k)">
            <div class="cell-chips">
              <span v-for="c in chips(node, k)" :key="c.l + c.cls" class="raci-chip" :class="[c.l, c.cls]" :title="c.title">{{ c.l }}</span>
            </div>
          </td>
          <td class="ch-del"><button :data-del-node="node.id" title="Delete">×</button><span v-if="vio(node.id)"
            class="violation-pin" :class="{ warn: vio(node.id)!.severity !== 'err' }" :data-violation-jump="node.id"
            :title="vio(node.id)!.issues.map((i) => i.message).join('\n')">!</span></td>
        </tr>
      </tbody>
    </table>
    <button v-if="pane.tier === 0" class="ch-add" data-add-root="1">+ Add {{ tierLbl.toLowerCase() }} activity</button>
    <button v-else class="ch-add" :data-add-child="pane.parent?.id">+ Add {{ tierLbl.toLowerCase() }} activity</button>
  </div>
</template>

<script setup lang="ts">
/**
 * One pane of the cascade — index.html's renderChartBlock, renderNodeRow, cellChipsHtml,
 * descCellHtml and docsCellHtml. The page lays the panes out (layoutCascade) and handles every
 * click on them by the same data-* attributes the source delegates on.
 */
import {
  doerColumns,
  framework,
  normalizeRaci,
  primaryDoerColumn,
  tierLabel,
  type CascadePane,
  type Chart,
  type ChartNode,
} from '@raci/core';
import { h } from 'vue';
import { docIconFor, fmtBytes } from '~/composables/useDocuments';
import type { ViolationRecord } from '~/composables/useViolationRecords';

const props = defineProps<{
  chart: Chart;
  pane: CascadePane;
  idx: number;
  total: number;
  cols: readonly string[];
  size: { w: number; h: number } | null;
  records: ReadonlyMap<string, ViolationRecord>;
  flows: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  health: (nodeId: string) => { pct: number; cls: string } | null;
  activeNodeId: string | null;
  canEdit: boolean;
}>();

const labels = useLabels();
const fw = computed(() => framework(props.chart.framework));
const focus = computed(() => props.idx === props.total - 1);
const depth = computed(() => props.total - 1 - props.idx);
const free = computed(() => !!props.chart.custom);
const tierLbl = computed(() => tierLabel(props.chart, props.pane.tier));
const leaf = computed(() => props.pane.isLeafTier);
const canEditCols = computed(() => free.value && focus.value);

/**
 * Behind layers stay opaque and are desaturated and dimmed instead, so they cover the layer below
 * cleanly. A user-set width applies to every layer (the stack stays aligned); height and scroll
 * only to the focused one.
 */
const layerStyle = computed(() => {
  const s: Record<string, string | number> = { zIndex: props.idx + 1 };
  if (!focus.value) {
    s.opacity = 1;
    s.filter = `saturate(0.16) brightness(${Math.max(0.6, 0.92 - depth.value * 0.08).toFixed(3)})`;
  }
  const sz = props.size;
  if (sz?.w) { s.width = `${sz.w}px`; s.minWidth = '0'; s.maxWidth = 'none'; }
  if (focus.value && sz && (sz.w || sz.h)) s.overflow = 'auto';
  if (focus.value && sz?.h) s.height = `${sz.h}px`;
  return s;
});

const colLabel = (k: string) => labels.colLabel(k, props.chart);
function cellTip(k: string): string {
  const who = free.value ? null : labels.columnPerson(k);
  return colLabel(k) + (who?.name ? ` — ${who.name}` : '');
}
const vio = (id: string) => props.records.get(id);
const flowsFor = (id: string) => props.flows.get(id) ?? [];
function flowTitle(id: string): string {
  const f = flowsFor(id);
  if (!f.length) return 'Continue the drill into a task flow — create or attach one';
  return `Task flow — ${f.length === 1 ? `"${f[0]!.name}"` : `${f.length} attached flows`} (click to open)`;
}

function needsPrimary(node: ChartNode): boolean {
  return doerColumns(node, props.cols, fw.value).length > 1 && !primaryDoerColumn(node, props.cols, fw.value);
}

/** index.html's cellChipsHtml: stated letters in role order, the inherited owner, else a default I. */
function chips(node: ChartNode, col: string) {
  const F = fw.value;
  const manual = new Set(normalizeRaci(node.raci[col] ?? '').split('').filter(Boolean));
  const isPrimaryR = doerColumns(node, props.cols, F).length > 1 && primaryDoerColumn(node, props.cols, F) === col;
  const inheritedA = props.pane.inheritedOwnerColumn === col;
  const out: Array<{ l: string; cls: string; title?: string }> = [];
  for (const l of F.roles) {
    if (manual.has(l)) {
      const primary = l === F.doer && isPrimaryR;
      out.push({ l, cls: primary ? 'primary-r' : '',
        title: primary ? `Primary ${F.meta[F.doer]?.label} — cascades down as ${F.meta[F.owner]?.label}` : undefined });
    } else if (l === F.owner && inheritedA && !manual.has(F.owner)) {
      out.push({ l: F.owner, cls: 'inherited', title: `${F.meta[F.owner]?.label} — inherited (${F.meta[F.doer]?.label} one level up)` });
    }
  }
  if (!out.length) out.push({ l: 'I', cls: 'inherited', title: 'Informed — default (no explicit role set)' });
  return out;
}

/** The level name on a free-form chart's focused pane is renamable in place. */
const TierSpan = () => (free.value && focus.value
  ? h('span', { class: 'tier-edit', contenteditable: 'true', spellcheck: 'false', 'data-tier-edit': props.pane.tier,
    title: 'Click to rename this level' }, tierLbl.value)
  : tierLbl.value);
</script>
