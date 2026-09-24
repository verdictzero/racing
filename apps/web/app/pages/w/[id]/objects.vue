<template>
  <div class="ws-page">
    <!-- index.html's renderObjects / objCardHtml / objDetailHtml, element for element: the same
         classes, ids and data-* attributes, so legacy.css styles it exactly as the source. -->
    <div class="objv" @contextmenu="onContextMenu">
      <div class="objv-head">
        <div class="objv-title">
          <h2>Object Gallery</h2>
          <span class="meta">Every named thing the charts and flows point at — deliverables that move between steps, entities that act as parties. Shared across the whole workspace.</span>
        </div>
        <div class="objv-tools">
          <input
            id="obj-filter"
            type="search"
            data-lock-ok
            placeholder="Filter objects…"
            :value="query"
            spellcheck="false"
            @input="onFilter"
          >
          <div class="objv-facets">
            <button
              v-for="k in OBJ_KINDS"
              :key="k.key"
              type="button"
              class="obj-facet"
              :class="{ active: kind === k.key }"
              :data-obj-kind="k.key"
              @click="setKind(k.key)"
            >{{ k.label }} <b>{{ counts[k.key] }}</b></button>
          </div>
          <div class="objv-new">
            <button id="art-new" type="button" title="Add a deliverable to the shared registry" :disabled="!canEdit" @click="newDeliverable">＋ Deliverable</button>
            <button type="button" data-add-entity="1" title="Add a board, committee, vendor or standing team" :disabled="!canEdit" @click="newEntity">＋ Entity</button>
          </div>
        </div>
      </div>
      <div class="objv-body">
        <div class="objv-grid">
          <article
            v-for="o in list"
            :key="o.id"
            class="obj-card"
            :class="[`k-${o.kind}`, { 'is-sel': o.id === selectedId }]"
            :data-obj-card="o.id"
            tabindex="0"
            role="button"
            :title="o.description || o.name"
            @click="toggle(o.id)"
          >
            <div class="obj-card-top">
              <span class="obj-ico" aria-hidden="true">{{ iconOf(o) }}</span>
              <span class="obj-type">{{ o.typeLabel }}</span>
              <span class="obj-uses" :class="{ none: !o.uses.length }">{{ usesLabel(o) }}</span>
            </div>
            <div class="obj-name">{{ o.name }}</div>
            <div v-if="o.sub" class="obj-sub">{{ o.sub }}</div>
            <div v-if="o.description" class="obj-desc">{{ o.description }}</div>
          </article>
          <div v-if="!list.length" class="objv-none">{{ all.length ? 'Nothing matches that filter.' : 'No objects yet. Add a deliverable or an entity to start the registry.' }}</div>
        </div>
        <aside class="objv-detail">
          <div v-if="!selected" class="obj-detail-empty">Pick an object to see everywhere it is used.</div>
          <template v-else-if="selectedEntity">
            <div class="obj-detail-head">
              <span class="obj-ico lg" aria-hidden="true">{{ iconOf(selected) }}</span>
              <span
                :key="`n${paint}`"
                class="obj-detail-name"
                :contenteditable="editable"
                spellcheck="false"
                :data-entity-id="selected.id"
                data-field="ent-name"
                data-placeholder="Name"
                @keydown="enterBlurs"
                @blur="commitEntity($event, 'name')"
              >{{ selectedEntity.name || '' }}</span>
            </div>
            <div class="obj-field">
              <label>Kind</label>
              <select :key="`k${paint}`" class="obj-kind-sel" :data-ent-kind="selected.id" title="What kind of body this is" :disabled="!canEdit" @change="changeEntityKind">
                <option v-for="k in ENTITY_KINDS" :key="k" :value="k" :selected="k === selectedEntity.kind">{{ ENTITY_KIND_META[k].icon }} {{ ENTITY_KIND_META[k].label }}</option>
              </select>
            </div>
            <div class="obj-field">
              <label>Short</label>
              <span
                :key="`s${paint}`"
                :contenteditable="editable"
                spellcheck="false"
                :data-entity-id="selected.id"
                data-field="ent-short"
                :data-placeholder="deriveShort(selected.name)"
                @keydown="enterBlurs"
                @blur="commitEntity($event, 'short')"
              >{{ selectedEntity.short || '' }}</span>
            </div>
            <div class="obj-field">
              <label>Lead</label>
              <span
                :key="`l${paint}`"
                :contenteditable="editable"
                spellcheck="false"
                :data-entity-id="selected.id"
                data-field="ent-lead"
                data-placeholder="Who speaks for it"
                @keydown="enterBlurs"
                @blur="commitEntity($event, 'lead')"
              >{{ selectedEntity.lead?.name || '' }}</span>
            </div>
            <div class="obj-field col">
              <label>Description</label>
              <span
                :key="`d${paint}`"
                class="obj-detail-desc"
                :contenteditable="editable"
                spellcheck="false"
                :data-entity-id="selected.id"
                data-field="ent-desc"
                data-placeholder="＋ what this is"
                @keydown="enterBlurs"
                @blur="commitEntity($event, 'description')"
              >{{ selected.description }}</span>
            </div>
            <h4 class="obj-uses-h">Where it is used<template v-if="selected.uses.length">{{ ' ' }}<b>{{ selected.uses.length }}</b></template></h4>
            <ul v-if="selected.uses.length" class="obj-use-list">
              <li v-for="(u, i) in selected.uses" :key="i">
                <span class="ou-verb">{{ u.verb }}</span>
                <button type="button" class="ou-target" disabled title="No place to open">{{ u.name }}</button>
                <span v-if="u.where" class="ou-where">{{ u.where }}</span>
              </li>
            </ul>
            <div v-else class="obj-unused">Nothing in the workspace names this yet. Name it as a responsible party on a flow step, or on a Program or Project row.</div>
            <div class="obj-detail-acts">
              <button type="button" class="obj-del" :data-del-entity="selected.id" title="Delete this entity" :disabled="!canEdit" @click="removeEntity(selected.id)">Delete</button>
            </div>
          </template>
          <template v-else-if="selectedArtifact">
            <div class="obj-detail-head">
              <span class="obj-ico lg" aria-hidden="true">{{ iconOf(selected) }}</span>
              <span
                :key="`n${paint}`"
                class="obj-detail-name"
                :contenteditable="editable"
                spellcheck="false"
                :data-art-name="selected.id"
                data-placeholder="Name"
                @keydown="enterBlurs"
                @blur="commitArtifactName"
              >{{ selectedArtifact.name || '' }}</span>
            </div>
            <div class="obj-field">
              <label>Type</label>
              <select :key="`k${paint}`" class="obj-kind-sel" :data-art-type="selected.id" title="Deliverable type" :disabled="!canEdit" @change="changeArtifactType">
                <option v-for="t in ARTIFACT_TYPES" :key="t" :value="t" :selected="t === selectedArtifact.type">{{ t }}</option>
              </select>
            </div>
            <div class="obj-field col">
              <label>Description</label>
              <span
                :key="`d${paint}`"
                class="obj-detail-desc"
                :contenteditable="editable"
                spellcheck="false"
                :data-art-desc="selected.id"
                data-placeholder="＋ what this is"
                @keydown="enterBlurs"
                @blur="commitArtifactDesc"
              >{{ selected.description }}</span>
            </div>
            <h4 class="obj-uses-h">Where it is used<template v-if="selected.uses.length">{{ ' ' }}<b>{{ selected.uses.length }}</b></template></h4>
            <ul v-if="selected.uses.length" class="obj-use-list">
              <li v-for="(u, i) in selected.uses" :key="i">
                <span class="ou-verb">{{ u.verb }}</span>
                <button
                  type="button"
                  class="ou-target"
                  :data-obj-go-chart="u.chartId"
                  :data-obj-go-flow="u.chartId ? undefined : u.flowId"
                  :disabled="!u.chartId && !u.flowId"
                  :title="u.chartId || u.flowId ? `Open ${u.where}` : 'No place to open'"
                  @click="goTo(u)"
                >{{ u.name }}</button>
                <span v-if="u.where" class="ou-where">{{ u.where }}</span>
              </li>
            </ul>
            <div v-else class="obj-unused">Nothing in the workspace names this yet. Attach it to a handoff (click a line in a flow) or declare it on a chart row (Details rail).</div>
            <div class="obj-detail-acts">
              <button
                type="button"
                class="obj-del"
                :data-art-del="selected.id"
                :disabled="!canEdit || selected.uses.length > 0"
                :title="selected.uses.length ? 'Referenced — remove its uses first' : 'Delete this deliverable'"
                @click="removeArtifact(selected.id)"
              >Delete</button>
            </div>
          </template>
        </aside>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The Object Gallery — index.html's renderObjects, objCardHtml and objDetailHtml, with the handlers
 * the source delegates on `document` (data-obj-kind, data-obj-card, #obj-filter, #art-new,
 * data-add-entity, data-art-type / data-ent-kind, the contenteditable commits on blur, data-art-del,
 * data-del-entity, data-obj-go-chart / -flow) and its right-click menu (ctxObjectCardItems /
 * ctxObjectBlankItems).
 *
 * Both registries in one screen, because a deliverable and an entity are the same kind of thing: a
 * named noun with a stable id that charts and flows reference rather than contain. The thinking is
 * in `@raci/core`'s `objectRegistry` (the source's objRegistry); this file is the source's markup.
 *
 * THE TWO REGISTRIES DELETE DIFFERENTLY, as in the source: a deliverable in use cannot be deleted
 * (its references are the supply chain), while an entity in use can, after a confirmation that names
 * what will be left pointing at "(missing entity)".
 *
 * The filter, the facet and the selection are the source's transient view state: per person, kept
 * across screen switches, reset on reload. Every edit goes through a @raci/crdt mutation.
 */
