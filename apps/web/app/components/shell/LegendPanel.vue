<template>
  <h3>{{ fw.name }} Legend</h3>
  <div class="legend-blurb">{{ fw.blurb }}</div>
  <div v-for="l in fw.roles" :key="l" class="legend-row">
    <span class="raci-chip" :class="l">{{ l }}</span>
    <div><div class="label">{{ fw.meta[l]?.label }}</div><div class="desc">{{ fw.meta[l]?.desc }}</div></div>
  </div>
  <p>Click any column cell to toggle {{ fw.roles.join(' / ') }}. A cell can hold none, one, or any combination — but only one
    <b>{{ fw.owner }}</b> ({{ fw.meta[fw.owner]?.label }}) per row.</p>
  <p>Drill a row with <b>▸</b> to break it into the next tier. The Primary <b>{{ fw.doer }}</b>
    ({{ fw.meta[fw.doer]?.label }}) on a row cascades down as the next level's {{ fw.meta[fw.owner]?.label }}.</p>

  <div v-if="chart?.custom" class="legend-map-section">
    <h4>Free-form chart</h4>
    <div class="lm-note">This chart's party columns are chart-specific — rename them in the table header, add one with the <b>+</b> in the top-right corner, remove with <b>×</b>. Level names are renamable in each pane's heading, and rows can nest to any depth. Columns here are not linked to the organization roster.</div>
  </div>
  <div v-else class="legend-map-section">
    <h4>Column → directorate</h4>
    <div class="lm-note">Map each column to a roster directorate so its lead becomes the named person behind that column's roles (shown on cell hover and in the cell popover).</div>
    <div v-for="k in COLS" :key="k" class="lm-row">
      <span class="lm-col" :title="labels.colLabel(k)">{{ labels.colShort(k) }}</span>
      <select class="legend-map" :data-col="k" :title="`Map ${labels.colLabel(k)} to a roster directorate`"
        :disabled="!canEdit" @change="mapColumn(k, ($event.target as HTMLSelectElement).value)">
        <option value="" :selected="!labels.columnActor(k)">— unmapped —</option>
        <option v-for="a in ACTORS" :key="a" :value="a" :selected="labels.columnActor(k) === a">{{ labels.actorLabel(a) }}</option>
      </select>
      <span class="lm-name" title="Directorate lead (Associate Director)">{{ leadName(k) ? '👤 ' + leadName(k) : '' }}</span>
    </div>
  </div>

  <div class="legend-map-section">
    <h4>Deliverables</h4>
    <div class="lm-note">Shared registry of deliverables. Attach one to a flow handoff (click an edge) or declare it as a row's input/output (Details rail). ▸ producers · ◂ consumers.</div>
    <div v-for="a in artifacts" :key="a.id" class="art-row">
      <span class="art-name" :contenteditable="canEdit ? 'true' : 'false'" spellcheck="false" :data-art-name="a.id"
        @blur="rename(a.id, $event)" @keydown.enter.prevent="($event.target as HTMLElement).blur()">{{ a.name }}</span>
      <select class="art-type" :data-art-type="a.id" title="Deliverable type" :disabled="!canEdit"
        @change="setType(a.id, ($event.target as HTMLSelectElement).value)">
        <option v-for="tp in ARTIFACT_TYPES" :key="tp" :value="tp" :selected="tp === a.type">{{ tp }}</option>
      </select>
      <span class="art-refs" :class="{ orphan: !refs(a.id).total }"
        :title="`${refs(a.id).p} producer(s) · ${refs(a.id).c} consumer(s)${refs(a.id).total ? '' : ' — orphan: nothing produces or consumes it yet'}`">
        {{ refs(a.id).total ? `${refs(a.id).p}▸ ${refs(a.id).c}◂` : 'orphan' }}</span>
      <button class="art-del" type="button" :data-art-del="a.id" :disabled="!canEdit || refs(a.id).total > 0"
        :title="refs(a.id).total ? 'Referenced — remove its uses first' : 'Delete deliverable'" @click="remove(a.id)">×</button>
    </div>
    <button id="art-new" class="art-new" type="button" :disabled="!canEdit" @click="create">＋ New deliverable</button>
  </div>
</template>

<script setup lang="ts">
/**
 * The Legend rail — index.html's renderLegend: the active chart's framework, the column →
 * directorate mapping (org charts), and the shared deliverables registry.
 */
import { ACTORS, ARTIFACT_TYPES, COLS, computeArtifactUses, framework, type Chart } from '@raci/core';
import { LOCAL_ORIGIN, addArtifact, deleteArtifact, maps, setArtifactField } from '@raci/crdt';

const props = defineProps<{ chart: Chart | null; canEdit: boolean }>();
const session = useWorkspaceSession();
const labels = useLabels();
const shell = useShell();

const fw = computed(() => framework(props.chart?.framework));
// Registry order, as the source lists state.artifacts.
const artifacts = computed(() => Object.values(session.workspace.value.artifacts));
const uses = computed(() => computeArtifactUses(session.workspace.value));
function refs(id: string) {
  const u = uses.value.get(id);
  const p = u?.producers.length ?? 0, c = u?.consumers.length ?? 0;
  return { p, c, total: p + c };
}
function leadName(col: string): string { return labels.columnPerson(col)?.name ?? ''; }

function mapColumn(col: string, actor: string): void {
  const m = maps(session.doc);
  const next = { ...(m.meta.get('columnActor') as Record<string, string> | undefined ?? {}) };
  if (actor) next[col] = actor; else delete next[col];
  session.doc.transact(() => m.meta.set('columnActor', next), LOCAL_ORIGIN);
}
function rename(id: string, e: Event): void {
  const name = ((e.target as HTMLElement).textContent ?? '').trim();
  if (name && name !== session.workspace.value.artifacts[id]?.name) setArtifactField(session.doc, id, 'name', name);
  else (e.target as HTMLElement).textContent = session.workspace.value.artifacts[id]?.name ?? '';
}
function setType(id: string, type: string): void { setArtifactField(session.doc, id, 'type', type); }
function remove(id: string): void {
  if (!deleteArtifact(session.doc, id).deleted) shell.toast('Deliverable is referenced — remove its uses first.', 'error');
}
/** index.html's #art-new: prompt for a name; an existing one of that name is pointed at, not duplicated. */
function create(): void {
  const nm = (window.prompt('New deliverable name:') || '').trim();
  if (!nm) return;
  const existing = artifacts.value.find((a) => a.name.trim().toLowerCase() === nm.toLowerCase());
  if (existing) { shell.toast(`"${existing.name}" already exists in the registry.`, 'suggest'); return; }
  addArtifact(session.doc, nm, 'other');
  shell.toast(`Deliverable "${nm}" added.`);
}
</script>
