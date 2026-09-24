<template>
  <div class="ws-page">
    <!-- index.html's renderWork, translated element for element: the same classes, ids and data-*
         attributes, so legacy.css styles it exactly as it styles the source. -->
    <div class="wk-wrap">
      <!-- Before the first sync there is nothing true to show; the header alone is what both of the
           screen's states begin with, so nothing jumps when the document lands. -->
      <div v-if="!loaded" class="wk-header"><h2>Tasks</h2></div>

      <!-- ===== No unit chosen: the big-button chooser (workChooserHtml) ===== -->
      <template v-else-if="!scope">
        <div class="wk-header"><h2>Tasks</h2></div>
        <div class="wk-choose-wrap">
          <div class="wk-choose">
            <div class="wkc-intro">
              <h3>Whose tasks do you want to see?</h3>
              <p>Pick a directorate, then drill in as deep as you like — division, branch, team. You'll see every chart activity and flow step that lands on that unit, with each task's inputs and outputs.</p>
            </div>
            <div class="wkc-crumbs">
              <template v-for="(c, i) in chooser.crumbs" :key="i">
                <span v-if="c.sep" class="wkc-crumb-sep">▸</span>
                <button
                  v-else
                  class="wkc-crumb"
                  :class="{ current: c.current }"
                  :disabled="c.current || undefined"
                  :data-work-goto="c.current ? undefined : c.goto"
                  @click="goto(c.goto)"
                >{{ c.label }}</button>
              </template>
            </div>
            <div v-if="browse" class="wkc-actions">
              <button class="wkc-back" data-work-back @click="back">◀ Back</button>
              <button
                v-if="chooser.commit"
                class="wkc-see"
                :data-work-see="refStr(chooser.commit.ref)"
                :title="`See every task that lands on ${chooser.commit.name}`"
                @click="see(chooser.commit.ref)"
              >▶ See all tasks for <b>{{ chooser.commit.name }}</b></button>
            </div>
            <div class="wkc-pick-lbl">Pick a {{ chooser.kindLabel.toLowerCase() }}:</div>
            <div v-if="chooser.boxes.length" class="wkc-grid">
              <button
                v-for="box in chooser.boxes"
                :key="refStr(box.ref)"
                :class="['wkc-box', `k-${box.kind}`]"
                :data-work-drill="box.drill ? refStr(box.ref) : undefined"
                :data-work-see="box.drill ? undefined : refStr(box.ref)"
                :title="(box.drill ? 'Open ' : 'See tasks for ') + box.name"
                @click="box.drill ? drill(box.ref) : see(box.ref)"
              >
                <span class="wkc-box-kind">{{ KIND_LABEL[box.kind] }}</span>
                <span class="wkc-box-name">{{ box.name }}</span>
                <span class="wkc-box-stat">{{ box.stat }}</span>
                <span class="wkc-box-go">{{ box.drill ? 'open ▸' : 'see tasks →' }}</span>
              </button>
            </div>
            <div v-else class="wkc-none">No {{ chooser.kindLabel.toLowerCase() }}s here yet.{{ browse ? ' Use “See all tasks” above to see everything that lands on this unit.' : '' }}</div>
          </div>
        </div>
      </template>

      <!-- ===== A unit is chosen: its work orders ===== -->
      <template v-else>
        <div class="wk-header">
          <h2>Tasks</h2>
          <button
            id="wk-restart"
            type="button"
            data-work-restart
            title="Go back to the big picker and choose a different unit"
            @click="restart"
          >↩ Choose a different unit</button>
          <div class="wk-picker">
            <select data-work-scope="directorate" @change="pick('directorate', $event)">
              <option value="">— directorate —</option>
              <option v-for="a in ACTORS" :key="a" :value="a" :selected="a === picker.actor">{{ actorName(a) }}</option>
            </select>
            <select data-work-scope="division" :disabled="!picker.actor" @change="pick('division', $event)">
              <option value="">— whole directorate —</option>
              <option v-for="d in picker.divList" :key="d.id" :value="d.id" :selected="d.id === picker.divId">{{ d.name || 'Untitled division' }}</option>
            </select>
            <select data-work-scope="branch" :disabled="!picker.divId" @change="pick('branch', $event)">
              <option value="">— whole division —</option>
              <option v-for="b in picker.brList" :key="b.id" :value="b.id" :selected="b.id === picker.brId">{{ b.name || 'Untitled branch' }}</option>
            </select>
            <select data-work-scope="team" :disabled="!picker.brId" @change="pick('team', $event)">
              <option value="">— whole branch —</option>
              <option v-for="t in picker.tmList" :key="t.id" :value="t.id" :selected="t.id === picker.tmId">{{ t.name || 'Unnamed team' }}</option>
            </select>
          </div>
          <span class="wk-scope-lbl">{{ scopeLabel?.full || '' }}</span>
          <button id="wk-print" type="button" title="Print this list as the unit's run book" @click="printRunBook">🖨 Run book</button>
        </div>
        <div class="wk-body">
          <div v-for="g in groups" :key="g.key" class="wk-group">
            <h3>{{ g.title }} <span class="wk-count">{{ g.items.length }}</span></h3>
            <div class="wk-hint">{{ g.hint }}</div>
            <div class="wk-cards">
              <div v-for="it in g.items" :key="it.nodeId ?? it.stepId" class="wk-card">
                <div class="wk-card-head">
                  <button
                    v-if="it.kind === 'chartRow'"
                    class="wk-name"
                    type="button"
                    data-charter-jump="1"
                    :data-chart-id="it.chartId"
                    :data-node-id="it.nodeId"
                    title="Jump to it in the chart"
                    @click="jumpToChartNode(it.chartId!, it.nodeId!)"
                  >{{ it.name }}</button>
                  <button
                    v-else
                    class="wk-name"
                    type="button"
                    :data-flow-open="it.flowId"
                    :data-task-id="it.stepId"
                    title="Jump to it in the flow"
                    @click="jumpToFlowStep(it.flowId!, it.stepId!)"
                  >{{ it.name }}</button>
                  <span v-if="it.unit" class="wk-unit" title="Assigned org unit">{{ it.unit }}</span>
                </div>
                <div class="wk-meta">{{ it.where }}</div>
                <div v-if="it.roles.length" class="wk-roles">
                  <span v-for="r in it.roles" :key="r.column" class="wk-role" :class="{ inh: r.inherited }" :title="roleTitle(r)"><span class="wk-role-col">{{ colShort(r.column) }}</span><div class="cell-chips"><span v-for="l in r.letters" :key="l" :class="['raci-chip', l]">{{ l }}</span></div></span>
                </div>
                <div v-if="it.description" class="wk-desc">{{ it.description }}</div>
                <div v-if="it.entry" class="wk-crit"><span class="wk-crit-lbl entry">entry</span>{{ it.entry }}</div>
                <div v-if="it.exit" class="wk-crit"><span class="wk-crit-lbl exit">exit</span>{{ it.exit }}</div>
                <div v-if="it.inputs.length || it.outputs.length" class="wk-io-block">
                  <div v-for="(x, i) in it.inputs" :key="`i${i}`" class="wk-io">⇥ <b>{{ x.name }}</b> <span v-if="x.counterparts.length" class="wk-io-src">from {{ x.counterparts.join(', ') }}</span><span v-else class="wk-io-src none">no producer</span></div>
                  <div v-for="(x, i) in it.outputs" :key="`o${i}`" class="wk-io">↦ <b>{{ x.name }}</b><template v-if="x.counterparts.length">{{ ' ' }}<span class="wk-io-src">to {{ x.counterparts.join(', ') }}</span></template></div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!items.length" class="wk-empty">Nothing lands on this unit yet — assign responsible parties on flow steps, or Division/Branch on chart rows.</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The Tasks screen — index.html's `renderWork` and `workChooserHtml`, with the click handlers the
 * source delegates on `document` (data-work-drill / -see / -goto / -back / -restart, the scope
 * selects, #wk-print, and the two jump links).
 *
 * "What does my unit own" is the question a RACI chart exists to answer and the one it is worst
 * at, because the answer is spread across 800 rows in one document and a dozen steps in another.
 * All of the walking is `collectWork` in core, which is the source's collectWorkItems; this file is
 * the source's markup for it. Read-only by design: a lens over work that is edited where it lives.
 *
 * WHICH UNIT YOU ARE LOOKING AT is yours alone. The source keeps it in `state.workScope`, which it
 * saves in the browser; here it is saved in the browser too (per workspace), never in the shared
 * document — one person's choice of unit must not yank everyone else's screen. How far the chooser
 * is drilled is the source's transient `_workBrowse`: it survives switching screens and resets on
 * reload, exactly as there.
 */
import {
  ACTOR_LABELS_DEFAULT,
  ACTORS,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  OrgRef as OrgRefSchema,
  collectWork,
  unitStat,
  workScopeLabel,
  type Actor,
  type OrgRef,
  type WorkRole,
} from '@raci/core';
import { useActiveChartId, useActiveFlowId, useShell } from '~/composables/useShell';

interface BrowseRef {
  actor: Actor;
  divisionId?: string;
  branchId?: string;
  teamId?: string;
}
type BoxKind = 'dir' | 'div' | 'br' | 'team';

const KIND_LABEL: Record<BoxKind, string> = { dir: 'Directorate', div: 'Division', br: 'Branch', team: 'Team' };

const session = useWorkspaceSession();
const shell = useShell();
const activeChartId = useActiveChartId();
const activeFlowId = useActiveFlowId();
const ws = computed(() => session.workspace.value);

// ---- per-person view state ----------------------------------------------------------------------
const scope = useState<OrgRef | null>(`raci:workScope:${session.workspaceId}`, () => null);
const browse = useState<BrowseRef | null>(`raci:workBrowse:${session.workspaceId}`, () => null);
const restored = useState<boolean>(`raci:workScopeRestored:${session.workspaceId}`, () => false);
const SCOPE_KEY = `raci-work-scope-v1:${session.workspaceId}`;

function saveScope(): void {
  try {
    if (scope.value) localStorage.setItem(SCOPE_KEY, JSON.stringify(scope.value));
    else localStorage.removeItem(SCOPE_KEY);
  } catch { /* private window or blocked storage — the scope just will not survive a reload */ }
}

// Nothing true to show until the document has arrived. An empty workspace never sends an update,
// so a short grace period stands in for "the socket has spoken" there.
const grace = ref(false);
const loaded = computed(() => session.ready.value || grace.value);
onMounted(() => {
  if (!restored.value) {
    restored.value = true;
    try {
      const raw = localStorage.getItem(SCOPE_KEY);
      const parsed = raw ? OrgRefSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) scope.value = parsed.data;
    } catch { /* unreadable — start at the chooser */ }
  }
  setTimeout(() => { grace.value = true; }, 1500);
});