import {
  ARTIFACT_TYPES,
  ENTITY_KIND_META,
  ENTITY_KINDS,
  artifactTypeMeta,
  computeEntityUses,
  deriveShort,
  entityDisplayName,
  entityKindMeta,
  filterObjects,
  newId,
  objectRegistry,
  type Artifact,
  type Entity,
  type ObjectKind,
  type RegistryObject,
  type UseRef,
} from '@raci/core';
import {
  addArtifact,
  addEntity,
  deleteArtifact,
  deleteEntity,
  duplicateArtifact,
  duplicateEntity,
  setArtifactField,
  setEntityField,
} from '@raci/crdt';
import { useActiveChartId, useActiveFlowId, useShell } from '~/composables/useShell';
import type { CtxEntry } from '~/composables/useContextMenu';

type Facet = ObjectKind | 'all';
const OBJ_KINDS: { key: Facet; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'deliverable', label: 'Deliverables' },
  { key: 'entity', label: 'Entities' },
];

const session = useWorkspaceSession();
const shell = useShell();
const menu = useContextMenu();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));
const editable = computed(() => (canEdit.value ? 'true' : 'false'));
const activeChartId = useActiveChartId();
const activeFlowId = useActiveFlowId();
const ws = computed(() => session.workspace.value);

// ---- the source's _objQ / _objKind / _objSel ----------------------------------------------------
const query = useState<string>(`raci:objQ:${session.workspaceId}`, () => '');
const kind = useState<Facet>(`raci:objKind:${session.workspaceId}`, () => 'all');
const selectedId = useState<string | null>(`raci:objSel:${session.workspaceId}`, () => null);
/**
 * One tick per repaint the source would do. index.html rebuilds the pane on every click, filter
 * keystroke and commit, which also throws away a half-typed contenteditable whose commit was refused
 * (an empty deliverable name). The editable fields are keyed on this so they do the same — and a
 * peer's edit arriving mid-typing, which the source never had to survive, does not.
 */
