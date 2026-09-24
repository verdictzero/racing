<template>
  <div class="ws-page">
    <div class="roster-header">
      <h2>Roster</h2>
      <span class="meta">Org structure under each directorate (shared across workstreams). Divisions, branches, and people are all optional.</span>
      <div class="rost-modes" role="tablist" aria-label="Roster layout">
        <button data-roster-mode="explore" :class="{ active: layout === 'explore' }"
          title="Big boxes — drill directorate → division → branch → team" @click="setLayout('explore')">▦ Explore</button>
        <button data-roster-mode="full" :class="{ active: layout === 'full' }"
          title="The whole org tree at once, everything editable inline" @click="setLayout('full')">☰ Full hierarchy</button>
      </div>
    </div>

    <template v-if="synced">
      <!-- FULL HIERARCHY: every directorate expanded at once, everything editable in place. -->
      <div v-if="layout === 'full'" class="roster-body">
        <!-- Memoised on each directorate's content (see DirectoratePanel): an edit re-renders only
             the directorate it touched. -->
        <RosterDirectoratePanel v-for="a in ACTORS" :key="a" v-memo="[dirSig[a], label(a), !!collapsed[a], canEdit]"
          :actor="a" :directorate="dir(a)" :label="label(a)" :stat="stat({ actor: a })" :collapsed="!!collapsed[a]"
          @toggle="toggleDirectorate(a)" @expand="expandDirectorate(a)" />
      </div>

      <!-- EXPLORE: one tier at a time, as big boxes, under a breadcrumb. -->
      <div v-else class="roster-explore">
        <div class="rost-inner">
          <div class="rost-crumbs">
            <template v-for="(c, i) in crumbs" :key="i">
              <span v-if="i" class="rost-crumb-sep">▸</span>
              <button class="rost-crumb" :class="{ current: c.current }" :disabled="c.current"
                :data-roster-goto="c.current ? undefined : c.goto" @click="goto(c.goto)">{{ c.text }}</button>
            </template>
          </div>

          <!-- Top: the six directorates. A fixed set — nothing to add or delete. -->
          <template v-if="view.level === 'top'">
            <div class="rost-hint">Click a directorate to break it out into its divisions.</div>
            <div class="rost-grid">
              <div v-for="a in ACTORS" :key="a" class="rost-box k-dir" :data-roster-drill="a" tabindex="0" role="button"
                :title="`Open ${label(a)}`" @click="onBoxClick($event, a)" @keydown.enter.self.prevent="goto(a)">
                <span class="rost-box-kind">Directorate</span>
                <span class="rost-box-name">{{ label(a) }}</span>
                <span class="rost-box-stat">{{ stat({ actor: a }) }}</span>
                <span v-if="dir(a).lead?.name" class="rost-box-lead">{{ `AD: ${dir(a).lead?.name}` }}</span>
                <span v-else class="rost-box-lead vacant">AD — vacant</span>
                <span class="rost-box-go">open ▸</span>
              </div>
            </div>
          </template>

          <!-- A directorate: its divisions. -->
          <template v-else-if="view.level === 'dir'">
            <RosterUnitHead level="dir" :actor="view.a" :div-id="null" :br-id="null" :team-id="null" :name="label(view.a)"
              :stat="stat({ actor: view.a })" :lead="view.d.lead" />
            <div class="rost-grid">
              <RosterBox v-for="div in view.d.divisions" :key="div.id" kind="div" :drill="`${view.a}|${div.id}`"
                :name="div.name || 'Untitled division'" :stat="stat({ actor: view.a, divisionId: div.id })"
                :lead="div.chief?.name || ''" del-attr="data-del-division" :del-value="`${view.a}|${div.id}`"
                @open="goto(`${view.a}|${div.id}`)" @delete="edits.deleteDivision(div.id)" />
              <button v-if="canEdit" class="rost-add" :data-add-division="view.a" @click="edits.addDivision(view.a)">+ Add division</button>
            </div>
          </template>

          <!-- A division: its branches. -->
          <template v-else-if="view.level === 'div'">
            <RosterUnitHead level="div" :actor="view.a" :div-id="view.div.id" :br-id="null" :team-id="null"
              :name="view.div.name" :stat="stat({ actor: view.a, divisionId: view.div.id })" :lead="view.div.chief"
              :from-directory="!!view.div.externalId" />
            <div class="rost-grid">
              <RosterBox v-for="br in view.div.branches" :key="br.id" kind="br" :drill="`${view.a}|${view.div.id}|${br.id}`"
                :name="br.name || 'Untitled branch'" :stat="stat({ actor: view.a, divisionId: view.div.id, branchId: br.id })"
                :lead="br.chief?.name || ''" del-attr="data-del-branch" :del-value="`${view.a}|${view.div.id}|${br.id}`"
                @open="goto(`${view.a}|${view.div.id}|${br.id}`)" @delete="edits.deleteBranch(br.id)" />
              <button v-if="canEdit" class="rost-add" :data-add-branch="`${view.a}|${view.div.id}`"
                @click="edits.addBranch(view.a, view.div.id)">+ Add branch</button>
            </div>
          </template>

          <!-- A branch: its teams. -->
          <template v-else-if="view.level === 'br'">
            <RosterUnitHead level="br" :actor="view.a" :div-id="view.div.id" :br-id="view.br.id" :team-id="null"
              :name="view.br.name" :stat="stat({ actor: view.a, divisionId: view.div.id, branchId: view.br.id })"
              :lead="view.br.chief" :from-directory="!!view.br.externalId" />
            <div class="rost-grid">
              <RosterBox v-for="tm in view.br.teams" :key="tm.id" kind="team"
                :drill="`${view.a}|${view.div.id}|${view.br.id}|${tm.id}`" :name="tm.name || 'Unnamed team'"
                :stat="stat({ actor: view.a, divisionId: view.div.id, branchId: view.br.id, teamId: tm.id })"
                :lead="tm.chief?.name || ''" del-attr="data-del-team" :del-value="`${view.a}|${view.div.id}|${view.br.id}|${tm.id}`"
                @open="goto(`${view.a}|${view.div.id}|${view.br.id}|${tm.id}`)" @delete="edits.deleteTeam(tm.id)" />
              <button v-if="canEdit" class="rost-add" :data-add-team="`${view.a}|${view.div.id}|${view.br.id}`"
                @click="edits.addTeam(view.a, view.div.id, view.br.id)">+ Add team</button>
            </div>
          </template>

          <!-- A team: its people — the leaf, so rows rather than boxes. -->
          <template v-else-if="view.level === 'team'">
            <RosterUnitHead level="team" :actor="view.a" :div-id="view.div.id" :br-id="view.br.id" :team-id="view.tm.id"
              :name="view.tm.name" :stat="stat({ actor: view.a, divisionId: view.div.id, branchId: view.br.id, teamId: view.tm.id })"
              :lead="view.tm.chief" :from-directory="!!view.tm.externalId" />
            <div class="rost-people-box">
              <RosterPersonRow v-for="p in view.tm.people" :key="p.id" :actor="view.a" :div-id="view.div.id"
                :br-id="view.br.id" :team-id="view.tm.id" :person="p" />
              <button v-if="canEdit" class="add-person" :data-add-person="`${view.a}|${view.div.id}|${view.br.id}|${view.tm.id}`"
                @click="edits.addPerson(view.tm.id)">+ Add person</button>
            </div>
          </template>
        </div>
      </div>

      <!-- Entities hang off the top level only: inside a drilled-in division they would read as
           though they belonged to it, which is the one thing an entity explicitly does not do. -->
      <section v-if="layout === 'full' || !pick" class="ent-section">
        <div class="ent-sec-head">
          <h3>Entities</h3>
          <span class="ent-sec-note">Parties that are not people and not directorates — boards, committees, vendors, standing teams. Assignable anywhere a directorate is.</span>
        </div>
        <div class="ent-grid">
          <RosterEntityCard v-for="e in entities" :key="e.id" :entity="e" :uses="entityUsesInOrder(ws, e.id)" />
          <button v-if="canEdit" class="rost-add ent-add" data-add-entity="1" @click="edits.addEntity()">+ Add entity</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The Roster — index.html's renderRoster, rosterExploreHtml and the org panels, markup for markup.
 *
 * Two layouts, as in the source: EXPLORE drills directorate → division → branch → team one tier at a
 * time as big boxes under a breadcrumb; FULL HIERARCHY prints all six directorates expanded, with
 * everything editable in place. Both carry the Entities section — the non-person parties (boards,
 * vendors, standing teams) that are peers of a directorate rather than things inside one.
 *
 * WHAT IS THE VIEWER'S AND WHAT IS THE DOCUMENT'S. The roster, the directorate names and the
 * entities are shared content: every edit is a per-unit CRDT write (useRosterEdits) that a colleague
 * sees at once and Undo takes back. Where you are drilled to, which layout you use and which
 * directorates you collapsed are yours alone — the drill path lives for the session (index.html's
 * `_rosterPick`), the layout and the collapsed set persist in this browser as the source's
 * `rosterMode` and `collapsedDirectorates` do.
 *
 * TWO WRITERS, ONE ROSTER. A person editing here and the directory sync write the same data. A
 * unit with an `externalId` came from the directory and a sync will re-assert it, so its name says
 * so on hover; a unit created here has `externalId: null` on purpose, and `reconcile` preserves it.
 */
