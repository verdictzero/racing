<template>
  <div class="rost">
    <div class="rost-head">
      <div>
        <h2>Roster</h2>
        <p class="meta">
          The org structure under each directorate, shared across every chart and flow.
          Divisions, branches, teams and people are all optional.
        </p>
      </div>
      <button v-if="canEdit" class="rost-sync" :disabled="syncing" @click="runSync">
        {{ syncing ? 'Syncing…' : '⟳ Sync from directory' }}
      </button>
    </div>

    <p v-if="syncMessage" class="rost-sync-msg" :class="{ bad: syncFailed }">{{ syncMessage }}</p>

    <nav class="rost-crumbs" aria-label="Roster location">
      <button :disabled="!path.length" @click="drill([])">All directorates</button>
      <template v-for="(crumb, i) in crumbs" :key="crumb.id">
        <span class="sep">▸</span>
        <button :disabled="i === crumbs.length - 1" @click="drill(path.slice(0, i + 1))">
          {{ crumb.name }}
        </button>
      </template>
    </nav>

    <!-- Top level: the six directorates. Fixed — they cannot be added or deleted. -->
    <template v-if="!current">
      <p class="rost-hint">Click a directorate to break it out into its divisions.</p>
      <div class="rost-grid">
        <div
          v-for="d in directorates"
          :key="d.id"
          class="rost-box k-directorate"
          tabindex="0"
          role="button"
          @click="drill([d.id])"
          @keydown.enter.prevent="drill([d.id])"
        >
          <span class="rost-box-kind">Directorate</span>
          <span class="rost-box-name">{{ d.name }}</span>
          <span class="rost-box-stat">{{ d.stat }}</span>
          <span class="rost-box-lead" :class="{ vacant: !d.lead }">
            {{ d.lead ? `AD: ${d.lead}` : 'AD — vacant' }}
          </span>
          <span class="rost-box-go">open ▸</span>
        </div>
      </div>
    </template>

    <!-- A drilled-in unit: its own header, then its children as boxes. -->
    <template v-else>
      <div class="rost-unit-head">
        <div class="rost-uh-top">
          <span class="rost-uh-kind">{{ kindLabel(current.kind) }}</span>
          <input
            v-if="current.kind !== 'directorate'"
            class="rost-uh-name"
            :value="current.name"
            :disabled="!canEdit"
            :placeholder="`Untitled ${current.kind}`"
            @change="rename(current!.id, ($event.target as HTMLInputElement).value)"
          >
          <h3 v-else class="rost-uh-name static">{{ currentLabel }}</h3>
          <span class="rost-uh-stat">{{ currentStat }}</span>
        </div>

        <div class="rost-uh-lead">
          <template v-if="current.leadId">
            <span class="lead-badge">{{ leadRole(current.kind) }}</span>
            <input
              class="lead-name"
              :value="current.leadName"
              :disabled="!canEdit"
              placeholder="Name"
              @change="setLeadName(($event.target as HTMLInputElement).value)"
            >
            <button v-if="canEdit" class="del-icon" title="Remove" @click="clearLead">×</button>
          </template>
          <button v-else-if="canEdit" class="add-lead" @click="addLead">
            + Add {{ leadRole(current.kind) }}
          </button>
        </div>
      </div>

      <!-- A team's people are rows, not boxes: they carry a title and there is nothing to drill into. -->
      <div v-if="current.kind === 'team'" class="rost-people">
        <div v-for="person in children" :key="person.id" class="rost-person">
          <input
            class="p-name"
            :value="person.name"
            :disabled="!canEdit"
            placeholder="Name"
            @change="rename(person.id, ($event.target as HTMLInputElement).value)"
          >
          <input
            class="p-title"
            :value="person.title"
            :disabled="!canEdit"
            placeholder="Title"
            @change="setField(person.id, 'title', ($event.target as HTMLInputElement).value)"
          >
          <span v-if="person.externalId" class="p-src" title="Comes from the directory — a sync will re-assert it">
            directory
          </span>
          <button v-if="canEdit" class="del-icon" title="Remove" @click="remove(person.id)">×</button>
        </div>
        <button v-if="canEdit" class="rost-add" @click="add()">+ Add person</button>
        <p v-if="!children.length && !canEdit" class="rost-empty">No people recorded.</p>
      </div>

      <div v-else class="rost-grid">
        <div
          v-for="child in children"
          :key="child.id"
          class="rost-box"
          :class="`k-${child.kind}`"
          tabindex="0"
          role="button"
          @click="drill([...path, child.id])"
          @keydown.enter.prevent="drill([...path, child.id])"
        >
          <button
            v-if="canEdit"
            class="rost-box-del del-icon"
            :title="`Delete ${child.kind}`"
            @click.stop="remove(child.id)"
          >×</button>
          <span class="rost-box-kind">{{ kindLabel(child.kind) }}</span>
          <span class="rost-box-name">{{ child.name || `Untitled ${child.kind}` }}</span>
          <span class="rost-box-stat">{{ statFor(child) }}</span>
          <span v-if="child.leadName" class="rost-box-lead">
            {{ leadRole(child.kind) }}: {{ child.leadName }}
          </span>
          <span class="rost-box-go">{{ child.kind === 'team' ? 'open people ▸' : 'open ▸' }}</span>
        </div>
        <button v-if="canEdit" class="rost-add" @click="add()">
          + Add {{ childKindOf(current.kind) }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The Roster — PORTING.md slice 2.
 *
 * Explore mode: one tier at a time, as big boxes, with a breadcrumb. The legacy app also has a
 * "Full hierarchy" mode that prints all six directorates expanded at once; that is a printing
 * affordance more than a browsing one and has not come across yet.
 *
 * TWO WRITERS, ONE ROSTER. A person editing here and the nightly directory sync write the same
 * data, which is why the roster lives in the collaborative document rather than in a table of its
 * own. Two things follow, and neither is incidental:
 *
 *   - a unit with an `externalId` came from the directory and a sync will re-assert it, so the
 *     screen says so rather than letting someone quietly rename something that will snap back;
 *   - a unit created here has `externalId: null` on purpose — that is how "ours, not the
 *     directory's" is recorded, and `reconcile` preserves it deliberately.
 *
 * The drill path is client-side state. Which unit YOU are looking at is not a fact about the org.
 */
import {
  ACTOR_LABELS_DEFAULT,
  ACTORS,
  orgLabel,
  unitStat,
  type Actor,
  type OrgRef,
} from '@raci/core';
import {
  addRosterUnit,
  childKindOf as childKind,
  deleteRosterUnit,
  rosterChildren,
  setRosterLead,
  setRosterUnitField,
  type RosterUnitKind,
  type RosterUnitRecord,
} from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

/** Ids from the directorate down. Client-side: your location is not document data. */
const path = ref<string[]>([]);

// Re-read on every document change, because rosterChildren reads the Y.Doc directly rather than
// the plain snapshot — the flat units are the storage, and this screen edits them as such.
const version = computed(() => session.workspace.value);

const current = computed<RosterUnitRecord | null>(() => {
  void version.value;
  const id = path.value[path.value.length - 1];
  if (!id) return null;
  const parentId = path.value.length > 1 ? path.value[path.value.length - 2]! : null;
  return rosterChildren(session.doc, parentId).find((u) => u.id === id) ?? null;
});

const children = computed<RosterUnitRecord[]>(() => {
  void version.value;
  return current.value ? rosterChildren(session.doc, current.value.id) : [];
});

const crumbs = computed(() =>
  path.value.map((id, i) => {
    const parentId = i > 0 ? path.value[i - 1]! : null;
    const unit = rosterChildren(session.doc, parentId).find((u) => u.id === id);
    if (i === 0) {
      return { id, name: session.workspace.value.actorLabels[id] || ACTOR_LABELS_DEFAULT[id as Actor] || id };
    }
    return { id, name: unit?.name || `Untitled ${unit?.kind ?? 'unit'}` };
  }),
);

/** The OrgRef for a unit at `path`, which is what the stat selector takes. */
const refFor = (ids: readonly string[]): OrgRef | null => {
  const [actor, divisionId, branchId, teamId] = ids;
  if (!actor || !ACTORS.includes(actor as Actor)) return null;
  if (!divisionId) return { actor: actor as Actor };
  if (!branchId) return { actor: actor as Actor, divisionId };
  if (!teamId) return { actor: actor as Actor, divisionId, branchId };
  return { actor: actor as Actor, divisionId, branchId, teamId };
};

const directorates = computed(() =>
  ACTORS.filter((actor) => session.workspace.value.roster[actor]).map((actor) => {
    void version.value;
    const unit = rosterChildren(session.doc, null).find((u) => u.id === actor);
    return {
      id: actor,
      name: session.workspace.value.actorLabels[actor] || ACTOR_LABELS_DEFAULT[actor],
      stat: unitStat(session.workspace.value, { actor }),
      lead: unit?.leadName || '',
    };
  }),
);

const currentLabel = computed(() =>
  current.value ? orgLabel(session.workspace.value, refFor(path.value))?.short ?? '' : '',
);
const currentStat = computed(() => unitStat(session.workspace.value, refFor(path.value)));
const statFor = (child: RosterUnitRecord) => unitStat(session.workspace.value, refFor([...path.value, child.id]));

const KIND_LABELS: Record<RosterUnitKind, string> = {
  directorate: 'Directorate', division: 'Division', branch: 'Branch', team: 'Team', person: 'Person',
};
const LEAD_ROLES: Record<RosterUnitKind, string> = {
  directorate: 'AD', division: 'DC', branch: 'BC', team: 'TL', person: '',
};
const kindLabel = (kind: RosterUnitKind) => KIND_LABELS[kind];
const leadRole = (kind: RosterUnitKind) => LEAD_ROLES[kind];
const childKindOf = (kind: RosterUnitKind) => childKind(kind) ?? '';

const drill = (next: string[]) => { path.value = next; };

const rename = (id: string, name: string) => setRosterUnitField(session.doc, id, 'name', name);
const setField = (id: string, field: 'title' | 'email', value: string) =>
  setRosterUnitField(session.doc, id, field, value);
const add = () => { if (current.value) addRosterUnit(session.doc, current.value.id, ''); };

function remove(id: string) {
  deleteRosterUnit(session.doc, id);
  // Drilling into something that no longer exists would leave an empty pane with a live breadcrumb.
  const at = path.value.indexOf(id);
  if (at >= 0) path.value = path.value.slice(0, at);
}

function addLead() {
  if (current.value) setRosterLead(session.doc, current.value.id, { id: `p_${Date.now()}`, name: '' });
}
function setLeadName(name: string) {
  if (current.value) setRosterUnitField(session.doc, current.value.id, 'leadName', name);
}
function clearLead() {
  if (current.value) setRosterLead(session.doc, current.value.id, null);
}

// ---- directory sync -------------------------------------------------------------------------
const syncing = ref(false);
const syncMessage = ref('');
const syncFailed = ref(false);

async function runSync() {
  syncing.value = true;
  syncMessage.value = '';
  try {
    const result = await $fetch<{ status: string; message: string }>('/api/directory/sync', {
      method: 'POST',
      body: { workspaceId: session.workspaceId },
    });
    syncFailed.value = result.status === 'failed' || result.status === 'refused';
    syncMessage.value = result.message;
  } catch (err) {
    syncFailed.value = true;
    syncMessage.value = err instanceof Error ? err.message : 'The sync could not be started.';
  } finally {
    syncing.value = false;
  }
}
</script>

<style scoped>
.rost-head { display: flex; align-items: flex-start; gap: 24px; margin-bottom: 14px; }
.rost-head h2 { margin: 0 0 4px; font-size: 16px; }
.rost-head .meta { margin: 0; max-width: 64ch; font-size: 12px; color: var(--text-dim); }
.rost-sync { margin-left: auto; white-space: nowrap; }
.rost-sync-msg { font-size: 12px; color: var(--text-dim); margin: 0 0 12px; }
.rost-sync-msg.bad { color: #ff8787; }

.rost-crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.rost-crumbs button { font-size: 12px; background: none; border: 0; padding: 2px 4px;
  color: var(--accent); cursor: pointer; }
.rost-crumbs button:disabled { color: var(--text); cursor: default; font-weight: 600; }
.rost-crumbs .sep { color: var(--text-dim); font-size: 10px; }
.rost-hint, .rost-empty { font-size: 12px; color: var(--text-dim); margin: 0 0 12px; }

.rost-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.rost-box { position: relative; background: var(--bg-2); border: 1px solid var(--border);
  border-left-width: 3px; border-radius: 8px; padding: 12px 14px; cursor: pointer;
  display: flex; flex-direction: column; gap: 4px; }
.rost-box:hover { border-color: var(--accent); }
.rost-box:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rost-box.k-directorate { border-left-color: #4dabf7; }
.rost-box.k-division { border-left-color: #b197fc; }
.rost-box.k-branch { border-left-color: #63e6be; }
.rost-box.k-team { border-left-color: #ffd43b; }
.rost-box-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
.rost-box-name { font-weight: 600; }
.rost-box-stat { font-size: 11px; color: var(--text-dim); }
.rost-box-lead { font-size: 11px; color: var(--text-dim); }
.rost-box-lead.vacant { font-style: italic; opacity: .7; }
.rost-box-go { font-size: 11px; color: var(--accent); margin-top: 2px; }
.rost-box-del { position: absolute; top: 6px; right: 6px; }
.rost-add { border-style: dashed; min-height: 92px; color: var(--text-dim); }

.rost-unit-head { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 16px; }
.rost-uh-top { display: flex; align-items: center; gap: 10px; }
.rost-uh-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
.rost-uh-name { font: inherit; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; margin: 0;
  background: transparent; color: inherit; border: 0; border-bottom: 1px solid transparent;
  padding: 2px 0; }
.rost-uh-name.static { border: 0; }
.rost-uh-name:hover:not(:disabled):not(.static) { border-bottom-color: var(--border); }
.rost-uh-name:focus { outline: none; border-bottom-color: var(--accent); }
.rost-uh-stat { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.rost-uh-lead { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.lead-badge { font-size: 10px; font-weight: 600; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; }
.lead-name, .p-name, .p-title { font: inherit; font-size: 13px; background: var(--bg);
  color: inherit; border: 1px solid var(--border); border-radius: 5px; padding: 3px 7px; }
.lead-name:focus, .p-name:focus, .p-title:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.add-lead { font-size: 12px; border-style: dashed; }
.del-icon { font-size: 14px; line-height: 1; padding: 1px 6px; color: var(--text-dim); }
.del-icon:hover { color: #ff6b6b; border-color: #ff6b6b; }

.rost-people { display: flex; flex-direction: column; gap: 6px; max-width: 720px; }
.rost-person { display: flex; align-items: center; gap: 8px; }
.rost-person .p-name { flex: 0 0 240px; }
.rost-person .p-title { flex: 1; min-width: 0; }
.p-src { font-size: 10px; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 9px; padding: 0 7px; white-space: nowrap; }
</style>
