<template>
  <!-- index.html's <body>, element for element, in the same order: the stylesheet is the source's,
       verbatim (assets/css/legacy.css), so this markup is shaped to its selectors. -->
  <div id="toast-tray" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="[t.type, { show: t.show }]">
      <span class="toast-ico">{{ t.type === 'error' ? '⛔' : '💡' }}</span><span>{{ t.message }}</span>
    </div>
  </div>
  <ShellViolationsToast :records="violationRecordsNow" @jump="jumpTo" />
  <button id="arrange-fab" type="button" :class="{ show: view === 'chart' && panesMoved, attention: fabAttention }"
    title="Snap all moved panes back into the tight nested cascade (or double-click any pane header)" @click="arrange">
    <span class="af-icon" aria-hidden="true">⤧</span><span class="af-text">Auto Arrange</span>
  </button>
  <div id="sidebar-arrow" ref="sidebarArrow" aria-hidden="true">
    <span class="sa-label">Details panel</span>
    <span class="sa-arrow">➤</span>
  </div>
  <!-- index.html's #save-nag and #splash-overlay are not here on purpose: both say this tool keeps
       work only in the browser and that it will be lost without Save — true of the single file,
       false here, where every edit is already saved to the server. -->
  <ShellNewChartOverlay :open="newChartOpen" @close="newChartOpen = false" @created="onChartCreated" />
  <ShellXlsxOverlay :open="xlsxOpen" @close="xlsxOpen = false" />
  <ShellMetaOverlay :target="metaTarget" :can-edit="canEdit" @close="metaTarget = null" />
  <ShellContextMenu />

  <img id="bg-watermark" ref="watermark" src="/asic-emblem.png" alt="" aria-hidden="true">
  <div id="app-frame">
    <header>
      <div id="view-tabs" class="view-tabs">
        <span class="vt-heading">Mode</span>
        <div class="vt-box vt-box--raci" data-box="raci">
          <span class="vt-box-label">RACI Chart</span>
          <button data-view="chart" :class="{ active: view === 'chart' }" @click="go('')">Chart</button>
          <button data-view="roster" :class="{ active: view === 'roster' }" @click="go('/roster')">Roster</button>
          <button data-view="work" :class="{ active: view === 'work' }"
            title="Pick an org unit and see every chart row and flow step that lands on it — with each task's inputs and outputs"
            @click="go('/tasks')">Tasks</button>
        </div>
        <div class="vt-box vt-box--flow" data-box="flow">
          <span class="vt-box-label">Task Flows</span>
          <button data-view="bizcase" :class="{ active: view === 'bizcase' }"
            title="Business Case Task Flow — a separate system: steps wired into a graph, run either Chart-Linked (every step names the chart row it implements) or Free-Form"
            @click="go('/flow')"><span class="vt-lg">Business Case Task Flow</span><span class="vt-sm">Biz Case</span></button>
        </div>
        <span class="vt-sep vt-sep--obj" aria-hidden="true" />
        <div class="vt-box vt-box--obj" data-box="obj">
          <span class="vt-box-label">Objects</span>
          <button data-view="objects" :class="{ active: view === 'objects' }"
            title="Every named thing in the workspace — deliverables that move between steps, and entities that act as parties. One place to browse them, edit them, and see everywhere each one is used"
            @click="go('/objects')"><span class="vt-lg">Object Gallery</span><span class="vt-sm">Objects</span></button>
        </div>
        <span class="vt-sep" aria-hidden="true" />
        <button data-view="help" class="tab-help" :class="{ active: view === 'help' }"
          title="Field guides: how nested RACI charts work, and how the chart, anchored flows, and the Tasks lens fit together"
          @click="go('/help')"><span class="vt-help-ico" aria-hidden="true">?</span>Help</button>
      </div>

      <div id="tool-rail">
        <!-- The brand doubles as the way back to the workspace list: the source has one document,
             so it has no list to go back to and no control for it. Look unchanged. -->
        <div id="brand-zone" class="to-list" title="All workspaces" @click="navigateTo('/')">
          <img id="app-logo" src="/asic-emblem.png" alt="ASIC — Army Software &amp; Innovation Center"
            title="ASIC — Army Software &amp; Innovation Center">
          <div id="app-brand" title="ASIC RACI Tool — Army Software & Innovation Center">
            <span class="brand-name">ASIC RACI Tool</span><span class="brand-ver">ver {{ VERSION }}</span>
          </div>
        </div>
        <div class="actions">
          <button id="btn-export" title="Save your work — downloads a JSON file with every tab, the roster, and attached documents"
            @click="rail.save()">💾 Save</button>
          <button id="btn-import" :disabled="!canEdit" title="Load a previously-saved JSON file (replaces current state)"
            @click="pickWorkspaceFile(false)">📂 Load</button>
          <button id="btn-merge" :disabled="!canEdit"
            title="Merge another saved JSON file into this workspace — its charts and business cases are added as new tabs"
            @click="pickWorkspaceFile(true)">⧉ Merge</button>
          <input id="file-import" ref="fileImport" type="file"
            accept=".json,.xlsx,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            @change="onWorkspaceFile">
          <button id="btn-ingest"
            title="Download the LLM Ingest Kit — hand this file plus your raw notes, spreadsheet or slides to any LLM and it writes a JSON file you can Load or Merge here"
            @click="rail.downloadIngestKit()">🤖 Ingest Kit</button>
          <button id="btn-xlsx" :disabled="!canEdit"
            title="Build a chart from a spreadsheet — import a filled-in workbook, or download the blank template to fill in first"
            @click="xlsxOpen = true">📗 Import Excel</button>
          <span class="actions-divider" aria-hidden="true" />
          <button id="btn-arrange" title="Snap all panes back into a tight nested cascade" @click="arrange">⤧ Auto Arrange</button>
          <button id="btn-details" title="Show/hide the Activity Details panel (definitions + documents)"
            @click="showDetails ? closeDetails() : openDetails()">Details</button>
          <button id="btn-legend" title="Show/hide RACI legend" @click="setLegend(!showLegend)">Legend</button>
          <div id="export-menu" ref="exportMenu" class="export-menu" :class="{ open: exportOpen }">
            <button id="btn-export-menu" type="button" aria-haspopup="true" :aria-expanded="exportOpen"
              aria-controls="export-menu-list" title="Export the matrix as a document — Print/PDF, PowerPoint, Excel, XML, or Mermaid"
              @click="exportOpen = !exportOpen">⭳ Export <span class="em-caret" aria-hidden="true">▾</span></button>
            <div id="export-menu-list" class="export-menu-list" role="menu" aria-label="Export options" :hidden="!exportOpen">
              <button id="btn-print" class="em-item" role="menuitem" type="button"
                title="Print or save the matrix as a PDF (clean, chrome-free layout)" @click="print">
                <span class="em-ico">🖨</span><span class="em-label">Print / PDF</span></button>
              <button id="btn-export-pptx" class="em-item" role="menuitem" type="button"
                title="Export as PowerPoint (.pptx) — one slide per tier" @click="download('pptx')">
                <span class="em-ico">📊</span><span class="em-label">PowerPoint</span><span class="em-ext">.pptx</span></button>
              <button id="btn-export-xlsx" class="em-item" role="menuitem" type="button"
                title="Export as Excel (.xlsx) for spreadsheet review" @click="download('xlsx')">
                <span class="em-ico">📗</span><span class="em-label">Excel</span><span class="em-ext">.xlsx</span></button>
              <button id="btn-export-template" class="em-item" role="menuitem" type="button"
                title="Download a blank Excel workbook to fill in — Load it back here when it is done" @click="download('template')">
                <span class="em-ico">📋</span><span class="em-label">Blank template</span><span class="em-ext">.xlsx</span></button>
              <button id="btn-export-xml" class="em-item" role="menuitem" type="button"
                title="Export as XML for programmatic processing" @click="download('xml')">
                <span class="em-ico">📄</span><span class="em-label">XML</span><span class="em-ext">.xml</span></button>
              <button id="btn-export-mmd" class="em-item" role="menuitem" type="button"
                title="Export as Mermaid (.mmd) for diagramming" @click="download('mermaid')">
                <span class="em-ico">🧭</span><span class="em-label">Mermaid</span><span class="em-ext">.mmd</span></button>
            </div>
          </div>
          <span class="actions-divider" aria-hidden="true" />
          <div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Appearance theme">
            <span class="ts-label" aria-hidden="true">Theme</span>
            <button v-for="opt in THEME_OPTIONS.slice(0, 2)" :key="opt.id" type="button" class="ts-opt" role="radio"
              :aria-checked="theme === opt.id" :data-theme-set="opt.id" :title="opt.title" @click="setTheme(opt.id)">
              <span class="ts-ico" aria-hidden="true">{{ opt.icon }}</span>{{ opt.label }}</button>
            <span class="ts-label ts-label--hc" aria-hidden="true">High contrast</span>
            <button v-for="opt in THEME_OPTIONS.slice(2)" :key="opt.id" type="button" class="ts-opt" role="radio"
              :aria-checked="theme === opt.id" :data-theme-set="opt.id" :aria-label="opt.aria" :title="opt.title"
              @click="setTheme(opt.id)"><span class="ts-ico" aria-hidden="true">{{ opt.icon }}</span>{{ opt.label }}</button>
          </div>
          <button id="btn-reset" :disabled="!canEdit" title="Load the built-in demo dataset (replaces current charts and roster)"
            @click="rail.loadDemo()">Demo</button>
          <button id="btn-clear" :disabled="!canEdit" title="Wipe all activities and roster data — blank slate"
            @click="rail.clearAll()">Clear</button>
          <!-- Below where the source's rail ends: who is signed in, and whether edits are live. -->
          <div class="rail-who">
            <span class="rw-name">{{ me?.user?.displayName }}</span>
            <span class="rw-role">{{ me?.user?.role }}</span>
            <span class="rw-live" :data-state="session.status.value" :title="statusTitle">{{ statusLabel }}</span>
            <span v-if="session.peers.value > 1" class="rw-peers">{{ session.peers.value }} here</span>
          </div>
          <button class="rw-out" :title="`Sign out ${me?.user?.displayName ?? ''} (${me?.user?.role ?? ''} · ${statusLabel})`" @click="signOut">Sign out</button>
        </div>
      </div>
    </header>

    <div id="chart-tabs" role="tablist" aria-label="RACI chart tabs" @contextmenu="onTabsContext">
      <div v-for="chart in chartTabs" :key="chart.id" class="chart-tab"
        :class="{ active: chart.id === activeChart?.id, 'is-only': chartTabs.length === 1 }"
        :data-status="chart.status" role="tab" :aria-selected="chart.id === activeChart?.id" :data-tab="chart.id"
        :title="`${STATUS_META[chart.status].name} — ${STATUS_META[chart.status].blurb}\nClick to switch${chart.status === 'final' ? '' : ' · double-click to rename'}`"
        @click="switchChart(chart.id, $event)">
        <span class="tab-status">{{ STATUS_META[chart.status].short }}</span>
        <span class="tab-label" :data-tab-id="chart.id" spellcheck="false" :title="chart.title || 'Untitled chart'"
          @dblclick="startRename($event)" @blur="finishRename(chart.id, $event)">{{ chart.title || 'Untitled chart' }}</span>
        <button class="tab-close" type="button" :data-tab-close="chart.id"
          :title="chart.status === 'final' ? 'This chart is Final — reopen it as a draft before closing it' : 'Close this chart'"
          @click.stop="closeChart(chart.id)">×</button>
      </div>
      <button id="chart-tab-add" type="button" title="Add a new blank chart tab" @click="newChartOpen = true">+</button>
      <button type="button" class="chart-meta-btn" data-open-meta="chart"
        title="Description, customer, priority, budget and tags for this chart — searched and exported"
        @click="openMeta('chart')">✎ Details<span v-if="hasMeta(activeChart)" class="has-meta-dot" aria-hidden="true" /></button>
      <div class="chart-fw" title="Responsibility framework for this chart — RASCI adds a Support role">
        <span class="cf-label">Framework</span>
        <select id="chart-framework" :value="activeChart?.framework ?? 'raci'" :disabled="!canEdit"
          @change="setFramework(($event.target as HTMLSelectElement).value)">
          <option v-for="k in CHART_FRAMEWORKS" :key="k" :value="k">{{ FRAMEWORKS[k]?.name }}</option>
        </select>
      </div>
    </div>

    <div id="drill-crumbs">
      <template v-for="(crumb, i) in crumbs" :key="crumb.id">
        <span v-if="i" class="crumb-sep">›</span>
        <button class="crumb" :class="[`t${Math.min(i, 3)}`, { current: i === crumbs.length - 1 }]" :data-crumb-tier="i"
          :disabled="i === crumbs.length - 1" :title="i === crumbs.length - 1 ? 'Current level' : `Jump to ${crumb.name}`"
          @click="crumbNav(i)">
          <span class="crumb-tier">{{ crumb.tierName }}</span>
          <span class="crumb-name">{{ crumb.name }}</span>
        </button>
      </template>
    </div>

    <main>
      <div id="print-head" ref="printHead" />
      <section id="ws-main" ref="wsMain"><NuxtPage /></section>
      <aside id="details" aria-label="Activity details panel">
        <div class="det-head">
          <h3>Activity Details</h3>
          <button id="det-close" type="button" title="Close panel (Esc)" aria-label="Close panel" @click="closeDetails">×</button>
        </div>
        <ShellDetailsPanel :can-edit="canEdit" @attach="pickDocuments" />
        <input id="det-file-input" ref="detFileInput" type="file" multiple style="display:none" @change="onDocuments">
      </aside>
      <aside id="legend"><ShellLegendPanel :chart="activeChart" :can-edit="canEdit" /></aside>
      <!-- Filled by the flow screen (Teleport), which owns the Responsible Party picker. -->
      <aside id="bz-party-panel" aria-label="Responsible party picker" />
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * The workspace shell — index.html's <body> outside #ws-main: both rails, the chart tab strip, the
 * crumb band, the side panels and every overlay, over one collaborative session.
 *
 * Keep the markup's ids, classes and nesting identical to the source's: the stylesheet is the
 * source's, unedited, so changing the shape here silently un-styles it. Screens render inside
 * #ws-main and reach the chrome here through useShell / useChartView / useContextMenu.
 *
 * `canEdit` is a UI affordance, never the enforcement: the server checks the role on every write.
 */
