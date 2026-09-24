<template>
  <!-- index.html's renderChart. Handlers are delegated on the source's data-* attributes, in the
       source's order, from this root — as the source delegates them from document. -->
  <div class="ws-page" @click="onClick" @dblclick="onDblClick" @mousedown="onMouseDown" @contextmenu="onContext" @focusout="onBlur">
    <template v-if="chart">
      <div class="art-status-strip" :class="`is-${status}`" data-art-kind="chart">
        <span class="ast-badge">{{ status === 'final' ? '✓' : '✎' }} {{ status === 'final' ? 'FINAL' : 'DRAFT' }}</span>
        <span class="ast-txt">{{ status === 'final' ? 'Signed off, and locked against edits.' : 'Working copy — still being written, and free to change.' }}<template
          v-if="signedOn"> <span class="ast-when">Signed {{ signedOn }}.</span></template></span>
        <button type="button" class="ast-set" data-status-set="chart" :data-status-id="chart.id" :data-status="status === 'final' ? 'draft' : 'final'"
          :title="status === 'final'
            ? `Reopen “${chart.title || 'Untitled chart'}” for editing. Nothing is lost — the status is just a field, and you can mark it Final again whenever you like.`
            : `Mark “${chart.title || 'Untitled chart'}” Final. It keeps working everywhere; its cells, names and layout simply lock against accidental edits until you reopen it.`">
          {{ status === 'final' ? '↺ Reopen as draft' : '✓ Mark final' }}</button>
      </div>
      <div id="cascade-zoom" ref="zoomWrap" class="cascade-zoom">
        <div id="cascade" ref="cascadeEl" class="cascade" :class="{ arranging }">
          <ChartBlock v-for="(pane, i) in panes" :key="pane.tier" :chart="chart" :pane="pane" :idx="i" :total="panes.length"
            :cols="cols" :size="cam.size" :records="records" :flows="flowsByNode" :health="health"
            :active-node-id="activeNodeId" :can-edit="canEdit" :class="{ moved: !!cam.pos[pane.tier] }" />
          <svg id="cascade-svg" ref="svg" class="cascade-svg" aria-hidden="true" />
          <div id="chart-resize" ref="grip" class="chart-resize" title="Drag to resize the charts" />
        </div>
      </div>
      <div id="zoom-ctl" class="zoom-ctl">
        <button id="zoom-out" title="Zoom out" @click.stop="zoomBy(-0.1)">−</button>
        <span id="zoom-level" class="zoom-level" title="Reset zoom" @click.stop="setZoom(1)">{{ Math.round(cam.zoom * 100) }}%</span>
        <button id="zoom-in" title="Zoom in" @click.stop="zoomBy(0.1)">+</button>
      </div>
      <ChartPopover :pop="pop" :chart="chart" :cols="cols" :can-edit="canEdit" @close="pop = null"
        @jump="(id) => { pop = null; jumpToRow(id); }" @colview="pivotToCol" @open-flow="openFlow"
        @create-flow="createFlowFromNode" @attach-flow="attachFlow" />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The chart cascade — index.html's renderChart and everything the chart view wires: the stacked
 * panes (layoutCascade), the connectors between them (drawConnectors), dragging a pane out of the
 * stack and double-clicking it home, the resize grip, zoom, the drill, inline renames, the cell,
 * org, node-view and flow popovers, and the right-click menus.
 *
 * Where you are in a chart — the drill path, pane positions, zoom, size — is YOUR camera, not the
 * document's: see useChartCamera. The chart itself is shared and every edit is a CRDT mutation.
 */
import {
  MAX_TIER,
  ancestorsOf,
  chartColumns,
  depthOf,
  flowHealth,
  keyBetween,
  pathToOpen,
  resolveCascade,
  tierLabel,
  type Chart,
  type ChartNode,
} from '@raci/core';
import {
  LOCAL_ORIGIN,
  addNode,
  addStep,
  deleteNode as deleteNodeTree,
  duplicateNode,
  insertChart,
  maps,
  renameNode,
  setChartField,
  setField,
  toYMap,
} from '@raci/crdt';
import type { ChartPop } from '~/components/chart/ChartPopover.vue';
import type { CtxEntry } from '~/composables/useContextMenu';
import { violationRecords, type ViolationRecord } from '~/composables/useViolationRecords';

const session = useWorkspaceSession();
const shell = useShell();
const menu = useContextMenu();
const docs = useDocuments();
const { guardEdit, refuseLockedEdit } = useLock();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));
const attachDocuments = inject<(nodeId: string) => void>('raci:attachDocuments', () => {});
const { activeNodeId, panesMoved, arrangeTick, openDetails, selectNode } = useChartView();
const activeChartId = useActiveChartId();
const activeFlowId = useActiveFlowId();

const chart = computed<Chart | null>(() => {
  const charts = session.workspace.value.charts;
  return (activeChartId.value ? charts[activeChartId.value] : null) ?? Object.values(charts)[0] ?? null;
});
const chartIdRef = computed(() => chart.value?.id ?? null);
const cols = computed(() => (chart.value ? chartColumns(chart.value) : []));
const status = computed(() => chart.value?.status ?? 'draft');
const signedOn = computed(() => {
  const at = chart.value?.finalizedAt;
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
});
const locked = computed(() => status.value === 'final');
const edit = () => canEdit.value && guardEdit('chart', chart.value);

