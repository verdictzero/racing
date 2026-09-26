<template>
  <Teleport to="body">
    <!-- openBizRaciPopover: a step's cell. Chart-Linked adds a third state — a column the row supplies
         (letters dimmed; touching one takes the column over) or one already taken over (↺ Chart). -->
    <div v-if="raci" ref="el" class="raci-popover" :data-id="raci.step.id" :data-col="raci.col" data-biz="1" :style="pos" @click="onRaciClick">
      <div v-if="raci.bind" class="rp-note">Supplied by <b>{{ raci.bind.node.name || '(untitled row)' }}</b> — click a letter to override this column on this step.</div>
      <button v-for="r in raci.F.roles" :key="r" :data-letter="r" :class="[r, { on: raci.set.has(r), 'from-chart': !!raci.bind }]"
        :title="`${raci.F.meta[r]?.label} — ${raci.F.meta[r]?.desc}`">{{ r }}</button>
      <button class="clear" data-clear="1"
        :title="raci.bind ? 'Override this column to no role at all — the step deliberately does not take part here' : 'Clear'">✕</button>
      <button v-if="raci.release" class="rp-release" data-release="1"
        title="Hand this column back to the chart row — the step stops overriding it and follows the chart again">↺ Chart</button>
      <div v-if="!raci.who" class="pop-who unmapped">{{ chrome.colLabel(raci.col) }} — not mapped <span class="pw-hint">(map columns in the Legend)</span></div>
      <div v-else-if="!raci.who.name" class="pop-who nolead">{{ raci.who.actorLabel }} — no lead set <span class="pw-hint">(add in Roster)</span></div>
      <div v-else class="pop-who"><span class="pw-ico">👤</span><b>{{ raci.who.name }}</b><span class="pw-role">· {{ raci.who.actorLabel }}</span></div>
    </div>

    <!-- openBizEdgePopover: name the branch condition, list the deliverables handed off, or delete it. -->
    <div v-else-if="edge" ref="el" class="bz-edge-popover" :data-edge="edge.e.id" :style="pos">
      <label class="bz-ep-label">Path / condition</label>
      <input ref="epInput" class="bz-ep-input" type="text" :value="edge.e.label" placeholder="e.g. Yes / No / If escalated" spellcheck="false"
        :readonly="!canEdit" @keydown="onEdgeKey" @change="commitLabel">
      <label class="bz-ep-label">Deliverables handed off</label>
      <div class="bz-ep-arts">
        <span v-for="(aid, i) in edge.e.artifactIds" :key="i" class="bz-ep-art" :title="artName(aid)">{{ artName(aid) }}<button v-if="canEdit" type="button"
          class="bz-ep-art-rm" :data-rm-art="aid" title="Remove from this handoff" @mousedown.prevent.stop="dropArt(aid)">×</button></span>
        <span v-if="!edge.e.artifactIds.length" class="bz-ep-art-none">none yet</span>
      </div>
      <!-- A viewer, like a Final flow, has no way to add one. -->
      <select v-if="canEdit" ref="epAdd" class="bz-ep-art-add" @change="addArt">
        <option value="">＋ add deliverable…</option>
        <option v-for="a in edge.opts" :key="a.id" :value="a.id">{{ a.name }} ({{ a.type }})</option>
        <option value="__new">＋ new deliverable…</option>
      </select>
      <button v-if="canEdit" class="bz-ep-del" type="button" title="Delete this handoff" @mousedown.prevent.stop="delEdge">🗑 Delete handoff</button>
    </div>

    <!-- openBizBindPopover: which row of the source chart this step implements. -->
    <div v-else-if="bind" ref="el" class="org-popover bzbind-popover" :style="pos" @click="onBindClick">
      <div v-if="!bind.chart" class="op-empty">No organization chart in this workspace to link to. Free-form charts define their own party columns, which have no organizational meaning to carry across.</div>
      <template v-else>
        <div class="op-group">Which row of <b>{{ bind.chart.title || 'Untitled chart' }}</b> does this step implement?</div>
        <input ref="bindFilter" class="bzbind-filter" type="search" placeholder="Filter rows…" spellcheck="false" :value="bindQ" @input="onBindFilter">
        <div class="bzbind-list">
          <button v-for="r in bindRows" :key="r.id" class="op-item bzbind-row" :class="{ on: r.on }" :data-bind-node="r.id" :style="`padding-left:${r.pad}px`" :title="r.path">
            <span class="bzbind-head">
              <span class="bzbind-tier">{{ r.tier }}</span>
              <span class="bzbind-name">{{ r.name }}</span>
              <span v-if="r.org" class="bzbind-org" :title="r.org.full">{{ r.org.short }}</span>
            </span>
            <span v-if="r.chips.length" class="bzbind-chips"><span v-for="c in r.chips" :key="c.col" class="bzbind-col" :title="c.title">{{ c.key }}<b>{{ c.letters }}</b></span></span>
            <span v-else class="bzbind-chips is-none">no roles set on this row</span>
          </button>
          <div v-if="!bindRows.length" class="op-empty">No row matches that filter.</div>
        </div>
        <button v-if="bind.step.bind" class="op-item op-clear" data-bind-clear="1">✕ Unlink this step</button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * The flow's three popovers, which the canvas (and the table) open by setting
 * useFlowScreen().popover — index.html's openBizRaciPopover (bizPopoverInnerHtml, bizToggleRaci,
 * bizClearRaci, bizReleaseCol), openBizEdgePopover and openBizBindPopover (bizBindRowsHtml,
 * bizBindStep, bizUnbindStep) — with the source's placement, its Escape, and its dismissal: a click
 * closes the open popover only when no handler of the source's document click listener took it.
 */