import { CHART_FRAMEWORKS, FRAMEWORKS, type Chart } from '@raci/core';
import { LOCAL_ORIGIN, deleteChart, insertChart, setChartField } from '@raci/crdt';
import type { ThemeName } from '~/composables/useTheme';
import { CRUMB_KEY, type Crumb } from '~/composables/useCrumbs';
import type { CtxEntry } from '~/composables/useContextMenu';
import { SHELL_KEY, type ShellBridge, type ToastType } from '~/composables/useShell';
import { violationRecords, type ViolationRecord } from '~/composables/useViolationRecords';

/** Tracks the document format, which is why it is not the package version. */
const VERSION = '0.39 alpha';

const STATUS_META = {
  draft: { name: 'Draft', short: 'DRAFT', blurb: 'Working copy — still being written, and free to change.' },
  final: { name: 'Final', short: 'FINAL', blurb: 'Signed off, and locked against edits.' },
} as const;

const THEME_OPTIONS: { id: ThemeName; label: string; icon: string; title: string; aria?: string }[] = [
  { id: 'dark', label: 'Dark', icon: '◐', title: 'Dark — the default palette' },
  { id: 'light', label: 'Light', icon: '☀', title: 'Light — light surfaces, hues re-picked for contrast on paper' },
  { id: 'hc-light', label: 'Light', icon: '◑', aria: 'High contrast (light)',
    title: 'High contrast (light) — white ground, black rules, deepened role colours' },
  { id: 'hc-dark', label: 'Dark', icon: '◐', aria: 'High contrast (dark)',
    title: 'High contrast (dark) — black ground, white rules, maximum-chroma role colours' },
  { id: 'hc-neon', label: 'Neon', icon: '⚡', aria: 'High contrast (neon)',
    title: 'High contrast (neon) — near-black ground and role colours at full voltage' },
];

