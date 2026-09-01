<template>
  <!-- Fixed, and painted OVER the chart pane rather than behind it — see the note in shell.css.
       Outside #app-frame exactly as in index.html, so its stacking is not trapped in the grid. -->
  <img id="bg-watermark" src="/asic-emblem.png" alt="" aria-hidden="true">

  <div id="app-frame">
    <header>
      <!-- LEFT RAIL. The grouping is the information architecture, not decoration: Chart, Roster
           and Tasks are three modes of ONE system and share a box; Task Flows and the Object
           Gallery are separate systems and get their own. -->
      <div id="view-tabs" class="view-tabs">
        <span class="vt-heading">Mode</span>

        <div class="vt-box vt-box--raci" data-box="raci">
          <span class="vt-box-label">RACI Chart</span>
          <button :class="{ active: view === 'chart' }" @click="go('')">Chart</button>
          <button :class="{ active: view === 'roster' }" @click="go('/roster')">Roster</button>
          <button
            :class="{ active: view === 'work' }"
            title="Pick an org unit and see every chart row and flow step that lands on it — with each task's inputs and outputs"
            @click="go('/tasks')"
          >Tasks</button>
        </div>

        <div class="vt-box vt-box--flow" data-box="flow">
          <span class="vt-box-label">Task Flows</span>
          <button
            :class="{ active: view === 'bizcase' }"
            title="Business Case Task Flow — a separate system: steps wired into a graph, run either Chart-Linked (every step names the chart row it implements) or Free-Form"
            @click="go('/flow')"
          >
            <span class="vt-lg">Business Case Task Flow</span><span class="vt-sm">Biz Case</span>
          </button>
        </div>

        <span class="vt-sep vt-sep--obj" aria-hidden="true" />

        <div class="vt-box vt-box--obj" data-box="obj">
          <span class="vt-box-label">Objects</span>
          <button
            :class="{ active: view === 'objects' }"
            title="Every named thing in the workspace — deliverables that move between steps, and entities that act as parties"
            @click="go('/objects')"
          >
            <span class="vt-lg">Object Gallery</span><span class="vt-sm">Objects</span>
          </button>
        </div>

        <span class="vt-sep" aria-hidden="true" />

        <button class="tab-help" title="Back to the workspace list" @click="navigateTo('/')">
          <span class="vt-help-ico" aria-hidden="true">←</span>Workspaces
        </button>
      </div>

      <!-- RIGHT RAIL. -->
      <div id="tool-rail">
        <div id="brand-zone">
          <img id="app-logo" src="/asic-emblem.png" alt="ASIC — Army Software &amp; Innovation Center"
            title="ASIC — Army Software &amp; Innovation Center">
          <div id="app-brand" title="ASIC RACI Tool">
            <span class="brand-name">ASIC RACI Tool</span>
            <span class="brand-ver">ver {{ VERSION }}</span>
          </div>
        </div>

        <div class="actions">
          <!-- The legacy Save downloads the v0.39 file. Here the document is already durable, so
               the button keeps its meaning rather than its mechanism: it hands you the same file,
               which is what makes adopting the server version a two-way door. -->
          <button id="btn-export" title="Download this workspace as the v0.39 JSON file index.html reads"
            @click="download('json')">💾 Save a copy</button>

          <span class="actions-divider" aria-hidden="true" />

          <div class="export-menu" :class="{ open: exportOpen }">
            <button id="btn-export-menu" type="button" aria-haspopup="true" :aria-expanded="exportOpen"
              title="Export the matrix as a document" @click="exportOpen = !exportOpen">
              ⭳ Export <span class="em-caret" aria-hidden="true">▾</span>
            </button>
            <div class="export-menu-list" role="menu" aria-label="Export options" :hidden="!exportOpen">
              <button class="em-item" role="menuitem" type="button" @click="download('xlsx')">
                <span class="em-ico">📗</span><span class="em-label">Excel</span><span class="em-ext">.xlsx</span>
              </button>
              <button class="em-item" role="menuitem" type="button" @click="download('template')">
                <span class="em-ico">📋</span><span class="em-label">Blank template</span><span class="em-ext">.xlsx</span>
              </button>
              <button class="em-item" role="menuitem" type="button" @click="download('xml')">
                <span class="em-ico">📄</span><span class="em-label">XML</span><span class="em-ext">.xml</span>
              </button>
              <button class="em-item" role="menuitem" type="button" @click="download('mermaid')">
                <span class="em-ico">🧭</span><span class="em-label">Mermaid</span><span class="em-ext">.mmd</span>
              </button>
            </div>
          </div>

          <span class="actions-divider" aria-hidden="true" />

          <button :disabled="!canEdit" title="Undo your own last change — not anyone else's"
            @click="session.undo.undo()">↶ Undo</button>

          <span class="actions-divider" aria-hidden="true" />

          <div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Appearance theme">
            <span class="ts-label" aria-hidden="true">Theme</span>
            <button v-for="opt in THEME_OPTIONS.slice(0, 2)" :key="opt.id" type="button" class="ts-opt"
              role="radio" :aria-checked="theme === opt.id" :title="opt.title" @click="setTheme(opt.id)">
              <span class="ts-ico" aria-hidden="true">{{ opt.icon }}</span>{{ opt.label }}
            </button>
            <span class="ts-label ts-label--hc" aria-hidden="true">High contrast</span>
            <button v-for="opt in THEME_OPTIONS.slice(2)" :key="opt.id" type="button" class="ts-opt"
              role="radio" :aria-checked="theme === opt.id" :aria-label="opt.aria" :title="opt.title"
              @click="setTheme(opt.id)">
              <span class="ts-ico" aria-hidden="true">{{ opt.icon }}</span>{{ opt.label }}
            </button>
          </div>

          <span class="actions-divider" aria-hidden="true" />

          <div class="rail-who">
            <span class="rw-name">{{ me?.user?.displayName }}</span>
            <span class="rw-role">{{ me?.user?.role }}</span>
            <span class="rw-live" :data-state="session.status.value" :title="statusTitle">{{ statusLabel }}</span>
            <span v-if="session.peers.value > 1" class="rw-peers">{{ session.peers.value }} here</span>
          </div>
          <button class="rw-out" title="Sign out" @click="signOut">Sign out</button>
        </div>
      </div>
    </header>

    <!-- The chart tab strip spans the full width above both rails, as in index.html. -->
    <div id="chart-tabs" role="tablist" aria-label="RACI chart tabs">
      <div v-for="chart in chartTabs" :key="chart.id" class="chart-tab"
        :class="{ active: chart.id === activeChartId, 'is-only': chartTabs.length === 1 }"
        :data-status="chart.status" role="tab" :aria-selected="chart.id === activeChartId"
        :title="`${chart.status === 'final' ? 'Final' : 'Draft'} — click to switch`"
        @click="activeChartId = chart.id">
        <span class="tab-status">{{ chart.status === 'final' ? 'FINAL' : 'DRAFT' }}</span>
        <span class="tab-label">{{ chart.title || '(untitled chart)' }}</span>
      </div>
      <div class="chart-fw" title="Responsibility framework for this chart — RASCI adds a Support role">
        <span class="cf-label">Framework</span>
        <select :value="activeChart?.framework ?? 'raci'" disabled>
          <option value="raci">RACI</option>
          <option value="rasci">RASCI</option>
        </select>
      </div>
    </div>

    <!-- The crumb band. Filled by the chart screen through `raci:crumbs`; CSS hides it on every
         other view via body[data-view]. -->
    <div id="drill-crumbs">
      <template v-for="(crumb, i) in crumbs" :key="crumb.id">
        <span v-if="i" class="crumb-sep" aria-hidden="true">›</span>
        <button class="crumb" :class="[`t${Math.min(crumb.tier, 3)}`, { current: i === crumbs.length - 1 }]"
          @click="crumbNav(i)">
          <span class="crumb-tier">{{ crumb.tier === 0 ? 'Portfolios' : crumb.tierName }}</span>
          <span class="crumb-name">{{ crumb.name }}</span>
        </button>
      </template>
    </div>

    <main><NuxtPage /></main>
  </div>