import {
  COLS,
  artifactsInOrder,
  chartTierLabel,
  framework,
  normalizeRaci,
  primaryRColumn,
  type ColKey,
  type Flow,
} from '@raci/core';
import { LOCAL_ORIGIN } from '@raci/crdt';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const screen = chrome.screen;
const session = useWorkspaceSession();
const labels = useLabels();
const popover = screen.popover;

// ---- what is open --------------------------------------------------------------------------------
const raci = computed(() => {
  const p = popover.value;
  if (p?.kind !== 'raci') return null;
  const found = chrome.locate(p.taskId);
  if (!found) return null;
  const { flow: b, step } = found;
  const F = framework(b.framework);
  const eff = chrome.lint.value.stepRaci(b, step)[p.col as ColKey];
  if (!eff) return null;
  const linked = eff.from === 'chart';
  return {
    step,
    col: p.col,
    F,
    set: new Set(eff.letters.split('')),
    bind: linked ? chrome.bindInfo(step) : null,
    // ↺ Chart: a column this bound step has taken back, in a Chart-Linked flow.
    release: !linked && chrome.isLinked(b) && !!step.bind && step.bindOverrides.includes(p.col),
    who: labels.columnPerson(p.col),
  };
});
const edge = computed(() => {
  const p = popover.value;
  if (p?.kind !== 'edge' || !props.flow) return null;
  const e = props.flow.edges[p.edgeId];
  if (!e) return null;
  return { e, opts: artifactsInOrder(chrome.ws.value).filter((a) => !e.artifactIds.includes(a.id)) };
});
const bind = computed(() => {
  const p = popover.value;
  if (p?.kind !== 'bind' || !props.flow) return null;
  const step = props.flow.steps[p.taskId];
  if (!step || chrome.isSub(step)) return null;
  return { step, chart: chrome.sourceChart(props.flow) };
});
// A popover whose subject has gone (deleted here or by a colleague) goes with it.
watch([popover, raci, edge, bind], ([p, r, e, b]) => { if (p && !r && !e && !b) popover.value = null; });

// ---- placement: once, as the source places each popover when it opens ----------------------------
const el = ref<HTMLElement | null>(null);
const at = ref<{ top: number; left: number } | null>(null);
watch(popover, async (p) => {
  at.value = null;
  if (!p) return;
  if (p.kind === 'bind') bindQ.value = '';
  await nextTick();
  const pr = el.value?.getBoundingClientRect();
  if (!pr) return;
  const r = p.anchor;
  const sx = window.scrollX, sy = window.scrollY;
  let top: number, left: number;
  if (p.kind === 'edge') {
    // By the pointer: centred on it, ten pixels below, flipped above when there is no room.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    left = Math.max(8, Math.min(cx - pr.width / 2, window.innerWidth - pr.width - 8));
    top = cy + 10;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, cy - pr.height - 10);
    left += sx; top += sy;
  } else {
    // Under the anchor, centred on it, clamped to the viewport, flipped above when there is no room.
    top = r.bottom + 4 + sy;
    left = Math.max(8, Math.min(r.left + r.width / 2 - pr.width / 2 + sx, window.innerWidth - pr.width - 8));
    if (top + pr.height > sy + window.innerHeight - 8) {
      top = p.kind === 'raci' ? r.top - pr.height - 4 + sy : Math.max(8 + sy, r.top - pr.height - 4 + sy);
    }
  }
  at.value = { top, left };
  // Focus once it is visible: a visibility:hidden field cannot take the focus.
  await nextTick();
  if (popover.value !== p) return;
  if (p.kind === 'edge') { epInput.value?.focus(); epInput.value?.select(); }
  if (p.kind === 'bind') { const f = bindFilter.value; if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
}, { immediate: true });
const pos = computed((): Record<string, string> => (at.value
  ? { top: `${at.value.top}px`, left: `${at.value.left}px` }
  : { top: '0px', left: '0px', visibility: 'hidden' }));