const route = useRoute();
const workspaceId = route.params.id as string;
const { data: me } = await useFetch('/api/auth/me');
const session = provideWorkspaceSession(workspaceId);
const { theme, set: setTheme } = useTheme();
const canEdit = computed(() => me.value?.user?.role === 'editor' || me.value?.user?.role === 'admin');
provide('raci:canEdit', canEdit);

// ---- the bridge screens use (composables/useShell.ts) --------------------------------------------
interface Toast { id: number; message: string; type: ToastType; show: boolean }
const toasts = ref<Toast[]>([]);
let toastSeq = 0;
function toast(message: string, type: ToastType = 'suggest'): void {
  const t: Toast = { id: ++toastSeq, message, type, show: false };
  toasts.value.push(t);
  requestAnimationFrame(() => { const live = toasts.value.find((x) => x.id === t.id); if (live) live.show = true; });
  setTimeout(() => {
    const live = toasts.value.find((x) => x.id === t.id);
    if (live) live.show = false;
    setTimeout(() => { toasts.value = toasts.value.filter((x) => x.id !== t.id); }, 220);
  }, type === 'error' ? 3200 : 5200);
}
const metaTarget = ref<{ kind: 'chart' | 'flow'; id: string | null } | null>(null);
function openMeta(kind: 'chart' | 'flow', id?: string): void {
  const target = { kind, id: id ?? (kind === 'chart' ? activeChart.value?.id ?? null : activeFlowId.value) };
  if (target.id) metaTarget.value = target;
}
provideOwn<ShellBridge>(SHELL_KEY, { openMeta, toast });

