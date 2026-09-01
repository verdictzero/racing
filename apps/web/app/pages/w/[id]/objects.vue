<template>
  <div class="objv">
    <div class="objv-head">
      <div class="objv-title">
        <h2>Object Gallery</h2>
        <p class="meta">
          Every named thing the charts and flows point at — deliverables that move between steps,
          entities that act as parties. Shared across the whole workspace.
        </p>
      </div>
      <div class="objv-tools">
        <input
          v-model="query"
          type="search"
          class="objv-filter"
          placeholder="Filter objects…"
          spellcheck="false"
        >
        <div class="objv-facets">
          <button
            v-for="facet in facets"
            :key="facet.key"
            type="button"
            class="objv-facet"
            :class="{ active: kind === facet.key }"
            @click="kind = facet.key"
          >
            {{ facet.label }} <b>{{ facet.count }}</b>
          </button>
        </div>
        <div class="objv-new">
          <button :disabled="!canEdit" title="Add a deliverable to the shared registry"
            @click="newArtifact">＋ Deliverable</button>
          <button :disabled="!canEdit" title="Add a board, committee, vendor or standing team"
            @click="newEntity">＋ Entity</button>
        </div>
      </div>
    </div>

    <div class="objv-body">
      <div class="objv-grid">
        <article
          v-for="object in shown"
          :key="object.id"
          class="obj-card"
          :class="[`k-${object.kind}`, { 'is-sel': object.id === selectedId }]"
          tabindex="0"
          role="button"
          :title="object.description || object.name"
          @click="selectedId = object.id"
          @keydown.enter.prevent="selectedId = object.id"
          @keydown.space.prevent="selectedId = object.id"
        >
          <div class="obj-card-top">
            <span class="obj-ico" aria-hidden="true">{{ iconFor(object) }}</span>
            <span class="obj-type">{{ object.typeLabel }}</span>
            <span class="obj-uses" :class="{ none: !object.uses.length }" :title="usesTitle(object)">
              {{ usesLabel(object) }}
            </span>
          </div>
          <div class="obj-name">{{ object.name || '(unnamed)' }}</div>
          <div v-if="object.sub" class="obj-sub">{{ object.sub }}</div>
          <div v-if="object.description" class="obj-desc">{{ object.description }}</div>
        </article>

        <p v-if="!shown.length" class="objv-none">
          {{ objects.length ? 'Nothing matches that filter.'
                            : 'No objects yet. Add a deliverable or an entity to start the registry.' }}
        </p>
      </div>

      <aside class="objv-detail">
        <p v-if="!selected" class="obj-detail-empty">Pick an object to see everywhere it is used.</p>

        <template v-else>
          <div class="obj-detail-head">
            <span class="obj-ico lg" aria-hidden="true">{{ iconFor(selected) }}</span>
            <input
              class="obj-detail-name"
              :value="selected.name"
              :disabled="!canEdit"
              placeholder="Name"
              @change="setName(($event.target as HTMLInputElement).value)"
            >
          </div>

          <label class="obj-field">
            <span>{{ selected.kind === 'entity' ? 'Kind' : 'Type' }}</span>
            <select
              :value="selected.kind === 'entity' ? (selected.ref as Entity).kind : (selected.ref as Artifact).type"
              :disabled="!canEdit"
              :title="kindBlurb"
              @change="setKind(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="option in kindOptions" :key="option.value" :value="option.value">
                {{ option.icon }} {{ option.label }}
              </option>
            </select>
          </label>
          <p class="obj-blurb">{{ kindBlurb }}</p>

          <template v-if="selected.kind === 'entity'">
            <label class="obj-field">
              <span>Short</span>
              <input
                :value="(selected.ref as Entity).short"
                :disabled="!canEdit"
                placeholder="An abbreviation people use"
                @change="setField('short', ($event.target as HTMLInputElement).value)"
              >
            </label>
          </template>

          <label class="obj-field col">
            <span>Description</span>
            <textarea
              :value="selected.description"
              :disabled="!canEdit"
              rows="3"
              placeholder="What this is"
              @change="setField('description', ($event.target as HTMLTextAreaElement).value)"
            />
          </label>

          <h4 class="obj-uses-h">
            Where it is used
            <b v-if="selected.uses.length">{{ selected.uses.length }}</b>
          </h4>

          <ul v-if="selected.uses.length" class="obj-use-list">
            <li v-for="(use, i) in selected.uses" :key="`${use.verb}:${use.chartId ?? use.flowId ?? ''}:${use.name}:${i}`">
              <span class="ou-verb">{{ use.verb }}</span>
              <span class="ou-target">{{ use.name }}</span>
              <span v-if="use.where" class="ou-where">{{ use.where }}</span>
            </li>
          </ul>
          <p v-else class="obj-unused">
            Nothing in the workspace names this yet.
            {{ selected.kind === 'deliverable'
              ? 'Attach it to a handoff in a flow, or declare it on a chart row.'
              : 'Name it as a responsible party on a flow step, or on a chart row.' }}
          </p>

          <div class="obj-detail-acts">
            <button
              class="obj-del"
              :disabled="!canEdit || blockedBy > 0"
              :title="deleteTitle"
              @click="remove"
            >Delete</button>
            <span v-if="deleteNote" class="obj-del-note">{{ deleteNote }}</span>
          </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The Object Gallery — PORTING.md slice 4.
 *
 * Both registries in one screen, because a deliverable and an entity are the same kind of thing: a
 * named noun with a stable id that charts and flows reference rather than contain. The gallery is
 * where you answer "what IS this, and who actually uses it" without opening every chart.
 *
 * All of the thinking is in `@raci/core`'s `objectRegistry` — the flattening, the use index, the
 * de-duplication, the search text. This file is the arrangement of it, and that split is the point:
 * "is this deliverable still referenced" now has exactly one answer in the codebase, where
 * index.html computes it in three places.
 *
 * THE TWO REGISTRIES DELETE DIFFERENTLY, and it is not an oversight:
 *   - a deliverable in use cannot be deleted, because the references are the supply chain and
 *     breaking them silently would corrupt every flow that carries it;
 *   - an entity in use CAN be deleted, because a body that no longer exists is a fact about the
 *     org, and refusing the delete would not make it exist. What names it reads "(missing)" until
 *     it is re-pointed.
 * That asymmetry is the legacy app's behaviour, kept deliberately.
 */
