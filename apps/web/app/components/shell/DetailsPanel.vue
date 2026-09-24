<template>
  <div id="det-body">
    <div v-if="!found" class="det-empty">Click any activity name in the chart to view or edit its definition and attach process documents.</div>
    <template v-else>
      <span class="det-tier">{{ tier }} activity</span>
      <div class="det-name">{{ found.node.name || '(untitled)' }}</div>

      <div class="det-section">
        <h4>Who's responsible</h4>
        <div v-if="!who.length" class="det-doc-empty">No roles assigned yet.</div>
        <div v-else class="dw-list">
          <div v-for="w in who" :key="w.col" class="dw-row">
            <div class="dw-col">{{ w.label }}<template v-if="w.inherited">{{ ' ' }}<span class="dw-inh"
              :title="`Inherited ${fw.meta[fw.owner]?.label} from the cascade`">(inherited)</span></template></div>
            <div class="dw-chips">
              <div v-if="!w.letters" class="cell-chips empty">·</div>
              <div v-else class="cell-chips"><span v-for="l in w.letters.split('')" :key="l" class="raci-chip" :class="l">{{ l }}</span></div>
            </div>
            <div class="dw-who">
              <template v-if="!found.chart.custom">
                <span v-if="!w.person" class="dw-note">column not mapped</span>
                <span v-else-if="w.person.name" class="dw-person">👤 {{ w.person.name }}</span>
                <span v-else class="dw-note">no lead set</span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isTaskTier" class="det-section">
        <h4>Task flow</h4>
        <ul v-if="flows.length" class="det-flow-list">
          <li v-for="b in flows" :key="b.id" class="det-flow">
            <button class="df-open" type="button" :data-flow-open="b.id" title="Open this flow" @click="openFlow(b.id)">⤵ {{ b.name || 'Untitled' }}</button>
            <span class="df-meta">{{ stepCount(b) }} step{{ stepCount(b) === 1 ? '' : 's' }} · {{ edgeCount(b) }} handoff{{ edgeCount(b) === 1 ? '' : 's' }}</span>
          </li>
        </ul>
        <div v-else class="det-doc-empty">No flow attached — the ⤵ on this row (or the button below) continues the drill into step-level tasking.</div>
        <button class="det-upload" type="button" :data-flow-btn="found.node.id" @click="flowRequest = found.node.id">⤵ Create / attach flow</button>
      </div>

      <div v-for="io in ioSections" :key="io.kind" class="det-section">
        <h4>{{ io.label }}</h4>
        <div class="det-io-list">
          <span v-if="!io.ids.length" class="det-io-none">none declared</span>
          <span v-for="aid in io.ids" :key="aid" class="det-io-chip" :title="ioTitle(io.kind, aid)">{{ artName(aid) }}<button
            type="button" class="det-io-rm" :data-io-rm="aid" :data-io-kind="io.kind" title="Remove" :disabled="!canEdit"
            @click="removeIo(io.kind, aid)">×</button></span>
        </div>
        <select class="det-io-add" :data-io-add="io.kind" :disabled="!canEdit" @change="addIo(io.kind, $event)">
          <option value="">＋ add deliverable…</option>
          <option v-for="a in addable(io.ids)" :key="a.id" :value="a.id">{{ a.name }} ({{ a.type }})</option>
          <option value="__new">＋ new deliverable…</option>
        </select>
      </div>

      <div class="det-section">
        <h4>Definition</h4>
        <textarea id="det-desc" placeholder="Describe what this activity covers — purpose, scope, decisions, hand-offs."
          :value="found.node.description" :disabled="!canEdit"
          @input="setNodeField(session.doc, found.node.id, 'description', ($event.target as HTMLTextAreaElement).value)" />
      </div>

      <div class="det-section">
        <h4>Process documents</h4>
        <ul v-if="found.node.documents.length" class="det-doc-list">
          <li v-for="d in found.node.documents" :key="d.id" class="det-doc" :data-doc-id="d.id">
            <span class="dd-name" :title="d.name">{{ d.name }}</span>
            <span class="dd-size">{{ fmtBytes(d.size) }}</span>
            <button class="dd-btn dd-dl" type="button" :data-doc-download="d.id" title="Download" @click="docs.download(d.id)">⬇</button>
            <button class="dd-btn dd-del" type="button" :data-doc-delete="d.id" title="Remove" :disabled="!canEdit"
              @click="docs.remove(found.node.id, d.id)">×</button>
          </li>
        </ul>
        <div v-else class="det-doc-empty">No documents attached yet.</div>
        <button id="det-upload-btn" class="det-upload" type="button" :disabled="!canEdit" @click="emit('attach', found.node.id)">+ Attach document</button>
        <div class="det-cap-note">Files are stored with this workspace on the server (never inside the shared document), and embedded into the JSON export (base64). Soft cap ~3 MB per file.</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The Activity Details rail — index.html's renderDetails, for the row selected on the chart
 * screen. The only wording that differs from the source is the storage note under Process
 * documents: the source says the files live in "this browser's IndexedDB", which is not true here
 * and would tell someone their attachment is private to their machine when it is shared.
 */