// ---- the camera --------------------------------------------------------------------------------
const { cam, update, setZoom } = useChartCamera(session.workspaceId, chartIdRef);
const zoomBy = (d: number) => setZoom(cam.value.zoom + d);
const cascade = computed(() => (chart.value ? resolveCascade(chart.value, cam.value.drillPath) : null));
const panes = computed(() => cascade.value?.panes ?? []);
// A row someone else deleted leaves a path pointing at nothing: follow what could be honoured.
watch(cascade, (c) => { if (c?.trimmed) update({ drillPath: [...c.path] }); });
watch(() => cam.value.pos, (pos) => { panesMoved.value = Object.keys(pos).length > 0; }, { immediate: true });

// ---- what the panes show -------------------------------------------------------------------------
const records = computed(() => {
  const map = new Map<string, ViolationRecord>();
  for (const r of violationRecords(session.workspace.value, 'chart', chart.value?.id ?? null, null)) {
    if (r.kind === 'chart') map.set(r.id, r);
  }
  return map;
});
const flowsByNode = computed(() => {
  const map = new Map<string, Array<{ id: string; name: string }>>();
  for (const f of Object.values(session.workspace.value.flows)) {
    if (!f.anchor || f.anchor.chartId !== chart.value?.id) continue;
    const list = map.get(f.anchor.nodeId) ?? [];
    list.push({ id: f.id, name: f.name });
    map.set(f.anchor.nodeId, list);
  }
  return map;
});
/** index.html's flowHealth roll-up over every flow anchored to the row. */
function health(nodeId: string): { pct: number; cls: string } | null {
  const flows = flowsByNode.value.get(nodeId);
  if (!flows?.length) return null;
  let passed = 0, total = 0;
  for (const f of flows) {
    const h = flowHealth(session.workspace.value, f.id);
    if (h) { passed += h.passed; total += h.total; }
  }
  const pct = total ? Math.round((passed / total) * 100) : 100;
  return { pct, cls: pct >= 80 ? 'green' : pct >= 40 ? 'amber' : 'red' };
}

// ---- layout: index.html's layoutCascade + drawConnectors -------------------------------------
const CASCADE_DX = 48, CASCADE_DY = 38, CASCADE_BASE_X = 44, CASCADE_BASE_Y = 30;
const ACCENT = '#51cf66';
const zoomWrap = ref<HTMLElement | null>(null);
const cascadeEl = ref<HTMLElement | null>(null);
const svg = ref<SVGSVGElement | null>(null);
const grip = ref<HTMLElement | null>(null);
const arranging = ref(false);