// ---- labels -------------------------------------------------------------------------------------
const actorName = (a: Actor) => ws.value.actorLabels[a] || ACTOR_LABELS_DEFAULT[a];
const colShort = (k: string) =>
  ws.value.columnShort[k] || COL_SHORT_DEFAULT[k as keyof typeof COL_SHORT_DEFAULT] || k;
const colLabel = (k: string) =>
  ws.value.columnLabels[k] || COL_LABELS_DEFAULT[k as keyof typeof COL_LABELS_DEFAULT] || k;
const roleTitle = (r: WorkRole) =>
  colLabel(r.column) + (r.unit ? ` — ${r.unit}${r.inherited ? ' (default from the chart context)' : ''}` : '');

// ---- the roster, as the source's find* helpers see it -------------------------------------------
const divisionsOf = (actor: Actor) => ws.value.roster[actor]?.divisions ?? [];
const findDivision = (actor: Actor, divisionId: string) =>
  divisionsOf(actor).find((d) => d.id === divisionId);
const findBranch = (actor: Actor, divisionId: string, branchId: string) =>
  findDivision(actor, divisionId)?.branches.find((b) => b.id === branchId);

// "|"-joined path, as the source serializes a ref into its data-* attributes.
function refStr(ref: BrowseRef): string {
  return [ref.actor, ref.divisionId, ref.branchId, ref.teamId].filter(Boolean).join('|');
}
function refFromStr(s: string): BrowseRef {
  const [actor, divisionId, branchId, teamId] = s.split('|');
  const r: BrowseRef = { actor: actor as Actor };
  if (divisionId) r.divisionId = divisionId;
  if (branchId) r.branchId = branchId;
  if (teamId) r.teamId = teamId;
  return r;
}
/** normalizeOrgRef: a contiguous path from a real directorate down, or nothing. */
function normalize(ref: BrowseRef | null): OrgRef | null {
  if (!ref || !(ACTORS as readonly string[]).includes(ref.actor)) return null;
  if (!ref.divisionId) return { actor: ref.actor };
  if (!ref.branchId) return { actor: ref.actor, divisionId: ref.divisionId };
  if (!ref.teamId) return { actor: ref.actor, divisionId: ref.divisionId, branchId: ref.branchId };
  return { actor: ref.actor, divisionId: ref.divisionId, branchId: ref.branchId, teamId: ref.teamId };
}

