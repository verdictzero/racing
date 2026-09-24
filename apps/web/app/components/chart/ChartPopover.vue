<template>
  <Teleport to="body">
    <!-- index.html's cell popover: the letters, clear, the Primary toggle, and who is behind the column. -->
    <div v-if="pop?.kind === 'raci' && node" ref="el" class="raci-popover" :data-id="pop.id" :data-col="pop.col" :style="pos" @click.stop>
      <button v-for="r in fw.roles" :key="r" :data-letter="r" :class="[r, { on: cellSet.has(r) }]"
        :title="`${fw.meta[r]?.label} — ${fw.meta[r]?.desc}`" @click="toggle(r)">{{ r }}</button>
      <button class="clear" data-clear="1" title="Clear" @click="clear">✕</button>
      <button v-if="cellSet.has(fw.doer) && doers.length > 1" class="primary-r" :class="{ on: primaryCol === pop.col }" data-primary="1"
        :title="`Cascade this ${fw.doer} down as the ${fw.meta[fw.owner]?.label} for the next level`" @click="primary">
        {{ primaryCol === pop.col ? '★ Cascading' : '☆ Cascade ' + fw.doer }}</button>
      <template v-if="!chart.custom">
        <div v-if="!who" class="pop-who unmapped">{{ labels.colLabel(pop.col!) }} — not mapped <span class="pw-hint">(map columns in the Legend)</span></div>
        <div v-else-if="!who.name" class="pop-who nolead">{{ who.actorLabel }} — no lead set <span class="pw-hint">(add in Roster)</span></div>
        <div v-else class="pop-who"><span class="pw-ico">👤</span><b>{{ who.name }}</b><span class="pw-role">· {{ who.actorLabel }}</span></div>
      </template>
    </div>

    <!-- Node view per party: every activity where this column holds a role, grouped by letter. -->
    <div v-else-if="pop?.kind === 'colview'" ref="el" class="raci-popover colview-popover" :style="pos" @click.stop>
      <div class="cv-head">{{ labels.colLabel(pop.col!, chart) }} <span class="cv-sub">{{ colSub }}</span></div>
      <template v-if="colTotal">
        <template v-for="l in fw.roles" :key="l">
          <div v-if="colGroups[l]?.length" class="cv-group">
            <div class="cv-group-head"><span class="raci-chip" :class="l">{{ l }}</span><span>{{ fw.meta[l]?.label }}</span><span class="cv-count">{{ colGroups[l]!.length }}</span></div>
            <button v-for="it in colGroups[l]" :key="it.node.id + (it.inherited ? ':i' : '')" type="button" class="cv-item" :data-nodeview-jump="it.node.id"
              :title="`${[...it.path, it.node.name || '(untitled)'].join(' › ')}${it.inherited ? ` — ${fw.meta[fw.owner]?.label} inherited from the cascade` : ''} · click to jump to this row`"
              @click="emit('jump', it.node.id)">
              <span class="cv-name">{{ it.node.name || '(untitled)' }}<template v-if="it.inherited">{{ ' ' }}<span class="cv-inh">(inherited)</span></template></span>
              <span class="cv-tier">{{ tierLabel(chart, it.tier) }}</span>
            </button>
          </div>
        </template>
      </template>
      <div v-else class="cv-empty">No explicit assignments for this party yet.</div>
    </div>

    <!-- Node view per row: every party with this row's chips, its IO, and its flows. -->
    <div v-else-if="pop?.kind === 'taskview' && node" ref="el" class="raci-popover colview-popover" :style="pos" @click.stop>
      <div class="cv-head">{{ node.name || '(untitled)' }}
        <span class="cv-sub">{{ tierLabel(chart, depth) }}{{ crumb ? ' · ' + crumb : '' }}</span>
      </div>
      <button v-for="k in cols" :key="k" type="button" class="cv-item" :data-taskview-col="k"
        :title="`${labels.colLabel(k, chart)} — click to pivot to this party's node view`" @click="emit('colview', k)">
        <span class="cv-name">{{ labels.colLabel(k, chart) }}</span>
        <span class="cv-chips"><div class="cell-chips"><span v-for="c in chipsFor(k)" :key="c.l + c.cls" class="raci-chip" :class="[c.l, c.cls]" :title="c.title">{{ c.l }}</span></div></span>
      </button>
      <div v-if="ioLines.length" class="cv-io-block">
        <div v-for="(io, i) in ioLines" :key="i" class="cv-io">{{ io.arrow }} {{ io.name }}<template v-if="io.src !== null">{{ ' ' }}<span class="cv-io-src" :class="{ none: io.none }">{{ io.src }}</span></template></div>
      </div>
      <button v-for="b in rowFlows" :key="b.id" type="button" class="cv-item cv-flow" :data-flow-open="b.id" title="Open this task's flow" @click="emit('openFlow', b.id)">
        <span class="cv-name">⤵ {{ b.name || 'Untitled' }}</span>
        <span class="cv-chips">{{ stepCount(b.id) }} step{{ stepCount(b.id) === 1 ? '' : 's' }}</span>
      </button>
    </div>

    <!-- Assign a Division (Program rows) or a Branch (Project rows), or an entity. -->
    <div v-else-if="pop?.kind === 'org' && node" ref="el" class="org-popover" :data-id="pop.id" :style="pos" @click.stop>
      <div v-if="!orgOpts.length" class="op-empty">No {{ pop.orgKind === 'division' ? 'divisions' : 'branches' }} in the Roster yet. Add them in the Roster tab.</div>
      <template v-for="(o, i) in orgOpts" :key="i">
        <div v-if="i === 0 || orgOpts[i - 1]!.g !== o.g" class="op-group">{{ o.g }}</div>
        <button class="op-item" :class="{ on: orgOn(o.ref) }" :data-pick="i" @click="pickOrg(o.ref)">{{ o.label }}</button>
      </template>
      <button class="op-item op-clear" data-pick="clear" @click="pickOrg(null)">✕ Clear assignment</button>
    </div>

    <!-- The ⤵ on a Task row: open an attached flow, create one from the row, or attach a standalone one. -->
    <div v-else-if="pop?.kind === 'flow' && node" ref="el" class="org-popover flow-popover" :style="pos" @click.stop>
      <template v-if="rowFlows.length">
        <div class="op-group">Attached flows</div>
        <button v-for="b in rowFlows" :key="b.id" class="op-item on" :data-flow-open="b.id" @click="emit('openFlow', b.id)">⤵ {{ b.name || 'Untitled' }} <span class="fp-meta">{{ stepCount(b.id) }} step{{ stepCount(b.id) === 1 ? '' : 's' }}</span></button>
      </template>
      <button class="op-item fp-create" :data-flow-create="node.id" @click="emit('createFlow', node.id)">＋ Create flow from this task</button>
      <template v-if="standalone.length">
        <div class="op-group">Attach a standalone flow</div>
        <button v-for="b in standalone" :key="b.id" class="op-item" :data-flow-attach="b.id" @click="emit('attachFlow', b.id, node.id)">⚓ {{ b.name || 'Untitled' }} <span class="fp-meta">{{ stepCount(b.id) }} step{{ stepCount(b.id) === 1 ? '' : 's' }}</span></button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * The chart's popovers — index.html's openRaciPopover, openColViewPopover, openTaskViewPopover,
 * openOrgPopover and openFlowPopover — positioned by the source's placePopover rules: under the
 * anchor, centred on it (left-aligned for the org picker), clamped to the viewport, flipped above
 * when there is no room below.
 */