import { ACTOR_LABELS_DEFAULT, ACTORS, entityUsesInOrder, unitStat, type Actor, type Directorate, type OrgRef } from '@raci/core';
import { useRosterEdits } from '~/composables/roster/edits';

const session = useWorkspaceSession();
const edits = useRosterEdits();
const canEdit = edits.canEdit;

const ws = computed(() => session.workspace.value);
/**
 * Whether the document has arrived. Until it has, the roster would read as six empty, leaderless
 * directorates — a claim about the org rather than a loading state — so nothing below the header
 * renders. A socket that has connected counts, because a brand-new workspace never sends content.
 */
const synced = computed(() => session.ready.value || session.status.value === 'connected');

const EMPTY: Directorate = { lead: null, externalId: null, divisions: [] };
/** index.html always holds all six directorates; a workspace started empty here may hold none yet. */
const dir = (a: Actor): Directorate => ws.value.roster[a] ?? EMPTY;
const label = (a: Actor) => ws.value.actorLabels[a] || ACTOR_LABELS_DEFAULT[a];
const stat = (ref: OrgRef) => unitStat(ws.value, ref);
const entities = computed(() => Object.values(ws.value.entities));
/** Each directorate's content as one string — what the Full hierarchy memoises its panels on. */
const dirSig = computed(() => Object.fromEntries(ACTORS.map((a) => [a, JSON.stringify(dir(a))])) as Record<Actor, string>);