// ---- the chooser --------------------------------------------------------------------------------
interface Box { kind: BoxKind; ref: BrowseRef; name: string; stat: string; drill: boolean }
interface Crumb { sep?: boolean; label?: string; current?: boolean; goto?: string }

const chooser = computed(() => {
  const b = browse.value;
  const crumbs: Crumb[] = [{ label: 'All directorates', current: !b, goto: '' }];
  if (b) {
    crumbs.push({ sep: true });
    const dirCur = !b.divisionId;
    crumbs.push({ label: actorName(b.actor), current: dirCur, goto: b.actor });
    if (b.divisionId) {
      const d = findDivision(b.actor, b.divisionId);
      crumbs.push({ sep: true });
      crumbs.push({ label: d?.name || 'Untitled division', current: !b.branchId, goto: `${b.actor}|${b.divisionId}` });
      if (b.branchId) {
        const br = findBranch(b.actor, b.divisionId, b.branchId);
        crumbs.push({ sep: true });
        crumbs.push({ label: br?.name || 'Untitled branch', current: true });
      }
    }
  }

  const box = (kind: BoxKind, ref: BrowseRef, name: string, drill: boolean): Box => ({
    kind, ref, name, drill, stat: unitStat(ws.value, normalize(ref)),
  });
  let kindLabel: string;
  let boxes: Box[];
  let commit: { ref: BrowseRef; name: string } | null = null;
  if (!b) {
    kindLabel = 'Directorate';
    boxes = ACTORS.map((a) => box('dir', { actor: a }, actorName(a), divisionsOf(a).length > 0));
  } else if (!b.divisionId) {
    kindLabel = 'Division';
    boxes = divisionsOf(b.actor).map((div) =>
      box('div', { actor: b.actor, divisionId: div.id }, div.name || 'Untitled division', div.branches.length > 0));
    commit = { ref: { actor: b.actor }, name: actorName(b.actor) };
  } else if (!b.branchId) {
    const d = findDivision(b.actor, b.divisionId);
    kindLabel = 'Branch';
    boxes = (d?.branches ?? []).map((br) =>
      box('br', { actor: b.actor, divisionId: b.divisionId, branchId: br.id }, br.name || 'Untitled branch', br.teams.length > 0));
    commit = { ref: { actor: b.actor, divisionId: b.divisionId }, name: d?.name || 'this division' };
  } else {
    const br = findBranch(b.actor, b.divisionId, b.branchId);
    kindLabel = 'Team';
    boxes = (br?.teams ?? []).map((tm) =>
      box('team', { actor: b.actor, divisionId: b.divisionId, branchId: b.branchId, teamId: tm.id }, tm.name || 'Unnamed team', false));
    commit = { ref: { actor: b.actor, divisionId: b.divisionId, branchId: b.branchId }, name: br?.name || 'this branch' };
  }
  return { crumbs, kindLabel, boxes, commit };
});