import {
  ACTORS,
  depthOf,
  doerColumns,
  entityKindMeta,
  framework,
  inheritedOwnerColumn,
  normalizeRaci,
  primaryDoerColumn,
  tierLabel,
  walkInOrder,
  ancestorsOf,
  computeArtifactUses,
  type Chart,
  type OrgRef,
} from '@raci/core';
import { LOCAL_ORIGIN, setNodeField, setNodeRaci } from '@raci/crdt';

export interface ChartPop {
  kind: 'raci' | 'colview' | 'taskview' | 'org' | 'flow';
  anchor: DOMRect;
  id?: string;
  col?: string;
  orgKind?: 'division' | 'branch';
}

const props = defineProps<{ pop: ChartPop | null; chart: Chart; cols: readonly string[]; canEdit: boolean }>();
const emit = defineEmits<{
  close: []; jump: [nodeId: string]; colview: [col: string]; openFlow: [flowId: string];
  createFlow: [nodeId: string]; attachFlow: [flowId: string, nodeId: string];
}>();
const session = useWorkspaceSession();
const labels = useLabels();
const shell = useShell();
const { guardEdit } = useLock();

const fw = computed(() => framework(props.chart.framework));
const node = computed(() => (props.pop?.id ? props.chart.nodes[props.pop.id] ?? null : null));
const depth = computed(() => (node.value ? depthOf(props.chart.nodes, node.value.id) : 0));