function layoutCascade(): void {
  const wrap = cascadeEl.value;
  if (!wrap) return;
  const blocks = Array.from(wrap.querySelectorAll<HTMLElement>('.chart-block'));
  if (!blocks.length) return;
  // index.html rebuilds #cascade on every render, so it always measures against the cascade's
  // NATURAL width. This element persists between renders, so the sizes the last layout wrote have
  // to go first — otherwise every layout measures against the previous one and the cascade creeps
  // wider, and the extra width leaks into the party columns (a pane's max-width is a percentage of
  // the cascade).
  wrap.style.width = '';
  wrap.style.height = '';
  wrap.style.transform = '';
  if (zoomWrap.value) { zoomWrap.value.style.width = ''; zoomWrap.value.style.height = ''; }
  const n = blocks.length;
  const pos = cam.value.pos;
  const focused = blocks[n - 1]!;
  focused.style.maxHeight = '';
  const H = focused.offsetHeight;
  const focusBottom = CASCADE_BASE_Y + (n - 1) * CASCADE_DY + H;
  blocks.forEach((b, i) => {
    const moved = pos[b.dataset.tier ?? ''];
    b.style.top = `${moved ? moved.y : CASCADE_BASE_Y + i * CASCADE_DY}px`;
    b.style.left = `${moved ? moved.x : CASCADE_BASE_X + i * CASCADE_DX}px`;
    // Background layers are clipped to their peeking strip while nested; a pane pulled out of the
    // stack shows in full so it can be read.
    b.style.maxHeight = i < n - 1 && !moved
      ? `${Math.max(CASCADE_DY + 8, focusBottom - (CASCADE_BASE_Y + i * CASCADE_DY))}px` : '';
  });
  let maxRight = 0, maxBottom = 0;
  for (const b of blocks) {
    maxRight = Math.max(maxRight, b.offsetLeft + b.offsetWidth);
    maxBottom = Math.max(maxBottom, b.offsetTop + b.offsetHeight);
  }
  const logicalW = maxRight + CASCADE_BASE_X;
  const logicalH = Math.max(focusBottom, maxBottom) + 60;
  const z = cam.value.zoom || 1;
  wrap.style.width = `${logicalW}px`;
  wrap.style.height = `${logicalH}px`;
  wrap.style.transformOrigin = 'top left';
  wrap.style.transform = z === 1 ? '' : `scale(${z})`;
  if (zoomWrap.value) { zoomWrap.value.style.width = `${logicalW * z}px`; zoomWrap.value.style.height = `${logicalH * z}px`; }
  // The grip floats just outside the focused pane's corner when a scrollbar is present, so the
  // tracks stay unobstructed; otherwise it tucks into the inside corner.
  const g = grip.value;
  if (g) {
    const sbV = Math.max(0, focused.offsetWidth - focused.clientWidth);
    const sbH = Math.max(0, focused.offsetHeight - focused.clientHeight);
    if (sbV > 2 || sbH > 2) {
      g.style.left = `${focused.offsetLeft + focused.offsetWidth + 4}px`;
      g.style.top = `${focused.offsetTop + focused.offsetHeight + 4}px`;
      g.classList.add('floated');
    } else {
      g.style.left = `${focused.offsetLeft + focused.offsetWidth - 20}px`;
      g.style.top = `${focused.offsetTop + focused.offsetHeight - 20}px`;
      g.classList.remove('floated');
    }
  }
}
function drawConnectors(): void {
  const s = svg.value, wrap = cascadeEl.value;
  if (!s || !wrap) return;
  const w = wrap.scrollWidth, h = wrap.scrollHeight;
  s.setAttribute('width', String(w)); s.setAttribute('height', String(h));
  s.style.width = `${w}px`; s.style.height = `${h}px`;
  const blocks = Array.from(wrap.querySelectorAll<HTMLElement>('.chart-block'));
  let out = `<defs><marker id="cc-arrow" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L6,3 L0,6 Z" fill="${ACCENT}"/></marker></defs>`;
  const dot = (x: number, y: number, r: number) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${ACCENT}" stroke="#0d0e12" stroke-width="1.5"/>`;
  let dots = '';
  for (let i = 0; i < blocks.length - 1; i++) {
    const head = blocks[i]!.querySelector<HTMLElement>('.chart-head');
    const childHead = blocks[i + 1]!.querySelector<HTMLElement>('.chart-head');
    if (!head || !childHead) continue;
    const x1 = blocks[i]!.offsetLeft + head.offsetLeft + 18;
    const y1 = blocks[i]!.offsetTop + head.offsetTop + head.offsetHeight;
    const x2 = blocks[i + 1]!.offsetLeft + childHead.offsetLeft - 7;
    const y2 = blocks[i + 1]!.offsetTop + childHead.offsetTop + childHead.offsetHeight / 2;
    const toFocus = i === blocks.length - 2;
    out += `<path${toFocus ? ' class="cc-pulse"' : ''} d="M ${x1} ${y1} V ${y2} H ${x2}" fill="none" stroke="${ACCENT}" stroke-width="${toFocus ? 2.5 : 2}" stroke-dasharray="5 3" marker-end="url(#cc-arrow)" opacity="0.95"/>`;
    dots += dot(x1, y1, 5) + dot(x2, y2, toFocus ? 6 : 5);
  }
  s.innerHTML = out + dots;
}
function relayout(): void { layoutCascade(); drawConnectors(); }
watch([() => session.workspace.value, cam, panes], () => nextTick(relayout), { flush: 'post', deep: false });
onMounted(() => { nextTick(relayout); window.addEventListener('resize', relayout); });
onBeforeUnmount(() => window.removeEventListener('resize', relayout));

// ---- auto arrange (index.html autoArrange): drop every manual offset and glide home ------------
function autoArrange(): void {
  const had = Object.keys(cam.value.pos).length > 0;
  update({ pos: {} });
  if (!had) { nextTick(relayout); return; }
  arranging.value = true;
  nextTick(() => {
    layoutCascade();
    let start: number | null = null;
    const frame = (ts: number) => {
      if (start === null) start = ts;
      drawConnectors();
      if (ts - start < 480) requestAnimationFrame(frame);
      else { arranging.value = false; drawConnectors(); }
    };
    requestAnimationFrame(frame);
  });
}
watch(arrangeTick, autoArrange);

// ---- the crumb band ----------------------------------------------------------------------------
const band = useCrumbChannel();
watchEffect(() => {
  if (!band) return;
  const c = chart.value;
  if (!c) { band.crumbs.value = []; return; }
  const free = !!c.custom;
  band.crumbs.value = panes.value.map((p, i) => ({
    id: i === 0 ? '\u0000root' : p.parent!.id,
    tier: i,
    tierName: i === 0 ? (free ? tierLabel(c, 0) : 'Portfolios') : tierLabel(c, i - 1),
    name: i === 0 ? (free ? 'All activities' : 'All Portfolios') : (p.parent!.name || `Untitled ${tierLabel(c, i - 1)}`),
  }));
});
if (band) {
  band.crumbNav.value = (i: number) => focusChartTier(i);
  onBeforeUnmount(() => { band.crumbs.value = []; band.crumbNav.value = () => {}; });
}