// ---- which screen is up: the source's view names drive body[data-view] --------------------------
const view = computed(() => {
  const path = route.path.replace(`/w/${workspaceId}`, '');
  if (path.startsWith('/roster')) return 'roster';
  if (path.startsWith('/tasks')) return 'work';
  if (path.startsWith('/flow')) return 'bizcase';
  if (path.startsWith('/objects')) return 'objects';
  if (path.startsWith('/help')) return 'help';
  return 'chart';
});
const go = (suffix: string) => navigateTo(`/w/${workspaceId}${suffix}`);

// ---- chart-view camera: Details, Legend, Auto Arrange --------------------------------------------
const { showDetails, showLegend, panesMoved, fabAttention, activeNodeId, setLegend, restoreLegend, openDetails: open, closeDetails, arrange } = useChartView();
const sidebarArrow = ref<HTMLElement | null>(null);
let arrowTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * index.html's flashSidebarArrow, on every closed → open transition of the Details panel — whoever
 * opened it. Watching the state rather than wrapping one opener is what makes the chart screen's
 * row click flash it too.
 */
function flashSidebarArrow(): void {
  const el = sidebarArrow.value;
  if (!el) return;
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
  clearTimeout(arrowTimer);
  arrowTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
watch(showDetails, (on, was) => { if (on && !was) flashSidebarArrow(); });
const openDetails = open;
watch(activeNodeId, (id) => { if (id) openDetails(); });


// ---- chart tabs ------------------------------------------------------------------------------------
const chartTabs = computed(() => {
  const ws = session.workspace.value;
  // Code-unit order, never localeCompare: fractional-index keys are case-sensitive base-62, and a
  // locale-aware compare folds case — which put a newly added chart BEFORE the existing tabs.
  const order = Object.entries(ws.chartOrder ?? {})
    .sort(([, a], [, b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
    .map(([id]) => id);
  const ids = order.length ? order : Object.keys(ws.charts);
  return ids.map((id) => ws.charts[id]).filter((c): c is Chart => Boolean(c));
});
const activeChartId = useActiveChartId();
const activeFlowId = useActiveFlowId();
const activeChart = computed(() => chartTabs.value.find((c) => c.id === activeChartId.value) ?? chartTabs.value[0] ?? null);
watch(chartTabs, (list) => {
  if (!list.some((c) => c.id === activeChartId.value)) activeChartId.value = list[0]?.id ?? null;
}, { immediate: true });
provide('raci:activeChartId', activeChartId);

// body[data-lock] — index.html's lockedNow(): the open chart (chart view) or the open flow (flow
// view) is Final. The stylesheet keys every add/delete/rename affordance off it.
const lockKind = computed(() => {
  const ws = session.workspace.value;
  if (view.value === 'chart') return activeChart.value?.status === 'final' ? 'chart' : undefined;
  if (view.value === 'bizcase') {
    const f = activeFlowId.value ? ws.flows[activeFlowId.value] : undefined;
    return f?.status === 'final' ? 'flow' : undefined;
  }
  return undefined;
});

useHead({
  bodyAttrs: {
    'data-view': view,
    'data-lock': lockKind,
    class: computed(() => [showDetails.value ? 'show-details' : '', showLegend.value ? 'show-legend' : ''].filter(Boolean).join(' ')),
  },
});

const { guardEdit } = useLock();
const hasMeta = (c: Chart | null) => {
  const m = c?.meta;
  return !!(m && (m.description || m.customer || m.priority || m.budget || m.tags.length));
};
function switchChart(id: string, e: MouseEvent): void {
  if ((e.target as Element).closest('.tab-label[contenteditable="true"]')) return;
  if (id === activeChartId.value) return;
  activeChartId.value = id;
  activeNodeId.value = null; // the Details selection is per chart
}
function startRename(e: MouseEvent): void {
  const el = e.target as HTMLElement;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el);
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
}
function finishRename(id: string, e: FocusEvent): void {
  const el = e.target as HTMLElement;
  if (el.getAttribute('contenteditable') !== 'true') return;
  el.removeAttribute('contenteditable');
  const chart = session.workspace.value.charts[id];
  const title = (el.textContent ?? '').trim() || 'Untitled chart';
  if (!chart || !canEdit.value || !guardEdit('chart', chart)) { el.textContent = chart?.title || 'Untitled chart'; return; }
  if (title !== chart.title) setChartField(session.doc, id, 'title', title);
  else el.textContent = title;
}
/** index.html's deleteChart: never the last one, never a Final one, confirm unless empty. */
function closeChart(id: string): void {
  if (!canEdit.value || chartTabs.value.length <= 1) return;
  const c = session.workspace.value.charts[id];
  if (!c || !guardEdit('chart', c)) return;
  const empty = Object.keys(c.nodes).length === 0;
  if (!empty && !confirm(`Close chart "${c.title}"? Its activities will be discarded. (Export to JSON first if you want to keep them.)`)) return;
  const idx = chartTabs.value.findIndex((x) => x.id === id);
  if (activeChartId.value === id) {
    activeChartId.value = chartTabs.value[Math.max(0, idx - 1)]?.id ?? null;
    if (activeChartId.value === id) activeChartId.value = chartTabs.value[idx + 1]?.id ?? null;
    activeNodeId.value = null;
  }
  deleteChart(session.doc, id);
}
function setFramework(key: string): void {
  const c = activeChart.value;
  if (!c || c.framework === key) return;
  if (!guardEdit('chart', c)) return;
  setChartField(session.doc, c.id, 'framework', key);
}
/** index.html's duplicateChart: a draft copy under fresh ids, landing as the open tab. */
function duplicateChart(id: string): void {
  const src = session.workspace.value.charts[id];
  if (!src || !canEdit.value) return;
  const mint = (p: string) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
  const chartId = mint('chart');
  const idMap = new Map(Object.keys(src.nodes).map((n) => [n, mint('node')]));
  const taken = chartTabs.value.map((c) => c.title);
  const base = /^Copy of /.test(src.title) ? src.title : `Copy of ${src.title || 'Untitled'}`;
  let title = base;
  for (let i = 2; taken.includes(title); i++) title = `${base} (${i})`;
  const nodes = Object.fromEntries(Object.values(src.nodes).map((n) => [idMap.get(n.id)!, {
    ...n, id: idMap.get(n.id)!, chartId, parentId: n.parentId ? idMap.get(n.parentId) ?? null : null,
  }]));
  // A copy is a working document however the original was signed — otherwise "duplicate to try
  // something" hands you a locked tab.
  insertChart(session.doc, { ...src, id: chartId, title, status: 'draft', finalizedAt: null, nodes });
  activeChartId.value = chartId;
  activeNodeId.value = null;
}
function setChartStatusFromTab(id: string, next: 'draft' | 'final'): void {
  const c = session.workspace.value.charts[id];
  if (!c || !canEdit.value || c.status === next) return;
  session.doc.transact(() => {
    setChartField(session.doc, id, 'status', next);
    setChartField(session.doc, id, 'finalizedAt', next === 'final' ? new Date().toISOString() : null);
  }, LOCAL_ORIGIN);
  toast(next === 'final' ? `“${c.title || 'Untitled chart'}” is Final — locked against edits.` : `“${c.title || 'Untitled chart'}” reopened as a Draft.`, 'suggest');
}
/** index.html's ctxChartTabItems / ctxChartTabBarItems. */
const menu = useContextMenu();
function onTabsContext(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('input, select')) return;
  const tab = t.closest<HTMLElement>('[data-tab]');
  let items: CtxEntry[];
  if (tab) {
    const id = tab.dataset.tab!;
    const c = session.workspace.value.charts[id];
    if (!c) return;
    const locked = c.status === 'final';
    const only = chartTabs.value.length <= 1;
    items = [
      { title: c.title || 'Untitled chart' },
      id !== activeChartId.value && { label: 'Switch to this chart', ico: '→', run: () => { activeChartId.value = id; activeNodeId.value = null; } },
      { label: 'Details…', ico: '✎', hint: 'Description, customer, priority, budget and tags', run: () => { activeChartId.value = id; openMeta('chart', id); } },
      canEdit.value && { label: 'Duplicate chart', ico: '⧉', run: () => duplicateChart(id) },
      { sep: true },
      canEdit.value && { label: locked ? 'Reopen as draft' : 'Mark final', ico: locked ? '↺' : '✓', run: () => setChartStatusFromTab(id, locked ? 'draft' : 'final') },
      canEdit.value && !locked && { label: 'Rename', ico: '✏', run: () => {
        const el = document.querySelector<HTMLElement>(`.tab-label[data-tab-id="${id}"]`);
        if (el) startRename({ target: el } as unknown as MouseEvent);
      } },
      { sep: true },
      canEdit.value && { label: 'Close chart', ico: '✕', danger: true, disabled: only,
        hint: only ? 'The last chart cannot be closed' : 'Discard this tab', run: () => closeChart(id) },
    ];
  } else {
    items = [
      { title: 'Chart tabs' },
      canEdit.value && { label: 'New chart…', ico: '＋', hint: 'Organization or free-form', run: () => { newChartOpen.value = true; } },
      canEdit.value && activeChart.value && { label: 'Duplicate the open chart', ico: '⧉', run: () => duplicateChart(activeChart.value!.id) },
    ];
  }
  if (menu.open(e.clientX, e.clientY, items)) e.preventDefault();
}
const newChartOpen = ref(false);
async function onChartCreated(id: string): Promise<void> {
  activeChartId.value = id;
  if (view.value !== 'chart') await go('');
  // Focus the new tab's label so a name can be typed straight away — as index.html's addChart.
  await nextTick();
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.tab-label[data-tab-id="${id}"]`);
    if (el) startRename({ target: el } as unknown as MouseEvent);
  });
}

// ---- the crumb band: the chart screen fills it -----------------------------------------------------
const crumbs = ref<Crumb[]>([]);
const crumbNav = ref<(index: number) => void>(() => {});
provide(CRUMB_KEY, { crumbs, crumbNav });



// ---- the warnings pill ------------------------------------------------------------------------------
const violationRecordsNow = computed(() =>
  violationRecords(session.workspace.value, view.value, activeChart.value?.id ?? null, activeFlowId.value));
/** Asks the owning screen to bring a row or step into view; the screens watch this. */
const jumpRequest = useState<{ kind: 'chart' | 'flow'; id: string; flowId: string | null; at: number } | null>('raci:jump', () => null);
async function jumpTo(r: ViolationRecord): Promise<void> {
  if (r.kind === 'flow') {
    activeFlowId.value = r.flowId;
    if (view.value !== 'bizcase') await go('/flow');
    jumpRequest.value = { kind: 'flow', id: r.stepId, flowId: r.flowId, at: Date.now() };
    return;
  }
  if (view.value !== 'chart') await go('');
  jumpRequest.value = { kind: 'chart', id: r.nodeId, flowId: null, at: Date.now() };
}

// ---- status ------------------------------------------------------------------------------------------
const statusLabel = computed(() => {
  switch (session.status.value) {
    case 'connected': return 'live';
    case 'connecting': return 'connecting…';
    default: return 'offline';
  }
});
const statusTitle = computed(() =>
  session.status.value === 'offline'
    ? 'Offline — your edits are kept and will sync when the connection comes back'
    : 'Connected to the collaboration server');

// ---- rail actions ------------------------------------------------------------------------------------
const rail = useRailActions();
const exportOpen = ref(false);
const exportMenu = ref<HTMLElement | null>(null);
function download(format: 'xml' | 'mermaid' | 'xlsx' | 'template' | 'pptx'): void {
  exportOpen.value = false;
  const chart = activeChart.value ? `&chartId=${encodeURIComponent(activeChart.value.id)}` : '';
  location.href = `/api/workspaces/${workspaceId}/export?format=${format}${chart}`;
}
function print(): void { exportOpen.value = false; window.print(); }

const xlsxOpen = ref(false);
const fileImport = ref<HTMLInputElement | null>(null);
let mergeNext = false;
function pickWorkspaceFile(merge: boolean): void { mergeNext = merge; fileImport.value?.click(); }
async function onWorkspaceFile(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = '';
  const merge = mergeNext;
  mergeNext = false;
  if (f) await rail.openWorkspaceFile(f, merge);
}

const detFileInput = ref<HTMLInputElement | null>(null);
const docs = useDocuments();
let attachTo: string | null = null;
function pickDocuments(nodeId: string): void { attachTo = nodeId; detFileInput.value?.click(); }
async function onDocuments(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const id = attachTo ?? activeNodeId.value;
  if (id && el.files?.length) await docs.attach(id, el.files);
  el.value = '';
  attachTo = null;
}
provide('raci:attachDocuments', pickDocuments);

async function signOut() {
  const result = await $fetch<{ endSessionUrl: string | null }>('/api/auth/logout', { method: 'POST' });
  // Ending only the local session leaves the IdP's cookie in place, so the next sign-in walks
  // straight back in without a prompt — which looks exactly like the logout failed.
  location.href = result.endSessionUrl ?? '/';
}

// ---- the watermark: pinned inside #ws-main's bottom-right corner (index.html positionWatermark) ----
const watermark = ref<HTMLImageElement | null>(null);
const wsMain = ref<HTMLElement | null>(null);
const WM_INSET = 18;
const WM_ASPECT = 1000 / 1190;
function positionWatermark(): void {
  const wm = watermark.value, pane = wsMain.value;
  if (!wm || !pane) return;
  const r = pane.getBoundingClientRect();
  const gutterX = pane.offsetWidth - pane.clientWidth;
  const gutterY = pane.offsetHeight - pane.clientHeight;
  // A corner mark, not a backdrop: at most a third of the pane wide and half of it tall.
  const w = Math.max(90, Math.min(300,
    (pane.clientWidth - 2 * WM_INSET) / 3,
    (pane.clientHeight - 2 * WM_INSET) * WM_ASPECT / 2));
  wm.style.setProperty('--wm-w', `${Math.round(w)}px`);
  wm.style.setProperty('--wm-right', `${Math.round(Math.max(0, window.innerWidth - r.right + gutterX + WM_INSET))}px`);
  wm.style.setProperty('--wm-bottom', `${Math.round(Math.max(0, window.innerHeight - r.bottom + gutterY + WM_INSET))}px`);
}

// ---- print: the title band the source fills just before the print layout paints ----------------
const printHead = ref<HTMLElement | null>(null);
const printLabels = useLabels();
function beforePrint(): void {
  const ph = printHead.value;
  // The Tasks screen fills the band itself for its run book: only it knows the unit it is showing.
  if (!ph || view.value === 'work') return;
  const ws = session.workspace.value;
  const flow = activeFlowId.value ? ws.flows[activeFlowId.value] : undefined;
  const printed = view.value === 'bizcase' ? flow : activeChart.value;
  const pst = printed?.status ?? 'draft';
  document.body.dataset.printStatus = pst;
  let title: string, sub: string;
  if (view.value === 'bizcase') {
    const n = flow ? Object.keys(flow.steps).length : 0;
    title = flow?.name || 'Business case';
    sub = `${FRAMEWORKS[flow?.framework ?? 'raci']?.name ?? 'RACI'} · ${n} step${n === 1 ? '' : 's'} · tabletop exercise`;
  } else {
    const c = activeChart.value;
    title = c?.title || 'RACI chart';
    const cols = c?.custom ? c.custom.cols.map((x) => x.key) : ['hq', 'cos', 'mission', 'infra', 'cyber', 'sw', 'contacts'];
    sub = `${FRAMEWORKS[c?.framework ?? 'raci']?.name ?? 'RACI'} responsibility matrix · ${cols.map((k) => printLabels.colShort(k, c)).join(' · ')}`;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const signed = pst === 'final' && printed?.finalizedAt ? ` · signed ${esc(new Date(printed.finalizedAt).toLocaleDateString())}` : '';
  ph.innerHTML = `<div class="ph-title">${pst ? `<span class="ph-status is-${pst}">${STATUS_META[pst as 'draft' | 'final'].short}</span>` : ''}${esc(title)}</div>`
    + `<div class="ph-sub">${esc(sub)}${signed}</div>`;
}

// ---- global keys: undo/redo, Enter commits an inline edit (index.html's keydown handler) --------
function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (e.key === 'Enter' && !e.shiftKey && t?.matches?.('[contenteditable="true"]')) { e.preventDefault(); t.blur(); return; }
  if (e.key === 'Escape' && showDetails.value && !(t?.matches?.('input, textarea, [contenteditable="true"]'))) {
    if (!metaTarget.value) closeDetails();
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (t?.matches?.('input, textarea, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (!session.undo.undoStack.length) toast('Nothing to undo', 'suggest'); else session.undo.undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      if (!session.undo.redoStack.length) toast('Nothing to redo', 'suggest'); else session.undo.redo();
    }
  }
}
/**
 * index.html's lock gate. The CSS takes the add/delete/rename affordances away from a Final
 * chart or flow; this covers what CSS cannot reach — typing into a field that still has focus,
 * paste, drop, drag — and runs in the capture phase so it is ahead of every screen's handler.
 */
const { refuseLockedEdit } = useLock();
function lockGate(e: Event): void {
  const kind = lockKind.value;
  const el = e.target as Element | null;
  if (!kind || el?.closest?.('[data-lock-ok], input[type="search"]')) return;
  e.preventDefault();
  e.stopPropagation();
  refuseLockedEdit(kind);
}
const LOCK_EVENTS = ['beforeinput', 'paste', 'drop', 'dragstart', 'change'] as const;

function onDocClick(e: MouseEvent): void {
  if (exportOpen.value && !exportMenu.value?.contains(e.target as Node)) exportOpen.value = false;
}

let resizeObs: ResizeObserver | null = null;
onMounted(() => {
  restoreLegend();
  for (const t of LOCK_EVENTS) document.addEventListener(t, lockGate, true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('resize', positionWatermark);
  if (window.ResizeObserver && wsMain.value) {
    resizeObs = new ResizeObserver(positionWatermark);
    resizeObs.observe(wsMain.value);
  }
  positionWatermark();
});
onBeforeUnmount(() => {
  for (const t of LOCK_EVENTS) document.removeEventListener(t, lockGate, true);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('click', onDocClick);
  window.removeEventListener('beforeprint', beforePrint);
  window.removeEventListener('resize', positionWatermark);
  resizeObs?.disconnect();
});
</script>
