<template>
  <!-- index.html's #bz-party-panel lives outside #ws-main, in the shell; its head is static and its
       body is renderBizPartyPanel's. Teleported in once the shell's aside exists. -->
  <ClientOnly>
    <Teleport to="#bz-party-panel">
      <div class="bzp-head">
        <h3>Responsible Party</h3>
        <button id="bz-party-close" type="button" title="Close panel (Esc)" aria-label="Close panel" @click="chrome.closeParty()">×</button>
      </div>
      <div id="bz-party-body" @change="onSelect">
        <template v-if="view">
          <div class="bzp-context">
            <div v-if="!view.letters" class="cell-chips empty">·</div>
            <div v-else class="cell-chips"><span v-for="l in view.letters.split('')" :key="l" class="raci-chip" :class="l">{{ l }}</span></div>
            <div class="bzp-ctx-text">
              <div class="bzp-ctx-role">{{ chrome.colLabel(view.col) }}</div>
              <div class="bzp-ctx-task">{{ view.roleDesc }} · {{ view.step.name || 'Untitled task' }}</div>
            </div>
          </div>
          <div v-if="view.src" class="bzp-src" :title="view.src.crumb">⛓ role from the linked {{ view.src.tier }} row <b>{{ view.src.name }}</b></div>
          <div v-else-if="view.overridden" class="bzp-src is-override">± column overridden on this step — the linked row is not driving it</div>
          <div class="bzp-field">
            <label>Party</label>
            <select data-bz-party-sel="kind" title="Where this party comes from">
              <option value="org" :selected="!isEnt">Directorate — a unit in the roster</option>
              <option value="entity" :selected="isEnt">Entity — board, vendor, standing team</option>
            </select>
          </div>
          <template v-if="isEnt">
            <div class="bzp-field">
              <label>Entity</label>
              <select data-bz-party-sel="entity" :disabled="!entities.length">
                <option value="">— select entity —</option>
                <option v-for="e in entities" :key="e.id" :value="e.id" :selected="e.id === draftEntity">{{ `${entityKindMeta(e.kind).icon}  ${e.name?.trim() || 'Untitled entity'}` }}</option>
              </select>
            </div>
            <div v-if="!entities.length" class="bzp-none">No entities yet — the Roster view has an <b>Entities</b> section at the bottom where boards, committees and vendors are created.</div>
          </template>
          <template v-else>
            <div class="bzp-field">
              <label>Directorate</label>
              <select data-bz-party-sel="directorate">
                <option value="">— select directorate —</option>
                <option v-for="k in ACTORS" :key="k" :value="k" :selected="k === pick.actor">{{ labels.actorLabel(k) }}</option>
              </select>
            </div>
            <div class="bzp-field">
              <label>Division</label>
              <select data-bz-party-sel="division" :disabled="!pick.actor">
                <option value="">— whole directorate —</option>
                <option v-for="d in divisions" :key="d.id" :value="d.id" :selected="d.id === pick.divisionId">{{ d.name || 'Untitled division' }}</option>
              </select>
            </div>
            <div class="bzp-field">
              <label>Branch</label>
              <select data-bz-party-sel="branch" :disabled="!pick.divisionId">
                <option value="">— whole division —</option>
                <option v-for="b in branches" :key="b.id" :value="b.id" :selected="b.id === pick.branchId">{{ b.name || 'Untitled branch' }}</option>
              </select>
            </div>
            <div class="bzp-field">
              <label>Team</label>
              <select data-bz-party-sel="team" :disabled="!pick.branchId">
                <option value="">— whole branch —</option>
                <option v-for="tm in teams" :key="tm.id" :value="tm.id" :selected="tm.id === pick.teamId">{{ tm.name || 'Unnamed team' }}</option>
              </select>
            </div>
          </template>
          <div class="bzp-preview" :class="{ set: !!preview }">{{ preview ? preview.full
            : isEnt ? 'No entity selected yet — pick one above.' : 'No party selected yet — scrub the hierarchy above.' }}</div>
          <div class="bzp-actions">
            <button id="bz-party-assign" type="button" data-bz-party-assign="1" :disabled="!previewRef" @click="assign">Assign</button>
            <button id="bz-party-clear" type="button" data-bz-party-clear="1" :disabled="!view.committed" @click="clear">Clear</button>
          </div>
        </template>
      </div>
    </Teleport>
  </ClientOnly>
</template>