// ---- drill -------------------------------------------------------------------------------------
function drillToggle(id: string, tier: number): void {
  if (tier >= MAX_TIER && !chart.value?.custom) return;
  const path = cam.value.drillPath;
  const next = path[tier] === id
    ? (path.length > tier + 1 ? path.slice(0, tier + 1) : path.slice(0, tier))
    : [...path.slice(0, tier), id];
  update({ drillPath: next });
}
function focusChartTier(t: number): void {
  if (cam.value.drillPath.length <= t) return;
  update({ drillPath: cam.value.drillPath.slice(0, t) });
}
/** index.html's jumpToViolation: drill so the row is in the focused pane, scroll to it, flash it. */
function jumpToRow(nodeId: string): void {
  const c = chart.value;
  if (!c?.nodes[nodeId]) return;
  const maxT = c.custom ? Infinity : MAX_TIER;
  update({ drillPath: pathToOpen(c, nodeId).slice(0, maxT) });
  nextTick(() => requestAnimationFrame(() => {
    const tr = document.querySelector<HTMLElement>(`tr.chart-row[data-id="${nodeId}"]`);
    if (!tr) return;
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tr.classList.remove('violation-flash');
    void tr.offsetWidth;
    tr.classList.add('violation-flash');
    setTimeout(() => tr.classList.remove('violation-flash'), 3500);
  }));
}
const jumpRequest = useState<{ kind: 'chart' | 'flow'; id: string; at: number } | null>('raci:jump', () => null);
watch(jumpRequest, (j) => { if (j?.kind === 'chart') { jumpToRow(j.id); jumpRequest.value = null; } }, { immediate: true });

// ---- edits ---------------------------------------------------------------------------------------
function countBelow(id: string): number {
  const c = chart.value!;
  let n = 0;
  const walk = (pid: string) => { for (const x of Object.values(c.nodes)) if (x.parentId === pid) { n++; walk(x.id); } };
  walk(id);
  return n;
}
function focusNodeName(id: string): void {
  nextTick(() => requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.ch-name-edit[data-node-id="${id}"]`);
    if (!el) return;
    el.focus();
    document.getSelection()?.selectAllChildren(el);
  }));
}
function addRoot(): void { if (edit()) addNode(session.doc, { chartId: chart.value!.id, parentId: null, name: '' }); }
function addChild(parentId: string): void {
  const c = chart.value!;
  if (!edit() || (!c.custom && depthOf(c.nodes, parentId) >= MAX_TIER)) return;
  addNode(session.doc, { chartId: c.id, parentId, name: '' });
}
function addSibling(id: string): void {
  const c = chart.value!;
  if (!edit()) return;
  const fresh = addNode(session.doc, { chartId: c.id, parentId: c.nodes[id]?.parentId ?? null, afterId: id, name: '' });
  focusNodeName(fresh);
}
function deleteRow(id: string): void {
  const c = chart.value!;
  const n = c.nodes[id];
  if (!n || !edit()) return;
  const kids = countBelow(id);
  const label = n.name || `this ${tierLabel(c, depthOf(c.nodes, id)).toLowerCase()}`;
  if (!confirm(`Delete "${label}"${kids ? ` and its ${kids} sub-item${kids === 1 ? '' : 's'}` : ''}?`)) return;
  const at = cam.value.drillPath.indexOf(id);
  if (at >= 0) update({ drillPath: cam.value.drillPath.slice(0, at) });
  deleteNodeTree(session.doc, c.id, id);
  if (activeNodeId.value === id) selectNode(null);
}
function setChartStatus(next: 'draft' | 'final'): void {
  const c = chart.value;
  if (!c || !canEdit.value || c.status === next) return;
  session.doc.transact(() => {
    setChartField(session.doc, c.id, 'status', next);
    setChartField(session.doc, c.id, 'finalizedAt', next === 'final' ? new Date().toISOString() : null);
  }, LOCAL_ORIGIN);
  shell.toast(next === 'final'
    ? `“${c.title || 'Untitled chart'}” is Final — locked against edits.`
    : `“${c.title || 'Untitled chart'}” reopened as a Draft.`, 'suggest');
}

// free-form chart columns and level names
function setCustom(next: NonNullable<Chart['custom']>): void { setChartField(session.doc, chart.value!.id, 'custom', next); }
function addChartCol(): void {
  const c = chart.value!;
  if (!c.custom || !edit()) return;
  const key = `p_${Math.random().toString(36).slice(2, 10)}`;
  setCustom({ ...c.custom, cols: [...c.custom.cols, { key, label: 'New party', short: '' }] });
  nextTick(() => requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.chart-block.focus .col-edit[data-col-edit="${key}"]`);
    if (el) { el.focus(); document.getSelection()?.selectAllChildren(el); }
  }));
}
function deleteChartCol(key: string): void {
  const c = chart.value!;
  if (!c.custom || c.custom.cols.length <= 1 || !edit()) return;
  const col = c.custom.cols.find((x) => x.key === key);
  if (!col || !confirm(`Remove the "${col.label}" column? Its role letters on every row of this chart are discarded.`)) return;
  session.doc.transact(() => {
    setCustom({ ...c.custom!, cols: c.custom!.cols.filter((x) => x.key !== key) });
    const m = maps(session.doc);
    for (const n of Object.values(c.nodes)) {
      if (key in n.raci) { const raci = { ...n.raci }; delete raci[key]; setField(m.nodes, n.id, 'raci', raci); }
      if (n.primaryR === key) setField(m.nodes, n.id, 'primaryR', null);
    }
  }, LOCAL_ORIGIN);
}