// ---- layout: the viewer's, remembered in this browser -----------------------------------------------
const COOKIE = { maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' as const, path: '/' };
const mode = useCookie<string>('raci-roster-mode', { ...COOKIE, default: () => 'explore' });
const layout = computed<'explore' | 'full'>(() => (mode.value === 'full' ? 'full' : 'explore'));
const setLayout = (next: 'explore' | 'full') => {
  mode.value = next;
};

const collapsed = useCookie<Record<string, boolean>>('raci-roster-collapsed', { ...COOKIE, default: () => ({}) });
function toggleDirectorate(a: Actor) {
  collapsed.value = { ...collapsed.value, [a]: !collapsed.value?.[a] };
}
function expandDirectorate(a: Actor) {
  if (collapsed.value?.[a]) collapsed.value = { ...collapsed.value, [a]: false };
}

// ---- where Explore is drilled: the viewer's, for this session ---------------------------------------
interface RosterPick {
  actor: Actor;
  divisionId?: string;
  branchId?: string;
  teamId?: string;
}

function pickFromStr(s: string): RosterPick | null {
  const [actor, divisionId, branchId, teamId] = s.split('|');
  if (!actor || !(ACTORS as readonly string[]).includes(actor)) return null;
  const p: RosterPick = { actor: actor as Actor };
  if (divisionId) p.divisionId = divisionId;
  if (branchId) p.branchId = branchId;
  if (teamId) p.teamId = teamId;
  return p;
}

/** Trim a pick to its deepest unit that still exists — a delete, here or by a colleague, backs out. */
function normalizePick(p: RosterPick | null): RosterPick | null {
  if (!p || !ACTORS.includes(p.actor)) return null;
  const out: RosterPick = { actor: p.actor };
  const division = p.divisionId ? dir(p.actor).divisions.find((d) => d.id === p.divisionId) : undefined;
  if (division) {
    out.divisionId = division.id;
    const branch = p.branchId ? division.branches.find((b) => b.id === p.branchId) : undefined;
    if (branch) {
      out.branchId = branch.id;
      const team = p.teamId ? branch.teams.find((t) => t.id === p.teamId) : undefined;
      if (team) out.teamId = team.id;
    }
  }
  return out;
}

const rawPick = useState<RosterPick | null>(`raci:rosterPick:${session.workspaceId}`, () => null);
const pick = computed(() => (synced.value ? normalizePick(rawPick.value) : null));
// The trim sticks, as the source's does: a unit that comes back (an undo) does not drag you back in.
watch(pick, (p) => {
  if (synced.value && JSON.stringify(p) !== JSON.stringify(rawPick.value)) rawPick.value = p;
});

const goto = (v: string) => {
  rawPick.value = v ? pickFromStr(v) : null;
};
function onBoxClick(e: MouseEvent, v: string) {
  const t = e.target as Element;
  if (t.closest('button') || t.closest('[contenteditable="true"]')) return;
  goto(v);
}

/** The drilled-in unit, resolved once for the template. */
const view = computed(() => {
  const p = pick.value;
  if (!p) return { level: 'top' as const };
  const a = p.actor;
  const d = dir(a);
  const div = p.divisionId ? d.divisions.find((x) => x.id === p.divisionId) : undefined;
  if (!div) return { level: 'dir' as const, a, d };
  const br = p.branchId ? div.branches.find((x) => x.id === p.branchId) : undefined;
  if (!br) return { level: 'div' as const, a, div };
  const tm = p.teamId ? br.teams.find((x) => x.id === p.teamId) : undefined;
  if (!tm) return { level: 'br' as const, a, div, br };
  return { level: 'team' as const, a, div, br, tm };
});

const crumbs = computed(() => {
  const p = pick.value;
  const out = [{ text: 'All directorates', goto: '', current: !p }];
  if (!p) return out;
  out.push({ text: label(p.actor), goto: p.actor, current: !p.divisionId });
  if (!p.divisionId) return out;
  const div = dir(p.actor).divisions.find((d) => d.id === p.divisionId);
  out.push({ text: div?.name || 'Untitled division', goto: `${p.actor}|${p.divisionId}`, current: !p.branchId });
  if (!p.branchId) return out;
  const br = div?.branches.find((b) => b.id === p.branchId);
  out.push({ text: br?.name || 'Untitled branch', goto: `${p.actor}|${p.divisionId}|${p.branchId}`, current: !p.teamId });
  if (!p.teamId) return out;
  const tm = br?.teams.find((t) => t.id === p.teamId);
  out.push({ text: tm?.name || 'Unnamed team', goto: '', current: true });
  return out;
});
</script>