import {
  objectRegistry,
  filterObjects,
  artifactRefCount,
  computeArtifactUses,
  orphanArtifacts,
  terminalArtifacts,
  ARTIFACT_TYPES,
  ENTITY_KINDS,
  artifactTypeMeta,
  entityKindMeta,
  type Artifact,
  type Entity,
  type ObjectKind,
  type RegistryObject,
} from '@raci/core';
import {
  addArtifact,
  addEntity,
  deleteArtifact,
  deleteEntity,
  setArtifactField,
  setEntityField,
} from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

const query = ref('');
const kind = ref<ObjectKind | 'all'>('all');
const selectedId = ref<string | null>(null);

const objects = computed(() => objectRegistry(session.workspace.value));
const shown = computed(() => filterObjects(objects.value, { kind: kind.value, query: query.value }));

const facets = computed(() => {
  const all = objects.value;
  return [
    { key: 'all' as const, label: 'Everything', count: all.length },
    { key: 'deliverable' as const, label: 'Deliverables', count: all.filter((o) => o.kind === 'deliverable').length },
    { key: 'entity' as const, label: 'Entities', count: all.filter((o) => o.kind === 'entity').length },
  ];
});

// A selection the filter just hid would leave the pane describing something not on screen — and
// worse, let you delete a thing you cannot see.
watch(shown, (list) => {
  if (selectedId.value && !list.some((o) => o.id === selectedId.value)) selectedId.value = null;
});

const selected = computed<RegistryObject | null>(
  () => (selectedId.value ? objects.value.find((o) => o.id === selectedId.value) ?? null : null),
);

/**
 * The two annotations the rule engine deliberately does not raise as violations.
 *
 * An ORPHAN is a registry entry nothing points at in either direction — usually a leftover.
 * A TERMINAL deliverable is produced and never consumed, which is what a process is usually FOR.
 * They read almost the same on a card and mean opposite things, so the card says which.
 */