// ---- clipboard (copy / paste a subtree) -------------------------------------------------------
let nodeClip: { nodes: ChartNode[]; rootId: string; title: string } | null = null;
function copyNodeTree(id: string): void {
  const c = chart.value!;
  const root = c.nodes[id];
  if (!root) return;
  const out: ChartNode[] = [];
  const walk = (nid: string) => { const n = c.nodes[nid]; if (!n) return; out.push(structuredClone(toRaw(n))); for (const x of Object.values(c.nodes)) if (x.parentId === nid) walk(x.id); };
  walk(id);
  nodeClip = { nodes: out, rootId: id, title: root.name || 'Untitled' };
  shell.toast(`Copied "${nodeClip.title}"${out.length > 1 ? ' and everything under it' : ''}.`, 'suggest');
}
function copyName(base: string, taken: string[]): string {
  const want = /^Copy of /.test(base) ? base : `Copy of ${base || 'Untitled'}`;
  if (!taken.includes(want)) return want;
  for (let i = 2; ; i++) if (!taken.includes(`${want} (${i})`)) return `${want} (${i})`;
}
function pasteNodeInto(parentId: string | null): void {
  const c = chart.value!;
  if (!edit()) return;
  if (!nodeClip) { shell.toast('Nothing to paste — copy a row first.', 'suggest'); return; }
  const clip = nodeClip;
  const height = (() => { let d = 0; const byParent = (p: string, k: number) => { d = Math.max(d, k); for (const n of clip.nodes) if (n.parentId === p) byParent(n.id, k + 1); }; byParent(clip.rootId, 0); return d; })();
  if (parentId && !c.custom && depthOf(c.nodes, parentId) + 1 + height > MAX_TIER) {
    shell.toast(`"${clip.title}" is too deep to sit under this row — an org chart stops at ${tierLabel(c, MAX_TIER)}.`, 'error');
    return;
  }
  const siblings = Object.values(c.nodes).filter((n) => n.parentId === parentId).sort((a, b) => (a.order < b.order ? -1 : 1));
  const idMap = new Map<string, string>(clip.nodes.map((n) => [n.id, `node_${Math.random().toString(36).slice(2, 12)}`]));
  const rootName = copyName(clip.nodes[0]!.name, siblings.map((s) => s.name));
  session.doc.transact(() => {
    const m = maps(session.doc);
    for (const n of clip.nodes) {
      const isRoot = n.id === clip.rootId;
      m.nodes.set(idMap.get(n.id)!, toYMap({
        ...n,
        id: idMap.get(n.id)!,
        chartId: c.id,
        parentId: isRoot ? parentId : idMap.get(n.parentId ?? '') ?? parentId,
        order: isRoot ? keyBetween(siblings.at(-1)?.order ?? null, null) : n.order,
        name: isRoot ? rootName : n.name,
      }));
    }
  }, LOCAL_ORIGIN);
  shell.toast(`Pasted "${rootName}".`, 'suggest');
}

// ---- flows from a Task row ---------------------------------------------------------------------
async function openFlow(flowId: string): Promise<void> {
  pop.value = null;
  activeFlowId.value = flowId;
  await navigateTo(`/w/${session.workspaceId}/flow`);
}
/** index.html's createFlowFromNode: Chart-Linked on an org chart, first step bound to the row. */
async function createFlowFromNode(nodeId: string): Promise<void> {
  pop.value = null;
  const c = chart.value!;
  const n = c.nodes[nodeId];
  if (!n || !canEdit.value) return;
  const flowId = `flow_${Math.random().toString(36).slice(2, 12)}`;
  const flows = maps(session.doc).flows;
  session.doc.transact(() => {
    flows.set(flowId, toYMap({
      id: flowId, name: `${n.name || 'Untitled task'} — flow`,
      meta: { description: '', customer: '', priority: '', budget: '', tags: [] },
      framework: 'raci', mode: c.custom ? 'free' : 'linked', sourceChartId: c.custom ? null : c.id,
      status: 'draft', finalizedAt: null, anchor: { chartId: c.id, nodeId },
    }));
    addStep(session.doc, flowId, c.custom
      ? { name: n.name || '', x: 60, y: 80, raci: Object.fromEntries(cols.value.map((k) => [k, n.raci[k] ?? ''])) }
      : { name: n.name || '', x: 60, y: 80, bind: { chartId: c.id, nodeId } });
  }, LOCAL_ORIGIN);
  shell.toast(c.custom
    ? 'Flow created (Free-Form) — first step seeded from the task\'s RACI.'
    : 'Flow created (Chart-Linked) — its first step is linked to this row and follows its RACI. Add steps and link each to the row it implements.');
  await openFlow(flowId);
}
async function attachFlow(flowId: string, nodeId: string): Promise<void> {
  pop.value = null;
  const f = session.workspace.value.flows[flowId];
  const n = chart.value?.nodes[nodeId];
  if (!f || !n || !canEdit.value) return;
  session.doc.transact(() => setField(maps(session.doc).flows, flowId, 'anchor', { chartId: chart.value!.id, nodeId }), LOCAL_ORIGIN);
  shell.toast(`"${f.name || 'Untitled'}" attached to "${n.name || 'this task'}".`);
  await openFlow(flowId);
}
// The Details rail's "⤵ Create / attach flow" asks for this row's flow popover.
const flowRequest = useState<string | null>('raci:flowPopoverFor', () => null);
watch(flowRequest, (id) => {
  if (!id) return;
  flowRequest.value = null;
  nextTick(() => {
    const el = document.querySelector<HTMLElement>(`.chart-row [data-flow-btn="${id}"]`) ?? document.querySelector<HTMLElement>(`[data-flow-btn="${id}"]`);
    if (el) pop.value = { kind: 'flow', id, anchor: el.getBoundingClientRect() };
  });
});

