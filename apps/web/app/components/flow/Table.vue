<template>
  <!-- index.html's .bz-table-pane, filled by bizTableHtml: the RACI table, then the flow table. -->
  <aside v-if="flow" id="bz-table" class="bz-table-pane" @click="onClick" @change="onChange">
    <div class="bz-table-head"><h3>RACI table</h3><span class="bz-meta">click a cell to edit</span></div>
    <table class="bz-table">
      <thead><tr><th class="bz-th-task">Task</th><th v-for="k in COLS" :key="k" :title="chrome.colLabel(k)">{{ chrome.colShort(k) }}</th></tr></thead>
      <tbody>
        <template v-for="r in rows" :key="r.t.id">
          <!-- A nested-flow box holds no RACI of its own: its roles live in the flow it references. -->
          <tr v-if="r.sub" class="bz-trow-sub">
            <th class="bz-trow" :title="r.label">⧉ {{ r.label }}</th>
            <td class="bz-tsub" :colspan="COLS.length"><template v-if="r.ref">roles live in <button type="button" class="bz-tsub-link"
              :data-gal-open="r.ref.id">{{ r.ref.name || 'Untitled' }}</button></template><template v-else>nested flow is missing</template></td>
          </tr>
          <tr v-else>
            <th class="bz-trow" :title="r.t.name">{{ r.t.name || 'Untitled task' }}<span v-if="r.link" class="bz-trow-bind" :class="{ 'is-unset': r.link.unset }"
              :title="r.link.title">{{ r.link.text }}</span></th>
            <td v-for="k in COLS" :key="k" class="bz-tcell" :class="{ 'is-linked': r.eff![k].from === 'chart' }" :data-bz-cell="r.t.id" :data-col="k">
              <FlowCellChips :flow="flow" :step="r.t" :col="k" :eff="r.eff!" />
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length"><td class="bz-tempty" :colspan="COLS.length + 1">No tasks yet.</td></tr>
      </tbody>
    </table>
    <template v-if="rows.length">
      <div class="bz-table-head bz-flow-h"><h3>Flow / branches</h3><span class="bz-meta">⑂ = decision · edit a condition · rows in flow order</span></div>
      <table class="bz-table bz-flow-table">
        <thead><tr><th class="bz-th-task">Step</th><th>Path / condition</th><th>Hands off</th><th>Next step</th></tr></thead>
        <tbody>
          <template v-for="p in paths" :key="p.key">
            <tr>
              <th v-if="p.first" class="bz-flow-step" :class="{ 'is-decision': p.decision }" :rowspan="p.span" :title="p.label">{{ p.sub ? '⧉ ' : '' }}{{ p.label }}<span
                v-if="p.decision" class="bz-flow-fork" :title="`Decision point — ${p.span} paths`">⑂ decision</span></th>
              <template v-if="!p.edge">
                <td class="bz-flow-cond-cell"><span class="bz-flow-end">— end —</span></td><td class="bz-flow-hand">—</td><td class="bz-flow-next">—</td>
              </template>
              <template v-else>
                <td class="bz-flow-cond-cell"><input class="bz-flow-cond" :data-bz-edge-cond="p.edge.id" :value="p.edge.label" :placeholder="p.decision ? 'condition…' : '(then)'"
                  spellcheck="false" :readonly="!canEdit"></td>
                <td class="bz-flow-hand"><template v-if="p.edge.artifactIds.length"><template v-for="(aid, i) in p.edge.artifactIds" :key="i"><template
                  v-if="i">{{ ' ' }}</template><span class="bz-flow-art">{{ artName(aid) }}</span></template></template><span v-else class="bz-flow-art-none"
                  title="No deliverable named — click the edge on the canvas to add one">—</span></td>
                <td class="bz-flow-next">{{ p.next }}</td>
              </template>
            </tr>
          </template>
        </tbody>
      </table>
    </template>
  </aside>
</template>

<script setup lang="ts">
/**
 * The table pane — index.html's bizTableHtml (one row per step, a cell per column, clicking a cell
 * opens the same popover a card's cell does) and bizFlowTableHtml (one row per outgoing path, in
 * bizTopoOrder, with each handoff's condition editable in place).
 */
import { COLS, subflowRefId, type Flow, type FlowEdge, type FlowStep } from '@raci/core';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const screen = chrome.screen;