const orphanIds = computed(() => new Set(orphanArtifacts(session.workspace.value).map((a) => a.id)));
const terminalIds = computed(
  () => new Set(terminalArtifacts(session.workspace.value).map((a) => a.id)),
);

function usesLabel(object: RegistryObject): string {
  const n = object.uses.length;
  if (n === 0) return 'unused';
  if (terminalIds.value.has(object.id)) return `${n} · terminal`;
  return `${n} ${n === 1 ? 'use' : 'uses'}`;
}

function usesTitle(object: RegistryObject): string {
  if (orphanIds.value.has(object.id)) {
    return 'Nothing points at this yet — attach it to a handoff or declare it on a chart row.';
  }
  if (terminalIds.value.has(object.id)) {
    return 'Produced, and nothing downstream takes it. Usually right — this is where the process ends.';
  }
  return `${object.uses.length} place(s) name this`;
}

const iconFor = (object: RegistryObject) =>
  object.kind === 'entity'
    ? entityKindMeta((object.ref as Entity).kind).icon
    : artifactTypeMeta((object.ref as Artifact).type).icon;

const kindOptions = computed(() =>
  selected.value?.kind === 'entity'
    ? ENTITY_KINDS.map((k) => ({ value: k as string, ...entityKindMeta(k) }))
    : ARTIFACT_TYPES.map((t) => ({ value: t as string, ...artifactTypeMeta(t) })),
);

const kindBlurb = computed(() => {
  const object = selected.value;
  if (!object) return '';
  return object.kind === 'entity'
    ? entityKindMeta((object.ref as Entity).kind).blurb
    : artifactTypeMeta((object.ref as Artifact).type).blurb;
});

/**
 * How many references stand in the way of deleting this.
 *
 * Counted from the raw index rather than from the card's use list: the card collapses two handoffs
 * out of one step into one line, and a guard that counted lines would under-report what it is
 * protecting. Entities are never blocked — see the header.
 */
const blockedBy = computed(() => {
  const object = selected.value;
  if (!object || object.kind !== 'deliverable') return 0;
  return artifactRefCount(computeArtifactUses(session.workspace.value), object.id);
});

const deleteTitle = computed(() => {
  if (!selected.value) return '';
  if (blockedBy.value > 0) return 'Referenced — remove its uses first';
  return selected.value.kind === 'entity'
    ? 'Delete this entity. Anything naming it will read “(missing)” until re-pointed.'
    : 'Delete this deliverable';
});

const deleteNote = computed(() => {
  const object = selected.value;
  if (!object) return '';
  if (blockedBy.value > 0) {
    return `Referenced in ${blockedBy.value} place${blockedBy.value === 1 ? '' : 's'}. Remove those first.`;
  }
  if (object.kind === 'entity' && object.uses.length > 0) {
    return `${object.uses.length} place${object.uses.length === 1 ? '' : 's'} name this — they will read “(missing)”.`;
  }
  return '';
});

function newArtifact() {
  selectedId.value = addArtifact(session.doc, 'New deliverable', 'document');
}
function newEntity() {
  selectedId.value = addEntity(session.doc, 'New entity', 'committee');
}

function setName(name: string) {
  const object = selected.value;
  if (!object) return;
  if (object.kind === 'entity') setEntityField(session.doc, object.id, 'name', name);
  else setArtifactField(session.doc, object.id, 'name', name);
}

function setKind(value: string) {
  const object = selected.value;
  if (!object) return;
  if (object.kind === 'entity') setEntityField(session.doc, object.id, 'kind', value);
  else setArtifactField(session.doc, object.id, 'type', value);
}

function setField(field: 'short' | 'description', value: string) {
  const object = selected.value;
  if (!object) return;
  if (object.kind === 'entity') setEntityField(session.doc, object.id, field, value);
  else if (field === 'description') setArtifactField(session.doc, object.id, 'description', value);
}

function remove() {
  const object = selected.value;
  if (!object) return;
  if (object.kind === 'entity') {
    deleteEntity(session.doc, object.id);
  } else {
    // The mutation re-checks against the live document rather than trusting this screen's read: a
    // peer can attach the deliverable in the instant between the button rendering and the click.
    const result = deleteArtifact(session.doc, object.id);
    if (!result.deleted) return;
  }
  selectedId.value = null;
}
</script>