</template>

<script setup lang="ts">
/**
 * The workspace shell.
 *
 * Owns the collaborative session and the frame every screen inside a workspace shares. The DOM here
 * deliberately mirrors `index.html` — same ids, same class names, same nesting — because the CSS in
 * `assets/css/shell.css` is that app's, ported rather than rewritten. Changing the shape of this
 * markup without changing that stylesheet will silently un-style the frame.
 *
 * WHAT IS NOT IN THE RAIL, and why. The legacy rail also carries Save/Load/Merge, Ingest Kit, Auto
 * Arrange, Details, Legend, Print/PDF, PowerPoint, Demo and Clear. Load, Merge, Demo and Clear are
 * artefacts of a localStorage app — here the document is durable, shared, and reached by URL, so
 * "replace everything in this browser" has no meaning. The rest are simply not ported yet
 * (docs/dev/PORTING.md). A button that looks live and does nothing is worse than an absent one, so
 * they are absent until they work.
 *
 * `canEdit` is a UI affordance, never the enforcement. The server checks the role on every write
 * (`requireRole`), because a disabled button stops nobody who can open a console.
 */
import type { ThemeName } from '~/composables/useTheme';
import { CRUMB_KEY, type Crumb } from '~/composables/useCrumbs';

/** Shown in the brand block. Tracks the document format, which is why it is not the package version. */
const VERSION = '0.39 alpha';

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