import {
  COLS,
  MAX_TIER,
  computeArtifactUses,
  depthOf,
  framework,
  inheritedOwnerColumn,
  normalizeRaci,
  tierLabel,
  type Flow,
} from '@raci/core';
import { addArtifact, setNodeField } from '@raci/crdt';
import { fmtBytes } from '~/composables/useDocuments';

const props = defineProps<{ canEdit: boolean }>();
const emit = defineEmits<{ attach: [nodeId: string] }>();
const session = useWorkspaceSession();
const labels = useLabels();
const docs = useDocuments();
const { activeNodeId } = useChartView();
const activeFlowId = useActiveFlowId();
/** Asks the chart screen to open its flow popover on this row's ⤵ — openFlowForNode in the source. */
const flowRequest = useState<string | null>('raci:flowPopoverFor', () => null);

const found = computed(() => {
  const id = activeNodeId.value;
  if (!id) return null;
  for (const chart of Object.values(session.workspace.value.charts)) {
    const node = chart.nodes[id];
    if (node) return { chart, node, depth: depthOf(chart.nodes, id) };
  }
  return null;
});
const fw = computed(() => framework(found.value?.chart.framework));
const tier = computed(() => (found.value ? tierLabel(found.value.chart, found.value.depth) : ''));
const isTaskTier = computed(() => !!found.value && !found.value.chart.custom && found.value.depth >= MAX_TIER);

const columns = computed(() => (found.value?.chart.custom ? found.value.chart.custom.cols.map((c) => c.key) : [...COLS]));
const who = computed(() => {
  const f = found.value;
  if (!f) return [];
  const inh = inheritedOwnerColumn(f.chart.nodes, f.node.id, columns.value, fw.value)?.column ?? null;
  return columns.value
    .filter((k) => normalizeRaci(f.node.raci[k] ?? '') || k === inh)
    .map((k) => {
      const own = normalizeRaci(f.node.raci[k] ?? '');
      const inherited = k === inh && !own.includes(fw.value.owner);
      return {
        col: k,
        label: labels.colLabel(k, f.chart),
        inherited,
        letters: inherited ? normalizeRaci(own + fw.value.owner) : own,
        person: labels.columnPerson(k),
      };
    });
});

const flows = computed(() => {
  const f = found.value;
  if (!f) return [];
  return Object.values(session.workspace.value.flows)
    .filter((b) => b.anchor?.chartId === f.chart.id && b.anchor.nodeId === f.node.id);
});
const stepCount = (b: Flow) => Object.keys(b.steps).length;
const edgeCount = (b: Flow) => Object.keys(b.edges).length;
async function openFlow(id: string): Promise<void> {
  activeFlowId.value = id;
  await navigateTo(`/w/${session.workspaceId}/flow`);
}

// ---- boundary IO ----
const uses = computed(() => computeArtifactUses(session.workspace.value));
const ioSections = computed(() => {
  const n = found.value?.node;
  return n ? [
    { kind: 'in' as const, label: 'Inputs — consumes', ids: n.inputs },
    { kind: 'out' as const, label: 'Outputs — produces', ids: n.outputs },
  ] : [];
});
const artName = (id: string) => session.workspace.value.artifacts[id]?.name ?? id;
function ioTitle(kind: 'in' | 'out', aid: string): string {
  const n = found.value?.node;
  const u = uses.value.get(aid);
  const others = (kind === 'in' ? u?.producers : u?.consumers)?.filter((x) => x.nodeId !== n?.id) ?? [];
  const names = others.map((x) => x.name).filter(Boolean);
  const rel = kind === 'in'
    ? (names.length ? ` — from: ${names.join(', ')}` : ' — no producer anywhere')
    : (names.length ? ` — consumed by: ${names.join(', ')}` : '');
  return artName(aid) + rel;
}
const addable = (ids: readonly string[]) => Object.values(session.workspace.value.artifacts).filter((a) => !ids.includes(a.id));
function addIo(kind: 'in' | 'out', e: Event): void {
  const sel = e.target as HTMLSelectElement;
  const val = sel.value;
  sel.value = '';
  const n = found.value?.node;
  if (!val || !n) return;
  let aid = val;
  if (val === '__new') {
    const nm = (window.prompt('New deliverable name:') || '').trim();
    if (!nm) return;
    const existing = Object.values(session.workspace.value.artifacts).find((a) => a.name.trim().toLowerCase() === nm.toLowerCase());
    aid = existing ? existing.id : addArtifact(session.doc, nm, 'other');
  }
  const key = kind === 'in' ? 'inputs' : 'outputs';
  if (!n[key].includes(aid)) setNodeField(session.doc, n.id, key, [...n[key], aid]);
}
function removeIo(kind: 'in' | 'out', aid: string): void {
  const n = found.value?.node;
  if (!n) return;
  const key = kind === 'in' ? 'inputs' : 'outputs';
  setNodeField(session.doc, n.id, key, n[key].filter((x) => x !== aid));
}
</script>