// ---- placement ----
const el = ref<HTMLElement | null>(null);
const at = ref<{ top: number; left: number } | null>(null);
watch(() => props.pop, async (p) => {
  at.value = null;
  if (!p) return;
  await nextTick();
  const pr = el.value?.getBoundingClientRect();
  if (!pr) return;
  const r = p.anchor;
  let top = r.bottom + 4 + window.scrollY;
  let left = p.kind === 'org' ? r.left + window.scrollX : r.left + r.width / 2 - pr.width / 2 + window.scrollX;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  if (top + pr.height > window.scrollY + window.innerHeight - 8) {
    top = p.kind === 'raci' ? r.top - pr.height - 4 + window.scrollY : Math.max(8 + window.scrollY, r.top - pr.height - 4 + window.scrollY);
  }
  at.value = { top, left };
}, { immediate: true });
const pos = computed((): Record<string, string> => (at.value
  ? { top: `${at.value.top}px`, left: `${at.value.left}px` }
  : { top: '0px', left: '0px', visibility: 'hidden' }));

// ---- the cell popover ----
const cellSet = computed(() => new Set(normalizeRaci(node.value?.raci[props.pop?.col ?? ''] ?? '').split('').filter(Boolean)));
const doers = computed(() => (node.value ? doerColumns(node.value, props.cols, fw.value) : []));
const primaryCol = computed(() => (node.value ? primaryDoerColumn(node.value, props.cols, fw.value) : null));
const who = computed(() => (props.pop?.col ? labels.columnPerson(props.pop.col) : null));

function editable(): boolean { return props.canEdit && guardEdit('chart', props.chart); }
/** index.html's toggleRaciLetter: one explicit owner per row; a second doer prompts for a primary. */
function toggle(letter: string): void {
  const n = node.value, col = props.pop?.col;
  if (!n || !col || !editable()) return;
  const F = fw.value;
  const cur = normalizeRaci(n.raci[col] ?? '');
  const adding = !cur.includes(letter);
  if (letter === F.owner && adding) {
    const other = props.cols.find((k) => k !== col && normalizeRaci(n.raci[k] ?? '').includes(F.owner));
    if (other) {
      shell.toast(`Only one ${F.meta[F.owner]?.label} per row — ${labels.colLabel(other, props.chart)} already holds the ${F.owner}. Clear it first.`, 'error');
      return;
    }
  }
  const next = normalizeRaci(adding ? cur + letter : cur.replace(letter, ''));
  // One transaction, tagged LOCAL_ORIGIN: Yjs takes the OUTERMOST origin, and the undo manager
  // tracks only that one, so an untagged wrapper would make the edit un-undoable.
  session.doc.transact(() => {
    setNodeRaci(session.doc, n.id, col, next);
    if (letter === F.doer && !adding && n.primaryR === col) setNodeField(session.doc, n.id, 'primaryR', null);
  }, LOCAL_ORIGIN);
  if (letter === F.doer && adding) {
    const after = { ...n, raci: { ...n.raci, [col]: next } };
    if (doerColumns(after, props.cols, F).length > 1 && !primaryDoerColumn(after, props.cols, F)) {
      shell.toast(`Two ${F.meta[F.doer]?.label} parties on this line. Star the ${F.doer} that cascades down as ${F.meta[F.owner]?.label}, or split this into two process areas.`, 'suggest');
    }
  }
}
function clear(): void {
  const n = node.value, col = props.pop?.col;
  if (!n || !col || !editable()) return;
  session.doc.transact(() => {
    setNodeRaci(session.doc, n.id, col, '');
    if (n.primaryR === col) setNodeField(session.doc, n.id, 'primaryR', null);
  }, LOCAL_ORIGIN);
}
function primary(): void {
  const n = node.value, col = props.pop?.col;
  if (!n || !col || !editable()) return;
  if (!normalizeRaci(n.raci[col] ?? '').includes('R')) return;
  setNodeField(session.doc, n.id, 'primaryR', n.primaryR === col ? null : col);
}

// ---- the column node view ----
const colGroups = computed(() => {
  const out: Record<string, Array<{ node: Chart['nodes'][string]; tier: number; path: string[]; inherited: boolean }>> = {};
  const col = props.pop?.col;
  if (props.pop?.kind !== 'colview' || !col) return out;
  const F = fw.value;
  for (const l of F.roles) out[l] = [];
  for (const n of walkInOrder(props.chart.nodes)) {
    const tier = depthOf(props.chart.nodes, n.id);
    const path = ancestorsOf(props.chart.nodes, n.id).map((a) => a.name || '(untitled)');
    const own = normalizeRaci(n.raci[col] ?? '');
    for (const l of own.split('')) out[l]?.push({ node: n, tier, path, inherited: false });
    const inh = inheritedOwnerColumn(props.chart.nodes, n.id, props.cols, F)?.column ?? null;
    if (inh === col && !own.includes(F.owner)) out[F.owner]?.push({ node: n, tier, path, inherited: true });
  }
  return out;
});
const colTotal = computed(() => Object.values(colGroups.value).reduce((s, g) => s + g.length, 0));
const colSub = computed(() => {
  const w = props.chart.custom ? null : who.value;
  return w?.name ? `👤 ${w.name}` : `${colTotal.value} assignment${colTotal.value === 1 ? '' : 's'}`;
});