// ---- the cell popover ----------------------------------------------------------------------------
function onRaciClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLElement>('button');
  const p = popover.value;
  if (!btn || p?.kind !== 'raci') return;
  e.stopPropagation();
  if (btn.dataset.release) { chrome.releaseCol(p.taskId, p.col); return; }
  if (btn.dataset.clear) { chrome.clearRaci(p.taskId, p.col); return; }
  if (btn.dataset.letter) chrome.toggleRaci(p.taskId, p.col, btn.dataset.letter);
}

// ---- the handoff popover -------------------------------------------------------------------------
const epInput = ref<HTMLInputElement | null>(null);
const epAdd = ref<HTMLSelectElement | null>(null);
const artName = (id: string) => {
  const a = chrome.ws.value.artifacts[id];
  return a ? a.name || 'Untitled deliverable' : '(missing deliverable)';
};
function onEdgeKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
}
/** The condition commits on change — and the popover closes, as the source's does. */
function commitLabel(e: Event): void {
  const p = popover.value;
  if (p?.kind === 'edge' && props.flow) chrome.setEdgeLabel(props.flow, p.edgeId, (e.target as HTMLInputElement).value.trim());
  popover.value = null;
}
function addArt(e: Event): void {
  const sel = e.target as HTMLSelectElement;
  const val = sel.value;
  sel.value = ''; // the list is rebuilt in the source; its first option shows again
  const p = popover.value;
  if (p?.kind !== 'edge' || !props.flow || !val) return;
  const f = props.flow;
  if (val === '__new') {
    const nm = (window.prompt('New deliverable name:') || '').trim();
    if (!nm) return;
    session.doc.transact(() => {
      const aid = chrome.deliverableNamed(nm);
      if (aid) chrome.addEdgeDeliverable(f, p.edgeId, aid);
    }, LOCAL_ORIGIN);
    return;
  }
  chrome.addEdgeDeliverable(f, p.edgeId, val);
}
function dropArt(aid: string): void {
  const p = popover.value;
  if (p?.kind === 'edge' && props.flow) chrome.dropEdgeDeliverable(props.flow, p.edgeId, aid);
}
/** mousedown, not click, so the condition field does not blur and commit ahead of the delete. */
function delEdge(): void {
  const p = popover.value;
  if (p?.kind === 'edge' && props.flow) chrome.removeEdge(props.flow, p.edgeId);
  popover.value = null;
}

// ---- the row picker --------------------------------------------------------------------------------
const bindFilter = ref<HTMLInputElement | null>(null);
/** _bizBindQ — cleared each time the picker opens. */
const bindQ = ref('');
function onBindFilter(e: Event): void { bindQ.value = (e.target as HTMLInputElement).value; }
/**
 * bizBindRowsHtml: the source chart's rows indented by tier, each with what it would hand the step —
 * its tier, its RACI line (own letters plus the owner the cascade hands it) and its org unit. A
 * filter shows matching rows at their full path, since one name can sit at several places.
 */