// ---- popovers ----------------------------------------------------------------------------------
const pop = ref<ChartPop | null>(null);
function pivotToCol(col: string): void {
  const th = document.querySelector<HTMLElement>(`.chart-block.focus .col-view[data-col-view="${col}"]`);
  pop.value = { kind: 'colview', col, anchor: (th ?? document.body).getBoundingClientRect() };
}
function onDocDown(e: MouseEvent): void {
  if (!pop.value) return;
  const t = e.target as Element | null;
  if (t?.closest?.('.raci-popover, .org-popover')) return;
  // A click that will open another popover replaces this one in onClick.
  if (t?.closest?.('.chart-cell, [data-org-edit], [data-col-view], [data-row-view], [data-flow-btn]')) return;
  pop.value = null;
}
function onEsc(e: KeyboardEvent): void { if (e.key === 'Escape' && pop.value) pop.value = null; }
onMounted(() => { document.addEventListener('mousedown', onDocDown, true); document.addEventListener('keydown', onEsc); });
onBeforeUnmount(() => { document.removeEventListener('mousedown', onDocDown, true); document.removeEventListener('keydown', onEsc); });

// ---- the delegated handlers, in index.html's order ---------------------------------------------
let dragSuppressClick = false;
function onClick(e: MouseEvent): void {
  const t = e.target as Element;
  if (dragSuppressClick) { dragSuppressClick = false; if (t.closest('.chart-head')) return; }
  const status = t.closest<HTMLElement>('[data-status-set]');
  if (status) { setChartStatus(status.dataset.status as 'draft' | 'final'); return; }
  const docOpen = t.closest<HTMLElement>('[data-doc-open]');
  if (docOpen) { e.preventDefault(); e.stopPropagation(); const [, docId] = (docOpen.dataset.docOpen ?? '').split('|'); if (docId) docs.open(docId); return; }
  const attach = t.closest<HTMLElement>('[data-attach-direct]');
  if (attach) {
    e.preventDefault(); e.stopPropagation();
    if (!edit()) return;
    selectNode(attach.dataset.attachDirect!);
    attachDocuments(attach.dataset.attachDirect!);
    return;
  }
  const opener = t.closest<HTMLElement>('[data-open-details]');
  if (opener) { e.preventDefault(); e.stopPropagation(); openDetails(); selectNode(opener.dataset.openDetails!); return; }
  const nameEdit = t.closest<HTMLElement>('.ch-name-edit');
  if (nameEdit) { const id = nameEdit.dataset.nodeId; if (id && id !== activeNodeId.value) { openDetails(); selectNode(id); } return; }
  const flowBtn = t.closest<HTMLElement>('[data-flow-btn]');
  if (flowBtn) { pop.value = { kind: 'flow', id: flowBtn.dataset.flowBtn!, anchor: flowBtn.getBoundingClientRect() }; return; }
  // Click anywhere on a background layer: collapse the layers in front of it.
  const bg = t.closest<HTMLElement>('.chart-block.faded');
  if (bg) { focusChartTier(parseInt(bg.dataset.tier ?? '0', 10) || 0); return; }
  if (t.closest('[data-add-root]')) { addRoot(); return; }
  const addChildBtn = t.closest<HTMLElement>('[data-add-child]');
  if (addChildBtn) { addChild(addChildBtn.dataset.addChild!); return; }
  const del = t.closest<HTMLElement>('[data-del-node]');
  if (del) { deleteRow(del.dataset.delNode!); return; }
  const drill = t.closest<HTMLElement>('[data-drill]');
  if (drill) { drillToggle(drill.dataset.drill!, parseInt(drill.dataset.tier ?? '0', 10) || 0); return; }
  const colDel = t.closest<HTMLElement>('[data-col-del]');
  if (colDel) { deleteChartCol(colDel.dataset.colDel!); return; }
  if (t.closest('[data-col-add]')) { addChartCol(); return; }
  const colView = t.closest<HTMLElement>('[data-col-view]');
  if (colView) { pop.value = { kind: 'colview', col: colView.dataset.colView!, anchor: colView.getBoundingClientRect() }; return; }
  const rowView = t.closest<HTMLElement>('[data-row-view]');
  if (rowView) { pop.value = { kind: 'taskview', id: rowView.dataset.rowView!, anchor: rowView.getBoundingClientRect() }; return; }
  const pin = t.closest<HTMLElement>('[data-violation-jump]');
  if (pin) { jumpToRow(pin.dataset.violationJump!); return; }
  const orgEdit = t.closest<HTMLElement>('[data-org-edit]');
  if (orgEdit) {
    pop.value = { kind: 'org', id: orgEdit.dataset.orgEdit!, orgKind: orgEdit.dataset.orgKind as 'division' | 'branch', anchor: orgEdit.getBoundingClientRect() };
    return;
  }
  const cell = t.closest<HTMLElement>('.chart-cell');
  if (cell) { pop.value = { kind: 'raci', id: cell.dataset.id!, col: cell.dataset.col!, anchor: cell.getBoundingClientRect() }; }
}