// ---- which screen is up -------------------------------------------------------------------------
// The legacy view names, not the route names: body[data-view] drives the watermark, the crumb band
// and the chart screen's background wash, and those selectors came across with the stylesheet.
const view = computed(() => {
  const path = route.path.replace(`/w/${workspaceId}`, '');
  if (path.startsWith('/roster')) return 'roster';
  if (path.startsWith('/tasks')) return 'work';
  if (path.startsWith('/flow')) return 'bizcase';
  if (path.startsWith('/objects')) return 'objects';
  return 'chart';
});
useHead({ bodyAttrs: { 'data-view': view } });

const go = (suffix: string) => navigateTo(`/w/${workspaceId}${suffix}`);

// ---- chart tabs ---------------------------------------------------------------------------------
// The shell owns which chart is open, so the strip and the screen cannot disagree.
const chartTabs = computed(() => {
  const ws = session.workspace.value;
  const order = Object.entries(ws.chartOrder ?? {})
    .sort(([, a], [, b]) => String(a).localeCompare(String(b)))
    .map(([id]) => id);
  const ids = order.length ? order : Object.keys(ws.charts);
  return ids.map((id) => ws.charts[id]).filter((c): c is NonNullable<typeof c> => Boolean(c));
});
const activeChartId = useState<string | null>('raci:activeChartId', () => null);
const activeChart = computed(() =>
  chartTabs.value.find((c) => c.id === activeChartId.value) ?? chartTabs.value[0] ?? null,
);
// A chart someone else deleted must not leave the strip pointing at nothing.
watch(chartTabs, (list) => {
  if (!list.some((c) => c.id === activeChartId.value)) activeChartId.value = list[0]?.id ?? null;
}, { immediate: true });
provide('raci:activeChartId', activeChartId);

// ---- the crumb band -----------------------------------------------------------------------------
// Rendered here because it is a full-width band above both rails, but only the chart screen knows
// the drill path, so that screen fills these in.
const crumbs = ref<Crumb[]>([]);
const crumbNav = ref<(index: number) => void>(() => {});
provide(CRUMB_KEY, { crumbs, crumbNav });

// ---- status -------------------------------------------------------------------------------------
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
    : 'Connected to the collaboration server',
);

// ---- rail actions -------------------------------------------------------------------------------
const exportOpen = ref(false);
function download(format: 'json' | 'xml' | 'mermaid' | 'xlsx' | 'template'): void {
  exportOpen.value = false;
  const chart = activeChart.value ? `&chartId=${encodeURIComponent(activeChart.value.id)}` : '';
  // A plain navigation, so the browser's own download UI handles it and a large workbook never
  // sits in memory twice.
  location.href = `/api/workspaces/${workspaceId}/export?format=${format}${chart}`;
}

async function signOut() {
  const result = await $fetch<{ endSessionUrl: string | null }>('/api/auth/logout', { method: 'POST' });
  // Ending only the local session leaves the IdP's cookie in place, so the next sign-in walks
  // straight back in without a prompt — which looks exactly like the logout failed.
  location.href = result.endSessionUrl ?? '/';
}
</script>

<style scoped>
/* Only what the legacy stylesheet has no equivalent for: this rebuild has a signed-in user and a
   live connection to report, and the single-file app had neither. */
.rail-who {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  width: 100%;
  padding: 2px 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.rw-name { color: var(--text); font-weight: 600; }
.rw-role,
.rw-live,
.rw-peers {
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 0 6px;
  line-height: 1.6;
}
.rw-live[data-state='connected'] { color: var(--ok, #51cf66); border-color: rgba(var(--ok-rgb, 81, 207, 102), 0.5); }
.rw-live[data-state='offline'] { color: var(--warn); border-color: rgba(var(--warn-rgb), 0.5); }
.rw-out { width: 100%; }
</style>