<script setup lang="ts">
/**
 * The Responsible Party panel — index.html's openBizPartyPanel / renderBizPartyPanel /
 * bizPartyAssign / bizPartyClear. One (step, column) at a time: scrub directorate → division →
 * branch → team, or pick an entity, and commit it as the step's party for that column.
 *
 * The canvas opens it by setting useFlowScreen().partyTarget. The draft is seeded here from the
 * committed party — or, on an anchored or Chart-Linked flow with none, from the dashed default the
 * card is already showing — and the panel shows by body.show-bz-party, as the source toggles it.
 */
import { ACTORS, entitiesInOrder, entityKindMeta, framework, type ColKey, type Flow, type OrgRef } from '@raci/core';
import { normalizeOrgRef } from '~/composables/useFlowChrome';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const screen = chrome.screen;
const shell = useShell();
const labels = useLabels();
const { partyTarget: target, partyDraft: draft } = screen;

/** bizPartyKind — which half of the picker shows. Kept beside the draft, so "Entity" holds while
 *  no entity is picked yet. */
const kind = useState<'org' | 'entity'>('raci:flow:partyKind', () => 'org');
const isEnt = computed(() => kind.value === 'entity');

// openBizPartyPanel: every time the target changes, the draft is seeded afresh.
watch(target, (t) => {
  if (!t) return;
  const found = chrome.locate(t.taskId);
  if (!found) return;
  const own = found.step.parties[t.col];
  draft.value = own ? { ...own } : chrome.defaultParty(found.flow, found.step, t.col);
  kind.value = draft.value && 'entityId' in draft.value ? 'entity' : 'org';
}, { immediate: true });

// The step's committed party moved under the panel — an assign, a clear, an undo, a colleague: the
// draft follows it, as index.html's history restore re-seeds it (from the committed party only).
const committedKey = computed(() => {
  const t = target.value;
  const found = t ? chrome.locate(t.taskId) : null;
  return t ? `${t.taskId}|${t.col}|${JSON.stringify(found?.step.parties[t.col] ?? null)}` : '';
});
watch(committedKey, (now, was) => {
  const t = target.value;
  if (!t || !was || now.split('|', 2).join('|') !== was.split('|', 2).join('|')) return;
  const found = chrome.locate(t.taskId);
  if (!found) return;
  const own = found.step.parties[t.col];
  draft.value = own ? { ...own } : null;
});
// A step that is gone takes its panel with it (renderBizPartyPanel's closeBizPartyPanel).
watch(() => (target.value ? !!chrome.locate(target.value.taskId) : true), (there) => { if (!there) chrome.closeParty(); });

// body.show-bz-party, merged with the shell's own body classes.
useHead({ bodyAttrs: { class: computed(() => (target.value ? 'show-bz-party' : '')) } });
// index.html's setViewMode: the panel is not carried into another view.
onBeforeUnmount(() => chrome.closeParty());

/** What the panel draws — renderBizPartyPanel. Null when there is nothing to draw. */
const view = computed(() => {
  const t = target.value;
  if (!t) return null;
  const found = chrome.locate(t.taskId);
  if (!found) return null;
  const { flow: b, step } = found;
  const cell = chrome.lint.value.stepRaci(b, step)[t.col as ColKey];
  const letters = cell?.letters ?? '';
  const F = framework(b.framework);
  const roleDesc = letters ? letters.split('').map((l) => F.meta[l]?.label ?? l).join(' + ') : 'No role letters set';
  // On a bound step, say where the role came from: the party picked here executes a role the chart
  // assigned, and this is the one place that context is not already on screen.
  const bind = chrome.isLinked(b) ? chrome.bindInfo(step) : null;
  const src = cell?.from === 'chart' && bind
    ? { crumb: bind.crumb.join(' › '), tier: bind.tierLabel.toLowerCase(), name: bind.node.name || '(untitled)' }
    : null;
  return {
    flow: b,
    step,
    col: t.col,
    letters,
    roleDesc,
    src,
    overridden: !src && !!bind && step.bindOverrides.includes(t.col),
    committed: !!step.parties[t.col],
  };
});