/** Inline renames commit on blur, as index.html's blur listener: row names, party names, levels. */
function onBlur(e: FocusEvent): void {
  const el = e.target as HTMLElement;
  if (!el.matches?.('[contenteditable="true"]')) return;
  const c = chart.value;
  if (!c) return;
  const text = (el.textContent ?? '').trim();
  if (el.dataset.nodeId && el.dataset.field === 'name') {
    const n = c.nodes[el.dataset.nodeId];
    if (!n || n.name === text) return;
    if (!edit()) { el.textContent = n.name; return; }
    renameNode(session.doc, n.id, text);
    return;
  }
  if (el.dataset.colEdit && c.custom) {
    const col = c.custom.cols.find((x) => x.key === el.dataset.colEdit);
    if (col && text && text !== col.label && edit()) setCustom({ ...c.custom, cols: c.custom.cols.map((x) => (x.key === col.key ? { ...x, label: text } : x)) });
    else el.textContent = col?.label ?? '';
    return;
  }
  if (el.classList.contains('tier-edit') && c.custom) {
    const tier = parseInt(el.dataset.tierEdit ?? '0', 10) || 0;
    if (!edit()) return;
    const tiers = [...c.custom.tiers];
    while (tiers.length <= tier) tiers.push('');
    tiers[tier] = text; // '' falls back to the auto "Level N" name
    setCustom({ ...c.custom, tiers });
  }
}

// ---- drag a pane out of the cascade, snap it back, resize, wheel-zoom ----------------------------
let chartDrag: { block: HTMLElement; tier: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
let chartResize: { x: number; y: number; w: number; h: number; curW?: number; curH?: number } | null = null;
function onMouseDown(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('#chart-resize')) {
    const focused = cascadeEl.value?.querySelector<HTMLElement>('.chart-block.focus');
    if (!focused) return;
    e.preventDefault();
    chartResize = { x: e.clientX, y: e.clientY, w: focused.offsetWidth, h: focused.offsetHeight };
    document.body.classList.add('chart-resizing');
    return;
  }
  if (t.closest('.tier-edit')) return;
  const head = t.closest('.chart-head');
  const block = head?.closest<HTMLElement>('.chart-block');
  if (!head || !block) return;
  chartDrag = { block, tier: block.dataset.tier ?? '0', sx: e.clientX, sy: e.clientY, ox: block.offsetLeft, oy: block.offsetTop, moved: false };
}
function onMouseMove(e: MouseEvent): void {
  const z = cam.value.zoom || 1;
  if (chartResize) {
    const w = Math.max(360, Math.round(chartResize.w + (e.clientX - chartResize.x) / z));
    const h = Math.max(120, Math.round(chartResize.h + (e.clientY - chartResize.y) / z));
    chartResize.curW = w; chartResize.curH = h;
    for (const b of cascadeEl.value?.querySelectorAll<HTMLElement>('.chart-block') ?? []) {
      b.style.width = `${w}px`; b.style.minWidth = '0'; b.style.maxWidth = 'none';
    }
    const focused = cascadeEl.value?.querySelector<HTMLElement>('.chart-block.focus');
    if (focused) { focused.style.height = `${h}px`; focused.style.overflow = 'auto'; }
    relayout();
    return;
  }
  if (!chartDrag) return;
  const dx = (e.clientX - chartDrag.sx) / z, dy = (e.clientY - chartDrag.sy) / z;
  if (!chartDrag.moved && Math.hypot(dx, dy) < 4) return; // a small move is a click
  if (!chartDrag.moved) {
    chartDrag.moved = true;
    document.body.classList.add('chart-dragging');
    chartDrag.block.classList.add('dragging-active');
  }
  update({ pos: { ...cam.value.pos, [chartDrag.tier]: { x: Math.max(0, Math.round(chartDrag.ox + dx)), y: Math.max(0, Math.round(chartDrag.oy + dy)) } } });
  nextTick(relayout);
}
function onMouseUp(): void {
  if (chartResize) {
    if (chartResize.curW) update({ size: { w: chartResize.curW, h: chartResize.curH ?? chartResize.h } });
    chartResize = null;
    document.body.classList.remove('chart-resizing');
    return;
  }
  if (!chartDrag) return;
  if (chartDrag.moved) {
    chartDrag.block.classList.remove('dragging-active');
    document.body.classList.remove('chart-dragging');
    dragSuppressClick = true;
    // Breathe the floating Auto Arrange only when it first appears.
    if (!document.querySelector('#arrange-fab.show')) {
      nextTick(() => {
        const fab = document.getElementById('arrange-fab');
        if (!fab) return;
        fab.classList.remove('attention'); void fab.offsetWidth; fab.classList.add('attention');
      });
    }
    drawConnectors();
  }
  chartDrag = null;
}
function onDblClick(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('.tier-edit')) return;
  const block = t.closest('.chart-head')?.closest<HTMLElement>('.chart-block');
  if (!block) return;
  const tier = block.dataset.tier ?? '0';
  if (cam.value.pos[tier]) {
    const pos = { ...cam.value.pos };
    delete pos[tier];
    update({ pos });
  }
}
/** Scroll zooms the chart, anywhere in #ws-main — the side panels keep normal scrolling. */
function onWheel(e: WheelEvent): void {
  if (!(e.target as Element | null)?.closest?.('#ws-main')) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
}
onMounted(() => {
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('wheel', onWheel, { passive: false });
});
onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('wheel', onWheel);
});