function drill(ref: BrowseRef): void { browse.value = ref; }
function see(ref: BrowseRef): void {
  scope.value = normalize(ref);
  browse.value = null;
  saveScope();
}
function goto(v: string | undefined): void { browse.value = v ? refFromStr(v) : null; }
function back(): void {
  const b = browse.value;
  browse.value = !b ? null
    : b.branchId ? { actor: b.actor, divisionId: b.divisionId }
      : b.divisionId ? { actor: b.actor } : null;
}
/** Back to the chooser, opened one level above the unit you were looking at. */
function restart(): void {
  const s = scope.value;
  const r = s && 'actor' in s ? s : null;
  browse.value = !r ? null
    : r.teamId ? { actor: r.actor, divisionId: r.divisionId, branchId: r.branchId }
      : r.branchId ? { actor: r.actor, divisionId: r.divisionId }
        : r.divisionId ? { actor: r.actor } : null;
  scope.value = null;
  saveScope();
}

// ---- the results --------------------------------------------------------------------------------
const picker = computed(() => {
  const d0 = scope.value && 'actor' in scope.value ? scope.value : null;
  const actor = d0 && (ACTORS as readonly string[]).includes(d0.actor) ? d0.actor : '';
  const divId = actor && d0?.divisionId ? d0.divisionId : '';
  const brId = divId && d0?.branchId ? d0.branchId : '';
  const tmId = brId && d0?.teamId ? d0.teamId : '';
  const divList = actor ? divisionsOf(actor) : [];
  const brList = actor && divId ? findDivision(actor, divId)?.branches ?? [] : [];
  const tmList = actor && divId && brId ? findBranch(actor, divId, brId)?.teams ?? [] : [];
  return { actor, divId, brId, tmId, divList, brList, tmList };
});