const bindRows = computed(() => {
  const b = bind.value;
  if (!b?.chart) return [];
  const chart = b.chart;
  const lc = chrome.lint.value;
  const F = framework(chart.framework);
  const q = bindQ.value.trim().toLowerCase();
  const cur = b.step.bind && b.step.bind.chartId === chart.id ? b.step.bind.nodeId : null;
  const tree = lc.tree(chart);
  const paths = new Map<string, string[]>();
  const inherited = new Map<string, string | null>();
  const out = [];
  for (const row of tree.rows) {
    const n = row.node;
    const name = n.name || '(untitled)';
    const path = [...(row.parent ? paths.get(row.parent.node.id)! : []), name];
    paths.set(n.id, path);
    // The cascade is carried down the walk (cascadeDown), not re-derived per row.
    const inh = row.parent ? (primaryRColumn(row.parent.node, lc.cascadeColumns) ?? inherited.get(row.parent.node.id) ?? null) : null;
    inherited.set(n.id, inh);
    if (q && !name.toLowerCase().includes(q)) continue;
    const hasOwner = COLS.some((k) => normalizeRaci(n.raci[k] ?? '').includes(F.owner));
    const chips = COLS.flatMap((k) => {
      const own = normalizeRaci(n.raci[k] ?? '');
      const inheritedHere = k === inh && !hasOwner;
      if (!own && !inheritedHere) return [];
      return [{ col: k, key: chrome.colShort(k), title: chrome.colLabel(k), letters: own + (inheritedHere && !own.includes(F.owner) ? F.owner : '') }];
    });
    out.push({
      id: n.id,
      on: n.id === cur,
      pad: 8 + (q ? 0 : row.depth * 13),
      path: path.join(' › '),
      tier: chartTierLabel(chart, row.depth),
      name: q ? path.join(' › ') : name,
      org: chrome.orgLabel(n.org),
      chips,
    });
  }
  return out;
});
function onBindClick(e: MouseEvent): void {
  const t = e.target as Element;
  const row = t.closest<HTMLElement>('[data-bind-node]');
  const clr = t.closest('[data-bind-clear]');
  const p = popover.value;
  if ((!row && !clr) || p?.kind !== 'bind') return;
  e.stopPropagation();
  const chart = bind.value?.chart;
  popover.value = null;
  if (clr) { chrome.unbindStep(p.taskId); return; }
  if (chart) chrome.bindStep(p.taskId, chart.id, row!.dataset.bindNode!);
}

// ---- dismissal -------------------------------------------------------------------------------------
/**
 * Everything index.html's document click listener answers and RETURNS from before its last line —
 * the one that closes the open popover. A click on any of these leaves the popover open (a click on
 * ▦ Table does not close a cell's popover there); a click anywhere else closes it.
 */
const HANDLED = [
  '#view-tabs button', '[data-flow-btn]', '[data-flow-open]', '[data-charter-jump]', '[data-bz-detach]', '[data-io-rm]',
  '#wk-print', '[data-work-drill]', '[data-work-see]', '[data-work-goto]', '[data-work-back]', '[data-work-restart]',
  '#art-new', '[data-art-del]',
  '#bz-new', '#bz-rename', '#bz-del', '#bz-add-task', '#bz-toggle-table', '#bz-back', '#bz-gallery', '#bz-gal-close', '#bz-group',
  '[data-gal-open]', '[data-gal-embed]', '[data-bz-open-sub]', '[data-bz-repoint]', '[data-bz-port]',
  '[data-bz-group-collapse]', '[data-bz-group-color]', '[data-bz-group-ungroup]', '[data-bz-group-del]',
  '#bz-zoom-in', '#bz-zoom-out', '#bz-zoom-fit', '#bz-zoom-level', '[data-bz-del-task]', '[data-bz-copy-task]',
  '[data-bz-edge]', '[data-bz-bind]', '[data-bz-bind-jump]', '[data-bz-bind-next]', '[data-bz-cell]', '[data-bz-party]',
  '#bz-party-close', '[data-bz-party-assign]', '[data-bz-party-clear]',
  '#btn-arrange', '#arrange-fab', '#help-docbar [data-help-doc]', '#btn-legend', '#btn-export-menu', '#btn-export',
  '#btn-export-xlsx', '#btn-export-template', '#btn-export-pptx', '#btn-print', '#btn-export-xml', '#btn-export-mmd',
  '#btn-xlsx', '#btn-import', '#btn-merge', '#btn-ingest', '#zoom-in', '#zoom-out', '#zoom-level', '#btn-reset', '#btn-clear',
  '[data-open-meta]', '[data-add-entity]', '[data-del-entity]',
].join(',');
function onDocClick(e: MouseEvent): void {
  if (!popover.value) return;
  const t = e.target as Element | null;
  if (!t?.closest) return;
  if (t.closest('.raci-popover, .org-popover, .bz-edge-popover')) return;
  if (t.closest(HANDLED)) return;
  if (t.closest('[data-gal-case]') && !t.closest('button')) return;
  popover.value = null;
}
/** Escape: the open popover first, then the party panel — after the shell's dialogs, which win. */
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (document.querySelector('#newchart-overlay.open, #xlsx-overlay.open, #meta-overlay.open, #export-menu.open')) return;
  if (popover.value) { popover.value = null; return; }
  if (screen.partyTarget.value) chrome.closeParty();
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
  popover.value = null;
});
</script>