const paint = ref(0);
const repaint = () => { paint.value++; };

const all = computed(() => objectRegistry(ws.value));
const counts = computed(() => {
  const c: Record<Facet, number> = { all: all.value.length, deliverable: 0, entity: 0 };
  for (const o of all.value) c[o.kind]++;
  return c;
});
const list = computed(() => filterObjects(all.value, { kind: kind.value, query: query.value }));
// A selection the filter just hid would leave the pane showing something not on screen.
watch(list, (l) => {
  if (selectedId.value && !l.some((o) => o.id === selectedId.value)) selectedId.value = null;
}, { immediate: true });

const selected = computed<RegistryObject | null>(() =>
  selectedId.value ? all.value.find((o) => o.id === selectedId.value) ?? null : null);
const selectedEntity = computed(() => (selected.value?.kind === 'entity' ? (selected.value.ref as Entity) : null));
const selectedArtifact = computed(() => (selected.value?.kind === 'deliverable' ? (selected.value.ref as Artifact) : null));

const iconOf = (o: RegistryObject) =>
  o.kind === 'entity' ? entityKindMeta((o.ref as Entity).kind).icon : artifactTypeMeta((o.ref as Artifact).type).icon;
const usesLabel = (o: RegistryObject) => {
  const n = o.uses.length;
  return n ? `${n}${n === 1 ? ' use' : ' uses'}` : 'unused';
};