/** The cascading scope selects: a level picked clears everything under it. */
function pick(kind: 'directorate' | 'division' | 'branch' | 'team', e: Event): void {
  const val = (e.target as HTMLSelectElement).value;
  const d = (scope.value && 'actor' in scope.value ? scope.value : {}) as Partial<BrowseRef>;
  let next: BrowseRef | null = null;
  if (kind === 'directorate') next = val ? { actor: val as Actor } : null;
  else if (kind === 'division') next = d.actor ? (val ? { actor: d.actor, divisionId: val } : { actor: d.actor }) : null;
  else if (kind === 'branch') {
    next = d.actor && d.divisionId
      ? (val ? { actor: d.actor, divisionId: d.divisionId, branchId: val } : { actor: d.actor, divisionId: d.divisionId })
      : (d as BrowseRef);
  } else {
    next = d.actor && d.divisionId && d.branchId
      ? (val
        ? { actor: d.actor, divisionId: d.divisionId, branchId: d.branchId, teamId: val }
        : { actor: d.actor, divisionId: d.divisionId, branchId: d.branchId })
      : (d as BrowseRef);
  }
  scope.value = normalize(next);
  saveScope();
}

const scopeLabel = computed(() => workScopeLabel(ws.value, scope.value));
const items = computed(() => collectWork(ws.value, scope.value));
const groups = computed(() => {
  const short = scopeLabel.value?.short || 'this unit';
  return [
    {
      key: 'direct',
      title: 'Assigned to your unit',
      hint: `Work assigned to ${short} or a unit inside it.`,
      items: items.value.filter((i) => i.relation === 'direct'),
    },
    {
      key: 'inherited',
      title: 'From your org',
      hint: 'Assigned to a parent organization with no deeper unit named — it lands on everyone under it, including you.',
      items: items.value.filter((i) => i.relation === 'inherited'),
    },
  ].filter((g) => g.items.length > 0);
});

// ---- leaving for the chart or the flow ----------------------------------------------------------
// The source activates the chart and drills to the row (or opens the flow on the step) and flashes
// it. The screen the jump lands on reads which row or step from the query.
function jumpToChartNode(chartId: string, nodeId: string): void {
  const chart = ws.value.charts[chartId];
  if (!chart || !chart.nodes[nodeId]) {
    shell.toast('The linked chart task no longer exists.', 'error');
    return;
  }
  activeChartId.value = chartId;
  void navigateTo({ path: `/w/${session.workspaceId}`, query: { node: nodeId } });
}
function jumpToFlowStep(flowId: string, stepId: string): void {
  if (!ws.value.flows[flowId]) return;
  activeFlowId.value = flowId;
  void navigateTo({ path: `/w/${session.workspaceId}/flow`, query: { step: stepId } });
}

// ---- the run book -------------------------------------------------------------------------------
// The source fills the print-only title band just before the browser lays the page out for print.
// It is the shell's band, but only this screen knows the unit, so the Tasks view fills it itself.
function onBeforePrint(): void {
  const ph = document.getElementById('print-head');
  if (!ph) return;
  document.body.dataset.printStatus = '';
  const title = document.createElement('div');
  title.className = 'ph-title';
  title.textContent = 'Tasks — run book';
  const sub = document.createElement('div');
  sub.className = 'ph-sub';
  sub.textContent = scope.value ? scopeLabel.value?.full || '' : 'No unit selected';
  ph.replaceChildren(title, sub);
}
function printRunBook(): void { window.print(); }
onMounted(() => window.addEventListener('beforeprint', onBeforePrint));
onBeforeUnmount(() => window.removeEventListener('beforeprint', onBeforePrint));
</script>