// ---- the row node view ----
const crumb = computed(() => (node.value ? ancestorsOf(props.chart.nodes, node.value.id).map((a) => a.name || '(untitled)').join(' › ') : ''));
function chipsFor(col: string) {
  const n = node.value!;
  const F = fw.value;
  const inh = inheritedOwnerColumn(props.chart.nodes, n.id, props.cols, F)?.column ?? null;
  const manual = new Set(normalizeRaci(n.raci[col] ?? '').split('').filter(Boolean));
  const isPrimaryR = doers.value.length > 1 && primaryCol.value === col;
  const out: Array<{ l: string; cls: string; title?: string }> = [];
  for (const l of F.roles) {
    if (manual.has(l)) out.push({ l, cls: l === F.doer && isPrimaryR ? 'primary-r' : '' });
    else if (l === F.owner && inh === col && !manual.has(F.owner)) out.push({ l: F.owner, cls: 'inherited', title: `${F.meta[F.owner]?.label} — inherited (${F.meta[F.doer]?.label} one level up)` });
  }
  if (!out.length) out.push({ l: 'I', cls: 'inherited', title: 'Informed — default (no explicit role set)' });
  return out;
}
const uses = computed(() => computeArtifactUses(session.workspace.value));
const artName = (id: string) => session.workspace.value.artifacts[id]?.name ?? id;
const ioLines = computed(() => {
  const n = node.value;
  if (!n || props.pop?.kind !== 'taskview') return [];
  const lines: Array<{ arrow: string; name: string; src: string | null; none?: boolean }> = [];
  for (const aid of n.inputs) {
    const prod = (uses.value.get(aid)?.producers ?? []).filter((u) => u.nodeId !== n.id);
    lines.push(prod.length
      ? { arrow: '⇥', name: artName(aid), src: `from ${prod.map((u) => u.name).join(', ')}` }
      : { arrow: '⇥', name: artName(aid), src: 'no producer', none: true });
  }
  for (const aid of n.outputs) {
    const cons = (uses.value.get(aid)?.consumers ?? []).filter((u) => u.nodeId !== n.id);
    lines.push({ arrow: '↦', name: artName(aid), src: cons.length ? `to ${cons.map((u) => u.name).join(', ')}` : null });
  }
  return lines;
});

// ---- flows on a row ----
const rowFlows = computed(() => {
  const n = node.value;
  if (!n) return [];
  if (props.pop?.kind === 'taskview' && (props.chart.custom || depth.value < 3)) return [];
  return Object.values(session.workspace.value.flows).filter((b) => b.anchor?.chartId === props.chart.id && b.anchor.nodeId === n.id);
});
const standalone = computed(() => Object.values(session.workspace.value.flows).filter((b) => !b.anchor));
const stepCount = (id: string) => Object.keys(session.workspace.value.flows[id]?.steps ?? {}).length;

// ---- the org picker ----
const orgOpts = computed(() => {
  const out: Array<{ ref: OrgRef; label: string; g: string }> = [];
  if (props.pop?.kind !== 'org') return out;
  const ws = session.workspace.value;
  for (const actor of ACTORS) {
    for (const div of ws.roster[actor]?.divisions ?? []) {
      if (props.pop.orgKind === 'division') {
        out.push({ ref: { actor, divisionId: div.id }, label: div.name || 'Untitled division', g: labels.actorLabel(actor) });
      } else {
        for (const br of div.branches) {
          out.push({ ref: { actor, divisionId: div.id, branchId: br.id }, label: br.name || 'Untitled branch', g: `${labels.actorLabel(actor)} › ${div.name || '—'}` });
        }
      }
    }
  }
  for (const e of Object.values(ws.entities)) {
    out.push({ ref: { entityId: e.id }, label: `${entityKindMeta(e.kind).icon}  ${e.name?.trim() || 'Untitled entity'}`, g: 'Entities' });
  }
  return out;
});
function orgOn(ref: OrgRef): boolean {
  const cur = (node.value?.org ?? {}) as Record<string, string | undefined>;
  if ('entityId' in ref) return cur.entityId === ref.entityId;
  return props.pop?.orgKind === 'division'
    ? cur.divisionId === ref.divisionId && !cur.branchId
    : cur.branchId === ref.branchId;
}
function pickOrg(ref: OrgRef | null): void {
  const n = node.value;
  emit('close');
  if (!n || !editable()) return;
  setNodeField(session.doc, n.id, 'org', ref);
}
</script>