// ---- browsing -------------------------------------------------------------------------------------
function onFilter(e: Event): void {
  query.value = (e.target as HTMLInputElement).value;
  repaint();
}
function setKind(k: Facet): void {
  kind.value = k;
  repaint();
}
function toggle(id: string): void {
  selectedId.value = selectedId.value === id ? null : id;
  repaint();
}
function goTo(u: UseRef): void {
  if (u.chartId) {
    activeChartId.value = u.chartId;
    void navigateTo(`/w/${session.workspaceId}`);
  } else if (u.flowId) {
    activeFlowId.value = u.flowId;
    void navigateTo(`/w/${session.workspaceId}/flow`);
  }
}

// ---- adding -------------------------------------------------------------------------------------
/** Land on the thing that was just made — the source clears the filter and facet to show it. */
function land(id: string): void {
  selectedId.value = id;
  kind.value = 'all';
  query.value = '';
  repaint();
}
function newDeliverable(): void {
  if (!canEdit.value) return;
  const nm = (window.prompt('New deliverable name:') || '').trim();
  if (!nm) return;
  const existing = Object.values(ws.value.artifacts).find((a) => a.name.trim().toLowerCase() === nm.toLowerCase());
  if (existing) {
    // "Where is the one that already exists" is the next question, so land on it.
    shell.toast(`"${existing.name}" already exists in the registry.`, 'suggest');
    land(existing.id);
    return;
  }
  const id = addArtifact(session.doc, nm, 'other');
  shell.toast(`Deliverable "${nm}" added.`);
  land(id);
}
async function newEntity(): Promise<void> {
  if (!canEdit.value) return;
  const id = addEntity(session.doc, '', 'board');
  land(id);
  await nextTick();
  document.querySelector<HTMLElement>(`.obj-detail-name[data-entity-id="${id}"]`)?.focus();
}

// ---- editing ------------------------------------------------------------------------------------
function enterBlurs(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    (e.target as HTMLElement).blur();
  }
}
const textOf = (e: Event) => ((e.target as HTMLElement).textContent ?? '').trim();

function commitArtifactName(e: Event): void {
  const a = selectedArtifact.value;
  if (!a || !canEdit.value) return;
  const nm = textOf(e);
  // An empty name is refused, as in the source: a deliverable must stay findable by name.
  if (nm && nm !== a.name) {
    setArtifactField(session.doc, a.id, 'name', nm);
    repaint();
  }
}
function commitArtifactDesc(e: Event): void {
  const a = selectedArtifact.value;
  if (!a || !canEdit.value) return;
  const d = textOf(e);
  if (d !== a.description) {
    setArtifactField(session.doc, a.id, 'description', d);
    repaint();
  }
}
function commitEntity(e: Event, field: 'name' | 'short' | 'description' | 'lead'): void {
  const ent = selectedEntity.value;
  if (!ent || !canEdit.value) return;
  const v = textOf(e);
  if (field === 'lead') {
    if ((ent.lead?.name || '') === v) return;
    setEntityField(session.doc, ent.id, 'lead', v ? { id: ent.lead?.id || newId('person'), name: v } : null);
  } else {
    if (ent[field] === v) return;
    setEntityField(session.doc, ent.id, field, v);
  }
  repaint();
}
function changeArtifactType(e: Event): void {
  const a = selectedArtifact.value;
  const v = (e.target as HTMLSelectElement).value;
  if (!a || !canEdit.value || !(ARTIFACT_TYPES as readonly string[]).includes(v)) return;
  setArtifactField(session.doc, a.id, 'type', v);
  repaint();
}
function changeEntityKind(e: Event): void {
  const ent = selectedEntity.value;
  const v = (e.target as HTMLSelectElement).value;
  if (!ent || !canEdit.value || !(ENTITY_KINDS as readonly string[]).includes(v) || ent.kind === v) return;
  setEntityField(session.doc, ent.id, 'kind', v);
  repaint();
}