// ---- right-click menus (index.html ctxChartRowItems / ctxChartBlankItems) ----------------------
const CTX_LOCK_NOTE: CtxEntry = { note: 'This chart is Final. Reopen it as a draft — the button is in the strip above — to edit it.' };
function onContext(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('input, textarea, .raci-popover, .org-popover')) return;
  const ce = t.closest('[contenteditable="true"]');
  const sl = document.getSelection();
  if (ce && sl && !sl.isCollapsed && sl.anchorNode && ce.contains(sl.anchorNode)) return;
  const c = chart.value;
  if (!c) return;
  const row = t.closest<HTMLElement>('tr.chart-row[data-id]');
  const items = row ? rowItems(c, row.dataset.id!) : blankItems(c);
  if (items && menu.open(e.clientX, e.clientY, items)) e.preventDefault();
}
function rowItems(c: Chart, id: string): CtxEntry[] | null {
  const n = c.nodes[id];
  if (!n) return null;
  const depth = depthOf(c.nodes, id);
  const leaf = !c.custom && depth >= MAX_TIER;
  const tier = tierLabel(c, depth).toLowerCase();
  const childTier = leaf ? '' : tierLabel(c, depth + 1).toLowerCase();
  const kids = countBelow(id);
  const flows = leaf ? flowsByNode.value.get(id) ?? [] : [];
  const anchorOf = (sel: string) => (document.querySelector<HTMLElement>(sel) ?? document.body).getBoundingClientRect();
  const view: CtxEntry[] = [
    { title: n.name || `Untitled ${tier}` },
    { label: 'Node view', ico: '👁', hint: 'How each party lands on this row', run: () => { pop.value = { kind: 'taskview', id, anchor: anchorOf(`[data-row-view="${id}"]`) }; } },
    !leaf && { label: cam.value.drillPath[depth] === id ? 'Collapse breakdown' : 'Drill into breakdown', ico: '▸', run: () => drillToggle(id, depth) },
    leaf && { label: flows.length ? `Open task flow${flows.length > 1 ? ` (${flows.length})` : ''}` : 'Create a task flow…', ico: '⤵',
      hint: 'Continue the drill into a business-case flow', run: () => { pop.value = { kind: 'flow', id, anchor: anchorOf(`[data-flow-btn="${id}"]`) }; } },
  ];
  if (locked.value || !canEdit.value) return [...view, { sep: true as const }, locked.value ? CTX_LOCK_NOTE : false];
  return [
    ...view,
    { sep: true as const },
    { label: 'Rename', ico: '✎', run: () => focusNodeName(id) },
    !leaf && { label: `Add ${childTier} inside`, ico: '＋', run: () => addChild(id) },
    { label: `Add ${tier} below`, ico: '⤵', run: () => addSibling(id) },
    { sep: true as const },
    { label: `Duplicate${kids ? ` (with ${kids} below)` : ''}`, ico: '⧉', run: () => { if (edit()) duplicateNode(session.doc, c.id, id); } },
    { label: 'Copy', ico: '⎘', hint: 'Copy this row and everything under it', run: () => copyNodeTree(id) },
    !leaf && { label: nodeClip ? `Paste "${nodeClip.title}" inside` : 'Paste inside', ico: '⎙', disabled: !nodeClip, run: () => pasteNodeInto(id) },
    { sep: true as const },
    { label: `Delete${kids ? ` (and ${kids} below)` : ''}`, ico: '✕', danger: true, run: () => deleteRow(id) },
  ];
}
function blankItems(c: Chart): CtxEntry[] {
  const view: CtxEntry[] = [
    { title: c.title || 'Chart' },
    { label: 'Auto arrange', ico: '⤧', hint: 'Snap the panes back into a tight nested cascade', run: () => autoArrange() },
    { label: 'Chart details…', ico: '✎', run: () => shell.openMeta('chart', c.id) },
  ];
  if (locked.value) return [...view, { sep: true as const }, CTX_LOCK_NOTE];
  if (!canEdit.value) return view;
  const top = tierLabel(c, 0).toLowerCase();
  return [
    view[0]!,
    { label: `Add ${top} activity`, ico: '＋', run: () => addRoot() },
    { label: nodeClip ? `Paste "${nodeClip.title}" here` : 'Paste', ico: '⎙', disabled: !nodeClip, run: () => pasteNodeInto(null) },
    { sep: true as const }, view[1]!, view[2]!,
  ];
}
void ancestorsOf; void refuseLockedEdit; void insertChart;
</script>