// The draft, read the way the selects read it: each level only while the one above is set.
const pick = computed(() => {
  const d = (draft.value ?? {}) as Record<string, string | undefined>;
  const actor = d.actor && (ACTORS as readonly string[]).includes(d.actor) ? d.actor : '';
  const divisionId = actor && d.divisionId ? d.divisionId : '';
  const branchId = divisionId && d.branchId ? d.branchId : '';
  const teamId = branchId && d.teamId ? d.teamId : '';
  return { actor, divisionId, branchId, teamId };
});
const draftEntity = computed(() => (draft.value && 'entityId' in draft.value ? draft.value.entityId : ''));
const divisions = computed(() => (pick.value.actor ? chrome.ws.value.roster[pick.value.actor as (typeof ACTORS)[number]]?.divisions ?? [] : []));
const branches = computed(() => (pick.value.divisionId ? divisions.value.find((d) => d.id === pick.value.divisionId)?.branches ?? [] : []));
const teams = computed(() => (pick.value.branchId ? branches.value.find((b) => b.id === pick.value.branchId)?.teams ?? [] : []));
const entities = computed(() => entitiesInOrder(chrome.ws.value));
/** The ref the selects currently spell out — what Assign would commit. */
const previewRef = computed<OrgRef | null>(() => {
  if (isEnt.value) return draftEntity.value ? { entityId: draftEntity.value } : null;
  const p = pick.value;
  if (!p.actor) return null;
  return normalizeOrgRef({ actor: p.actor, divisionId: p.divisionId, branchId: p.branchId, teamId: p.teamId });
});
const preview = computed(() => chrome.partyLabel(previewRef.value));

/** The cascading selects (index.html's change listener on [data-bz-party-sel]). */
function onSelect(e: Event): void {
  const sel = (e.target as Element).closest?.<HTMLSelectElement>('[data-bz-party-sel]');
  if (!sel || !target.value) return;
  // The panel is still showing a step of a flow just left: its next repaint closes it.
  if (!chrome.stepOf(target.value.taskId)) { chrome.closeParty(); return; }
  // renderBizPartyPanel rebuilds the panel after every pick, and the select's focus goes with it.
  sel.blur();
  const k = sel.dataset.bzPartySel, val = sel.value;
  const d = (draft.value ?? {}) as Record<string, string | undefined>;
  if (k === 'kind') {
    // Switching halves discards the other half's draft: a directorate and a board are not two
    // spellings of the same party.
    kind.value = val === 'entity' ? 'entity' : 'org';
    draft.value = null;
    return;
  }
  let next: Record<string, string | undefined> | null = d;
  if (k === 'entity') next = val ? { entityId: val } : null;
  else if (k === 'directorate') next = val ? { actor: val } : null;
  else if (k === 'division') next = val ? { actor: d.actor, divisionId: val } : d.actor ? { actor: d.actor } : null;
  else if (k === 'branch') {
    next = d.actor && d.divisionId
      ? val ? { actor: d.actor, divisionId: d.divisionId, branchId: val } : { actor: d.actor, divisionId: d.divisionId }
      : d;
  } else if (k === 'team') {
    next = d.actor && d.divisionId && d.branchId
      ? val ? { actor: d.actor, divisionId: d.divisionId, branchId: d.branchId, teamId: val } : { actor: d.actor, divisionId: d.divisionId, branchId: d.branchId }
      : d;
  }
  draft.value = next as OrgRef | null;
}

/** bizPartyAssign. */
function assign(): void {
  const t = target.value;
  if (!t) return;
  const step = chrome.stepOf(t.taskId);
  if (!step || !props.flow) { chrome.closeParty(); return; }
  const ref = normalizeOrgRef(draft.value);
  if (!ref) { shell.toast('Pick at least a directorate first.', 'error'); return; }
  if (!props.canEdit) return;
  // A Final flow: index.html writes, rolls back in saveState (and says so), then announces the pick
  // anyway — both toasts show there, so both show here.
  if (!chrome.refusedByLock(props.flow)) chrome.setParty(step.id, t.col, ref);
  const lbl = chrome.partyLabel(ref);
  shell.toast(`${chrome.colShort(t.col)} → ${lbl ? lbl.short : 'party set'}`);
}
/** bizPartyClear. */
function clear(): void {
  const t = target.value;
  if (!t) return;
  const step = chrome.stepOf(t.taskId);
  if (!step || !props.flow) { chrome.closeParty(); return; }
  if (!props.canEdit) return;
  if (!chrome.refusedByLock(props.flow)) chrome.setParty(step.id, t.col, null);
  draft.value = null; // cleared before index.html's saveState, so a rollback leaves it cleared too
}
</script>