// ---- deleting -----------------------------------------------------------------------------------
function removeArtifact(id: string): void {
  if (!canEdit.value || !ws.value.artifacts[id]) return;
  // The mutation re-checks against the live document: a peer can attach the deliverable in the
  // instant between the button rendering and the click.
  if (!deleteArtifact(session.doc, id).deleted) {
    shell.toast('Deliverable is referenced — remove its uses first.', 'error');
    return;
  }
  repaint();
}
function removeEntity(id: string): void {
  const e = ws.value.entities[id];
  if (!canEdit.value || !e) return;
  // Refs are not rewritten on delete — they read "(missing entity)" — so the confirmation names
  // what would be left dangling rather than just how many.
  const uses = computeEntityUses(ws.value, id);
  const name = entityDisplayName(e);
  if (uses.length && !window.confirm(
    `"${name}" is named as a party by ${uses.length} ${uses.length === 1 ? 'thing' : 'things'}:\n\n` +
      uses.slice(0, 8).map((u) => `  • ${u.where} › ${u.name}`).join('\n') +
      (uses.length > 8 ? `\n  … and ${uses.length - 8} more` : '') +
      '\n\nDelete it anyway? Those parties will read "(missing entity)" until they are re-pointed.',
  )) return;
  deleteEntity(session.doc, id);
  repaint();
  shell.toast(`Entity "${name}" deleted.`);
}

// ---- the right-click menu (ctxObjectCardItems / ctxObjectBlankItems) ----------------------------
function duplicate(id: string): void {
  const copy = ws.value.artifacts[id] ? duplicateArtifact(session.doc, id) : duplicateEntity(session.doc, id);
  if (!copy) return;
  selectedId.value = copy;
  repaint();
}
function cardItems(oid: string): CtxEntry[] | null {
  const o = all.value.find((x) => x.id === oid);
  if (!o) return null;
  const isEnt = o.kind === 'entity';
  return [
    { title: o.name || (isEnt ? 'Unnamed entity' : 'Untitled deliverable') },
    {
      label: o.id === selectedId.value ? 'Hide where it is used' : 'Show where it is used',
      ico: '👁',
      hint: `${o.uses.length} use${o.uses.length === 1 ? '' : 's'}`,
      run: () => toggle(oid),
    },
    { label: 'Duplicate', ico: '⧉', hint: 'A copy starts with no uses of its own', disabled: !canEdit.value, run: () => duplicate(oid) },
    { sep: true },
    {
      label: isEnt ? 'Delete entity' : 'Delete deliverable',
      ico: '✕',
      danger: true,
      disabled: !canEdit.value,
      // undefined rather than '': the menu then prints no tooltip at all, as the source's does.
      hint: !isEnt && o.uses.length ? 'Something still references it — that has to go first' : undefined,
      // The source drives the registry's own Delete button, which is disabled while anything
      // references the deliverable — so on a referenced one this does nothing.
      run: () => (isEnt ? removeEntity(oid) : o.uses.length ? undefined : removeArtifact(oid)),
    },
  ];
}
function blankItems(): CtxEntry[] {
  return [
    { title: 'Object Gallery' },
    { label: 'New deliverable', ico: '＋', disabled: !canEdit.value, run: newDeliverable },
    { label: 'New entity', ico: '＋', disabled: !canEdit.value, run: () => { void newEntity(); } },
  ];
}
function onContextMenu(e: MouseEvent): void {
  const t = e.target as Element;
  // A real form field keeps the browser's own menu: spellcheck and the system clipboard live there.
  if (t.closest('input, textarea')) return;
  // Inside an editable name, a live selection means someone is lining up a copy — the browser's.
  const ce = t.closest('[contenteditable="true"]');
  if (ce) {
    const sl = document.getSelection();
    if (sl && !sl.isCollapsed && sl.anchorNode && ce.contains(sl.anchorNode)) return;
  }
  const card = t.closest('[data-obj-card]');
  const items = card ? cardItems(card.getAttribute('data-obj-card') ?? '') : blankItems();
  if (items && menu.open(e.clientX, e.clientY, items)) e.preventDefault();
}
</script>