const rows = computed(() => {
  const b = props.flow;
  if (!b) return [];
  const linked = chrome.isLinked(b);
  return chrome.steps(b).map((t) => {
    if (chrome.isSub(t)) {
      const refId = subflowRefId(b, t);
      return { t, sub: true, label: chrome.taskLabel(b, t), ref: refId ? chrome.ws.value.flows[refId] ?? null : null, eff: null, link: null };
    }
    const bind = linked ? chrome.bindInfo(t) : null;
    // In Chart-Linked mode the row a step follows is the most important thing about it, so the
    // table names it under the step.
    const link = !linked ? null : bind
      ? { unset: false, title: bind.crumb.join(' › '), text: `⛓ ${bind.tierLabel} · ${bind.node.name || '(untitled row)'}` }
      : { unset: true, title: undefined, text: `⛓ ${t.bind ? 'linked row is missing' : 'not linked to a chart row'}` };
    return { t, sub: false, label: '', ref: null, eff: chrome.lint.value.stepRaci(b, t), link };
  });
});

/**
 * bizTopoOrder: Kahn's order over the handoffs so the table reads start → finish. Ties keep the
 * steps' order; steps on a cycle (no topological place) follow at the end, in order.
 */
function topoOrder(b: Flow): FlowStep[] {
  const steps = chrome.steps(b);
  const edges = chrome.edges(b);
  const inDeg = new Map(steps.map((t) => [t.id, 0]));
  for (const e of edges) if (e.from !== e.to && inDeg.has(e.to) && inDeg.has(e.from)) inDeg.set(e.to, inDeg.get(e.to)! + 1);
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = steps.filter((t) => !inDeg.get(t.id)).map((t) => t.id);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const d = (inDeg.get(e.to) ?? 0) - 1;
      inDeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  for (const t of steps) if (!seen.has(t.id)) order.push(t.id);
  return order.map((id) => b.steps[id]!).filter(Boolean);
}
/** bizFlowTableHtml's rows: one per outgoing path; a step with 2+ is a decision point. */
const paths = computed(() => {
  const b = props.flow;
  if (!b) return [];
  const out: Array<{ key: string; first: boolean; span: number; decision: boolean; label: string; sub: boolean; edge: FlowEdge | null; next: string }> = [];
  for (const t of topoOrder(b)) {
    const outs = chrome.edges(b).filter((e) => e.from === t.id);
    const decision = outs.length >= 2;
    const label = chrome.taskLabel(b, t);
    const sub = chrome.isSub(t);
    if (!outs.length) { out.push({ key: t.id, first: true, span: 1, decision, label, sub, edge: null, next: '' }); continue; }
    outs.forEach((e, i) => out.push({
      key: `${t.id}:${e.id}`, first: i === 0, span: outs.length, decision, label, sub, edge: e,
      next: chrome.taskLabel(b, b.steps[e.to] ?? null),
    }));
  }
  return out;
});
/** artifactLabel. */
const artName = (id: string) => {
  const a = chrome.ws.value.artifacts[id];
  return a ? a.name || 'Untitled deliverable' : '(missing deliverable)';
};

function onClick(e: MouseEvent): void {
  const t = e.target as Element;
  const open = t.closest<HTMLElement>('[data-gal-open]');
  if (open) { screen.switchFlow(open.dataset.galOpen!); return; }
  const cell = t.closest<HTMLElement>('[data-bz-cell]');
  if (cell) screen.popover.value = { kind: 'raci', taskId: cell.dataset.bzCell!, col: cell.dataset.col!, anchor: cell.getBoundingClientRect() };
}
/** A condition commits on change, as index.html's change listener has it — and the repaint that
 *  follows there drops the focus, so it is dropped here too. */
function onChange(e: Event): void {
  const input = (e.target as Element).closest?.<HTMLInputElement>('.bz-flow-cond');
  const b = props.flow;
  if (!input || !b || !props.canEdit) return;
  const edge = b.edges[input.dataset.bzEdgeCond ?? ''];
  if (!edge) return;
  const label = input.value.trim();
  input.value = label;
  chrome.setEdgeLabel(b, edge.id, label);
  // index.html repaints the whole screen here, so nothing in it keeps the focus — not this field,
  // and not the one a Tab or a click was moving it to.
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.closest('#ws-main')) a.blur();
  });
}
</script>