<style scoped>
.objv-head { display: flex; align-items: flex-start; gap: 24px; flex-wrap: wrap;
  margin-bottom: 18px; }
.objv-title h2 { margin: 0 0 4px; font-size: 16px; }
.objv-title .meta { margin: 0; max-width: 62ch; font-size: 12px; color: var(--text-dim); }
.objv-tools { margin-left: auto; display: flex; flex-direction: column; gap: 8px;
  align-items: flex-end; }
.objv-filter { font: inherit; background: var(--bg-2); color: inherit; min-width: 260px;
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; }
.objv-filter:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.objv-facets, .objv-new { display: flex; gap: 6px; }
.objv-facet { font: inherit; font-size: 12px; background: var(--bg-2); color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 14px; padding: 3px 12px; cursor: pointer; }
.objv-facet:hover { color: var(--text); }
.objv-facet.active { color: var(--text); border-color: var(--accent); }
.objv-facet b { font-weight: 600; opacity: .7; margin-left: 4px; }

.objv-body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px;
  align-items: start; }
@media (max-width: 900px) { .objv-body { grid-template-columns: minmax(0, 1fr); } }

.objv-grid { display: grid; gap: 10px;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
.objv-none { grid-column: 1 / -1; color: var(--text-dim); font-size: 13px; }

.obj-card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px;
  border-left-width: 3px; }
.obj-card:hover { border-color: var(--accent); }
.obj-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.obj-card.is-sel { border-color: var(--accent); background: #1f2530; }
.obj-card.k-deliverable { border-left-color: #4dabf7; }
.obj-card.k-entity { border-left-color: #b197fc; }
.obj-card-top { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); }
.obj-ico { font-size: 14px; }
.obj-ico.lg { font-size: 20px; }
.obj-type { text-transform: uppercase; letter-spacing: .04em; }
.obj-uses { margin-left: auto; }
.obj-uses.none { opacity: .55; font-style: italic; }
.obj-name { font-weight: 600; }
.obj-sub { font-size: 12px; color: var(--text-dim); }
.obj-desc { font-size: 12px; color: var(--text-dim); display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; }

.objv-detail { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 14px; position: sticky; top: 14px; }
.obj-detail-empty { margin: 0; color: var(--text-dim); font-size: 13px; }
.obj-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.obj-detail-name { font: inherit; font-size: 15px; font-weight: 600; flex: 1; min-width: 0;
  background: transparent; color: inherit; border: 0; border-bottom: 1px solid transparent;
  padding: 2px 0; }
.obj-detail-name:hover:not(:disabled) { border-bottom-color: var(--border); }
.obj-detail-name:focus { outline: none; border-bottom-color: var(--accent); }

.obj-field { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; }
.obj-field.col { flex-direction: column; align-items: stretch; gap: 4px; }
.obj-field > span { color: var(--text-dim); min-width: 74px; }
.obj-field select, .obj-field input, .obj-field textarea { font: inherit; font-size: 13px;
  flex: 1; min-width: 0; background: var(--bg); color: inherit; resize: vertical;
  border: 1px solid var(--border); border-radius: 5px; padding: 4px 7px; }
.obj-field :focus { outline: 1px solid var(--accent); outline-offset: -1px; }
.obj-blurb { margin: -2px 0 12px; font-size: 11px; color: var(--text-dim); }

.obj-uses-h { margin: 16px 0 6px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .05em; color: var(--text-dim); border-top: 1px solid var(--border); padding-top: 12px; }
.obj-uses-h b { font-weight: 600; }
.obj-use-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column;
  gap: 6px; }
.obj-use-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
  font-size: 12px; }
.ou-verb { color: var(--text-dim); font-size: 10px; text-transform: uppercase;
  letter-spacing: .04em; min-width: 82px; }
.ou-target { color: var(--text); }
.ou-where { color: var(--text-dim); font-size: 11px; }
.obj-unused { margin: 0; font-size: 12px; color: var(--text-dim); }

.obj-detail-acts { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px;
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.obj-del:hover:not(:disabled) { border-color: #ff6b6b; color: #ff6b6b; }
.obj-del-note { font-size: 11px; color: var(--text-dim); }
</style>
