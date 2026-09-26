<template>
  <!-- index.html's #bz-canvas, element for element (renderBizcase's canvas half): the empty note,
       #bz-world with the handoff layer, the frames (bizGroupHtml), the cards (bizNodeHtml /
       bizSubflowHtml) and the redirector layer, then the zoom pills and the minimap. The two SVG
       layers are painted by drawEdges() exactly as drawBizEdges paints them, from live socket
       measurements; everything else is the source's markup bound to the document. -->
  <div id="bz-canvas" ref="canvasEl" class="bz-canvas"
    @mousedown="onMouseDown" @click="onClick" @dblclick="onDblClick" @contextmenu="onContextMenu"
    @dragover="onDragOver" @drop="onDrop">
    <div v-if="!stepCount" class="bz-empty">No tasks yet.<br>Click <b>+ Add task</b> to drop the first step onto the canvas,<br>or drag a flow in from the gallery to nest it.</div>
    <div id="bz-world" ref="worldEl" class="bz-world">
      <svg id="bz-edges" ref="edgesEl" class="bz-edges" xmlns="http://www.w3.org/2000/svg" />
      <div v-for="fr in frames" :key="fr.id" class="bz-group" :class="{ collapsed: fr.collapsed, selected: selectedGroup === fr.id }"
        :data-bz-group="fr.id" :data-color="fr.color" :style="fr.collapsed ? frameStyle(fr.id) : undefined">
        <div class="bz-group-head" :title="`Steps in this frame stay in it however you rearrange them, and the frame resizes to follow. Hold ${BZ_DETACH_KEY_LONG} while dragging one to pull it out.`">
          <span class="bz-grp-grip" aria-hidden="true" title="Drag to move the whole group">⠿</span>
          <button class="bz-grp-btn bz-grp-collapse" type="button" :data-bz-group-collapse="fr.id"
            :title="fr.collapsed ? 'Expand — show the steps again' : 'Collapse — fold these steps into one box whose sockets are the group’s real connections'">{{ fr.collapsed ? '▸' : '▾' }}</button>
          <span v-editable-text="{ text: fr.name, commit: (v: string) => commitGroupName(fr.id, v) }" class="bz-group-name"
            :contenteditable="ce" spellcheck="false" :data-bz-group-name="fr.id" data-placeholder="Group name" />
          <span class="bz-grp-spacer" />
          <span class="bz-grp-hint" aria-hidden="true"><b class="bz-grp-key">{{ BZ_DETACH_KEY }}</b><span class="bz-grp-hint-txt">hold to drag out of the frame</span><span class="bz-grp-hint-alt">release to leave this frame</span></span>
          <span class="bz-grp-count">{{ fr.count }} step{{ fr.count === 1 ? '' : 's' }}</span>
          <button class="bz-grp-btn" type="button" :data-bz-group-color="fr.id" title="Cycle the frame colour">◧</button>
          <button class="bz-grp-btn" type="button" :data-bz-group-ungroup="fr.id" title="Ungroup — release the steps, keep them where they are">⤨</button>
          <button class="bz-grp-btn bz-grp-del" type="button" :data-bz-group-del="fr.id" title="Delete the frame (the steps stay on the canvas)">×</button>
        </div>
        <div v-if="fr.collapsed" class="bz-grp-body">
          <div class="bz-grp-folded">{{ fr.count }} step{{ fr.count === 1 ? '' : 's' }} folded</div>
          <template v-if="fr.ins.length || fr.outs.length">
            <template v-if="fr.ins.length">
              <div class="bz-port-h in">in<span class="bz-port-n">{{ fr.ins.length }}</span></div>
              <div v-for="p in fr.ins" :key="`in:${p.id}`" class="bz-port-row">
                <span class="bz-socket in is-port" data-bz-socket="in" :data-bz-node-id="p.id" :data-port="p.id" :title="`Into the group — ${p.name}`" />
                <span class="bz-port-name" :title="p.name">{{ p.name }}</span>
              </div>
            </template>
            <template v-if="fr.outs.length">
              <div class="bz-port-h out">out<span class="bz-port-n">{{ fr.outs.length }}</span></div>
              <div v-for="p in fr.outs" :key="`out:${p.id}`" class="bz-port-row">
                <span class="bz-socket out is-port" data-bz-socket="out" :data-bz-node-id="p.id" :data-port="p.id" :title="`Out of the group — ${p.name}`" />
                <span class="bz-port-name" :title="p.name">{{ p.name }}</span>
              </div>
            </template>
          </template>
          <div v-else class="bz-grp-sealed">no connections cross this group</div>
        </div>
      </div>
      <template v-for="c in cards" :key="c.id">
        <!-- bizNodeHtml: a plain step. -->
        <div v-if="c.kind === 'step'" class="bz-node"
          :class="{ 'bz-node--decision': c.decision, selected: isSelected(c.id), 'bz-flash': flashId === c.id }"
          :data-bz-node="c.id" :style="nodeStyle(c.id)">
          <span class="bz-socket in" data-bz-socket="in" :data-bz-node-id="c.id" title="Input" />
          <span class="bz-socket out" data-bz-socket="out" :data-bz-node-id="c.id" title="Output — drag onto another box to connect (draw more than one to branch)" />
          <span v-if="c.pin" class="violation-pin bz-pin" :class="{ warn: c.pin.warn }" :title="c.pin.title">!</span>
          <div class="bz-node-head">
            <span v-editable-text="{ text: c.name, commit: (v: string) => commitStepText(c.id, 'name', v) }" class="bz-node-name"
              :contenteditable="ce" spellcheck="false" :data-bz-name="c.id" data-placeholder="Task name" />
            <span v-if="c.decision" class="bz-decision-badge" :title="`Decision point — ${c.outCount} outgoing paths`">⑂ {{ c.outCount }}</span>
            <button class="bz-node-copy" :data-bz-copy-task="c.id" title="Copy this step (Ctrl+C copies the selected step · Ctrl+V pastes)">⧉</button>
            <button class="bz-node-del" :data-bz-del-task="c.id" title="Delete task">×</button>
          </div>
          <template v-if="c.bind">
            <button v-if="c.bind.state === 'unset'" class="bz-bind is-unset" type="button" :data-bz-bind="c.id"
              title="This flow is Chart-Linked — every step names the chart row it implements. Click to pick one."><span class="bzb-ico">⛓</span><span class="bzb-txt">link this step to a chart row</span></button>
            <button v-else-if="c.bind.state === 'broken'" class="bz-bind is-broken" type="button" :data-bz-bind="c.id"
              title="The linked chart row is gone — the chart was deleted, the row removed, or an import didn’t carry it. Click to re-point this step."><span class="bzb-ico">⛓</span><span class="bzb-txt">linked row is missing — re-point</span></button>
            <div v-else class="bz-bind-wrap">
              <button class="bz-bind" :class="{ 'is-foreign': c.bind.foreign }" type="button" :data-bz-bind="c.id" :title="c.bind.title">
                <span class="bzb-ico">⛓</span>
                <span class="bzb-tier">{{ c.bind.tier }}</span>
                <span class="bzb-txt">{{ c.bind.name }}</span>
                <span v-if="c.bind.over" class="bzb-over" :title="`${c.bind.over} column${c.bind.over === 1 ? '' : 's'} overridden here`">±{{ c.bind.over }}</span>
              </button>
              <button class="bzb-jump" type="button" :data-bz-bind-jump="c.id" title="Open this row in the org chart">⤴</button>
            </div>
          </template>
          <div v-editable-text="{ text: c.description, commit: (v: string) => commitStepText(c.id, 'description', v) }" class="bz-node-desc"
            :contenteditable="ce" spellcheck="false" :data-bz-desc="c.id" data-placeholder="＋ description — what this step is for" />
          <div class="bz-node-crit">
            <div class="bz-crit-row"><span class="bz-crit-lbl entry" title="Entry criteria — what must be true before this step can start">entry</span><span
              v-editable-text="{ text: c.entry, commit: (v: string) => commitStepText(c.id, 'entry', v) }" class="bz-crit-edit"
              :contenteditable="ce" spellcheck="false" :data-bz-entry="c.id" data-placeholder="＋ entry criteria" /></div>
            <div class="bz-crit-row"><span class="bz-crit-lbl exit" title="Exit criteria — what done looks like; what must be true to hand off">exit</span><span
              v-editable-text="{ text: c.exit, commit: (v: string) => commitStepText(c.id, 'exit', v) }" class="bz-crit-edit"
              :contenteditable="ce" spellcheck="false" :data-bz-exit="c.id" data-placeholder="＋ exit criteria" /></div>
          </div>
          <div class="bz-node-body">
            <div v-for="cell in c.cells" :key="cell.col" class="bz-cell" :class="{ 'is-linked': cell.linked }"
              :data-bz-cell="c.id" :data-col="cell.col" :title="cell.title">
              <span class="bz-cell-col">{{ cell.short }}</span>
              <div v-if="cell.chips.length" class="cell-chips"><span v-for="(ch, i) in cell.chips" :key="i" class="raci-chip" :class="ch.cls" :title="ch.title">{{ ch.text }}</span></div>
              <div v-else class="cell-chips empty">·</div>
            </div>
          </div>
          <div v-if="c.inputs || c.outputs" class="bz-node-io"><div v-if="c.inputs" class="bz-io-line in"
            title="Inputs — deliverables arriving on incoming handoffs">{{ c.inputs }}</div><div v-if="c.outputs" class="bz-io-line out"
            title="Outputs — deliverables leaving on outgoing handoffs">{{ c.outputs }}</div></div>
          <div v-if="c.parties.length" class="bz-node-parties">
            <button v-for="p in c.parties" :key="p.col" class="bz-party-row"
              :class="{ active: isPartyTarget(c.id, p.col), 'is-unset': p.unset, 'is-inherited': p.inherited }" type="button"
              :data-bz-party="c.id" :data-col="p.col" :title="p.title">
              <span class="bz-party-col">{{ p.short }}</span>
              <div class="cell-chips"><span v-for="l in p.letters" :key="l" class="raci-chip" :class="l">{{ l }}</span></div>
              <span v-if="p.hier" class="bz-party-tree"><PartyTree :hier="p.hier" /></span>
              <span v-else class="bz-party-label">+ set responsible party</span>
            </button>
          </div>
        </div>

        <!-- bizSubflowHtml, broken reference: kept on the canvas so its wiring can be re-pointed. -->
        <div v-else-if="c.broken" class="bz-node bz-node--sub is-broken"
          :class="{ selected: isSelected(c.id), 'bz-flash': flashId === c.id }" :data-bz-node="c.id" :style="nodeStyle(c.id)">
          <span v-if="c.pin" class="violation-pin bz-pin" :class="{ warn: c.pin.warn }" :title="c.pin.title">!</span>
          <div class="bz-node-head">
            <span class="bz-sub-glyph" aria-hidden="true">⧉</span>
            <span v-editable-text="{ text: c.name, commit: (v: string) => commitStepText(c.id, 'name', v) }" class="bz-node-name"
              :contenteditable="ce" spellcheck="false" :data-bz-name="c.id" data-placeholder="Nested flow" />
            <button class="bz-node-copy" :data-bz-copy-task="c.id" title="Copy this box (Ctrl+C copies the selected box · Ctrl+V pastes)">⧉</button>
            <button class="bz-node-del" :data-bz-del-task="c.id" title="Remove this box (the referenced flow itself is untouched)">×</button>
          </div>
          <div class="bz-sub-broken">Nested flow is missing — the business case it pointed at was deleted, or an import didn't carry it. <button
            type="button" class="bz-sub-repoint" :data-bz-repoint="c.id">Point at another flow…</button></div>
        </div>

        <!-- bizSubflowHtml: one box standing in for a whole other flow. -->
        <div v-else class="bz-node bz-node--sub" :class="{ selected: isSelected(c.id), 'bz-flash': flashId === c.id }"
          :data-bz-node="c.id" :style="nodeStyle(c.id)">
          <span v-if="c.pin" class="violation-pin bz-pin" :class="{ warn: c.pin.warn }" :title="c.pin.title">!</span>
          <div class="bz-node-head">
            <span class="bz-sub-glyph" aria-hidden="true">⧉</span>
            <span v-editable-text="{ text: c.name, commit: (v: string) => commitStepText(c.id, 'name', v) }" class="bz-node-name"
              :contenteditable="ce" spellcheck="false" :data-bz-name="c.id" :data-placeholder="c.placeholder" />
            <button class="bz-sub-open" :data-bz-open-sub="c.id" :title="c.openTitle">⇱</button>
            <button class="bz-node-copy" :data-bz-copy-task="c.id" title="Copy this box (Ctrl+C copies the selected box · Ctrl+V pastes)">⧉</button>
            <button class="bz-node-del" :data-bz-del-task="c.id" title="Remove this box (the referenced flow itself is untouched)">×</button>
          </div>
          <div class="bz-sub-ref">
            <button type="button" class="bz-sub-ref-name" :data-bz-repoint="c.id"
              title="This box is a reference — the flow itself lives in the gallery under this name. Click to point it at a different flow.">{{ c.refName }}</button>
            <span class="bz-sub-ref-meta">{{ c.refMeta }}</span>
          </div>
          <div v-editable-text="{ text: c.description, commit: (v: string) => commitStepText(c.id, 'description', v) }" class="bz-node-desc"
            :contenteditable="ce" spellcheck="false" :data-bz-desc="c.id" data-placeholder="＋ note — why this flow is called here" />
          <div class="bz-sub-ports">
            <div class="bz-port-h in">entry points<span class="bz-port-n">{{ c.openIn }} of {{ c.ins.length }} exposed</span></div>
            <div v-for="p in c.ins" :key="`in:${p.id}`" class="bz-port-row" :class="{ 'is-off': !p.on }">
              <span v-if="p.on" class="bz-socket in is-port" data-bz-socket="in" :data-bz-node-id="c.id" :data-port="p.id" :title="p.sockTitle" />
              <button class="bz-port-tgl" type="button" :data-bz-port="c.id" data-side="in" :data-port-id="p.id"
                :aria-pressed="p.on ? 'true' : 'false'" :title="p.tglTitle">{{ p.on ? '◉' : '○' }}</button>
              <span class="bz-port-name" :title="p.name">{{ p.name }}</span>
            </div>
            <div class="bz-port-h out">exit points<span class="bz-port-n">{{ c.openOut }} of {{ c.outs.length }} exposed</span></div>
            <div v-for="p in c.outs" :key="`out:${p.id}`" class="bz-port-row" :class="{ 'is-off': !p.on }">
              <span v-if="p.on" class="bz-socket out is-port" data-bz-socket="out" :data-bz-node-id="c.id" :data-port="p.id" :title="p.sockTitle" />
              <button class="bz-port-tgl" type="button" :data-bz-port="c.id" data-side="out" :data-port-id="p.id"
                :aria-pressed="p.on ? 'true' : 'false'" :title="p.tglTitle">{{ p.on ? '◉' : '○' }}</button>
              <span class="bz-port-name" :title="p.name">{{ p.name }}</span>
            </div>
          </div>
          <div v-if="c.rollup.length" class="bz-sub-roles" title="Roles assigned inside the nested flow (read-only — edit them in the flow itself)">
            <span v-for="r in c.rollup" :key="r.col" class="bzs-col" :title="r.title"><span class="bzs-col-key">{{ r.short }}</span><span
              v-for="l in r.letters" :key="l" class="raci-chip" :class="l">{{ l }}</span></span>
          </div>
        </div>
      </template>
      <!-- Redirector handles ride in their own layer ABOVE the cards: a handle a card covers is a
           handle you cannot grab. -->
      <svg id="bz-redirs" ref="redirsEl" class="bz-redirs" xmlns="http://www.w3.org/2000/svg" />
    </div>
    <div id="bz-zoom-ctl" class="zoom-ctl">
      <button id="bz-zoom-out" title="Zoom out">−</button>
      <span id="bz-zoom-level" ref="zoomEl" class="zoom-level" title="Reset to 100%" />
      <button id="bz-zoom-in" title="Zoom in">+</button>
      <button id="bz-zoom-fit" title="Fit all tasks in view">⤢</button>
    </div>
    <canvas id="bz-minimap" ref="miniEl" width="200" height="140" title="Minimap — click or drag to move the view" />
  </div>
</template>

<script lang="ts">
import type { FlowStep } from '@raci/core';

// ---- per-session state that outlives one visit to the screen (index.html's module globals) --------
/** _bizClip — the step clipboard (Ctrl+C / Ctrl+X / ⧉), shared by every flow. */
let clip: Omit<FlowStep, 'id' | 'flowId'> | null = null;
/** _bizPasteN — how many times the clip has been pasted since it was taken: each lands 28px further. */
let pasteN = 0;
/** _bizRoutedOnce — "double-click removes a redirector" is taught once a session. */
let routedOnce = false;
</script>

<script setup lang="ts">
/**
 * The flow canvas — everything inside index.html's #bz-canvas, and every gesture on it.
 *
 * The cards, frames and pills are the source's markup (see the template); the handoff noodles,
 * the frames' size and the minimap are drawn after each render from measurements of that markup,
 * exactly as bizLayoutGroups / drawBizEdges / drawBizMinimap do, because card heights are content
 * and only the laid-out DOM knows them. The gestures are index.html's delegated mousedown /
 * mousemove / mouseup / click / dblclick / wheel / keydown / contextmenu handlers, branch for
 * branch and in their order.
 *
 * Where it differs, it is because the source's state is one person's and this document is
 * everyone's: a drag moves the DOM live (as the source does) and writes to the shared document
 * once, when it lands, as one step of undo; the camera, the selection and the clipboard stay this
 * person's (useFlowScreen). A Final flow refuses the write with the words index.html's lock uses.
 */
import { h, type FunctionalComponent, type VNode } from 'vue';
import {
  COLS,
  createLintContext,
  embedWouldCycle,
  viewViolations,
  violationIndex,
  type Flow,
} from '@raci/core';
import {
  LOCAL_ORIGIN,
  addEdge,
  addGroupFrame,
  addStep,
  deleteEdge,
  deleteGroup,
  deleteStep,
  maps,
  moveSteps,
  setEdgeField,
  setField,
  setGroupField,
  setStepField,
  setStepRaci,
} from '@raci/crdt';
import type { CtxEntry } from '~/composables/useContextMenu';
import type { FlowAnchor } from '~/composables/useFlowScreen';
import { vEditableText } from '~/composables/roster/edits';
import {
  ACCENT,
  BZ_DETACH_KEY,
  BZ_DETACH_KEY_LONG,
  BZ_GROUP_COLORS,
  BZ_GROUP_PAD,
  BZ_NODE_W,
  BZ_ZOOM_MAX,
  BZ_ZOOM_MIN,
  copyName,
  edgeKey,
  edgesOf,
  escapeHtml,
  flowCtx,
  frameVM,
  groupMembers,
  groupsOf,
  hiddenTaskIds,
  isSubflow,
  nestedCard,
  refFlow,
  stepCard,
  stepsOf,
  subflowOpenPorts,
  subflowPorts,
  taskLabel,
  defaultPartyForTask,
  type PartyLevel,
} from '~/composables/flow-canvas/model';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();

const session = useWorkspaceSession();
const doc = session.doc;
const wsId = session.workspaceId;
const shell = useShell();
const menu = useContextMenu();
const { refuseLockedEdit, guardEdit } = useLock();
const fs = useFlowScreen();
const { selection, selectedGroup, partyTarget, partyDraft, popover } = fs;
const activeChartId = useActiveChartId();
const activeFlowId = useActiveFlowId();
const route = useRoute();
const router = useRouter();

const ws = computed(() => session.workspace.value);
const ce = computed(() => (props.canEdit ? 'true' : 'false'));

// ---- the cards, frames and pins (renderBizcase's content) -------------------------------------------
const ctx = computed(() => {
  const f = props.flow;
  return f ? flowCtx(ws.value, f, createLintContext(ws.value, activeChartId.value)) : null;
});
/** _violationsByBizTaskId: the open flow linted as index.html lints it in this view. */
const vioByStep = computed(() => {
  const f = props.flow;
  if (!f) return new Map();
  return violationIndex(viewViolations(ws.value, { view: 'bizcase', chartId: activeChartId.value, flowId: f.id })).byStepId;
});
const stepCount = computed(() => (props.flow ? Object.keys(props.flow.steps).length : 0));
const cards = computed(() => {
  const c = ctx.value;
  if (!c) return [];
  const hidden = hiddenTaskIds(c.flow);
  return stepsOf(c.flow)
    .filter((t) => !hidden.has(t.id))
    .map((t) => (isSubflow(t) ? nestedCard(c, t, vioByStep.value.get(t.id)) : stepCard(c, t, vioByStep.value.get(t.id))));
});
const frames = computed(() => {
  const c = ctx.value;
  return c ? groupsOf(c.flow).map((g) => frameVM(c, g)) : [];
});

/** partyTreeHtml: the party's hierarchy as nested capsules, the outer one the directorate. */
const PartyTree: FunctionalComponent<{ hier: PartyLevel[] }> = (p) =>
  p.hier.reduceRight<VNode | null>((inner, n) => h('span', { class: ['bz-party-lvl', `k-${n.kind}`, inner ? null : 'is-leaf'] },
    inner ? [h('span', { class: 'bz-party-lbl' }, n.name), inner] : [h('span', { class: 'bz-party-lbl' }, n.name)]), null);
PartyTree.props = ['hier'];

const isSelected = (id: string) => selection.value.includes(id);
const isPartyTarget = (id: string, col: string) => partyTarget.value?.taskId === id && partyTarget.value.col === col;
/** bizFrontId — the last box dragged sits above the rest. Per session, as in the source. */
const frontId = useState<string | null>('raci:flow:frontId', () => null);
/** A jump target flashing (bizJumpToTask's bz-flash). */
const flashId = ref<string | null>(null);

// Positions mid-gesture. index.html moves its model in memory during a drag and saves on drop; here
// the document is shared, so the drag lives in these maps (and the DOM) and is written once.
const live = new Map<string, { x: number; y: number }>();
const liveGroup = new Map<string, { x: number; y: number }>();
const liveVia = new Map<string, Array<{ x: number; y: number }>>();
function stepPos(id: string): { x: number; y: number } {
  return live.get(id) ?? props.flow?.steps[id] ?? { x: 0, y: 0 };
}
function groupPos(id: string): { x: number; y: number } {
  return liveGroup.get(id) ?? props.flow?.groups[id] ?? { x: 0, y: 0 };
}
function nodeStyle(id: string): string {
  const p = stepPos(id);
  return `left:${Math.round(p.x)}px; top:${Math.round(p.y)}px;${id === frontId.value ? ' z-index:6;' : ''}`;
}
function frameStyle(id: string): string {
  const p = groupPos(id);
  return `left:${Math.round(p.x)}px; top:${Math.round(p.y)}px;`;
}

// ---- elements ----------------------------------------------------------------------------------------
const canvasEl = ref<HTMLElement | null>(null);
const worldEl = ref<HTMLElement | null>(null);
const edgesEl = ref<SVGSVGElement | null>(null);
const redirsEl = ref<SVGSVGElement | null>(null);
const miniEl = ref<HTMLCanvasElement | null>(null);
const zoomEl = ref<HTMLElement | null>(null);
/** An id inside an attribute selector. */
const q = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id);
const nodeEl = (id: string) => worldEl.value?.querySelector<HTMLElement>(`.bz-node[data-bz-node="${q(id)}"]`) ?? null;

// ---- editing: who may, and the Final lock ------------------------------------------------------------
/** Someone who can edit, on a flow. A viewer's gesture does nothing (the server refuses it anyway). */
const editable = () => props.canEdit && !!props.flow;
/** guardFlowEdit — for the actions index.html guards itself: its standard refusal. */
const guarded = () => editable() && guardEdit('flow', props.flow);
/**
 * Everything else index.html lets through and then rolls back in saveState (enforceLocks), with its
 * words. Returns whether the write went ahead; the caller's own toasts follow either way, as there.
 */
function commit(write: () => void): boolean {
  const f = props.flow;
  if (!f || !props.canEdit) return false;
  if (f.status === 'final') {
    refuseLockedEdit('flow', `“${f.name || 'Untitled'}” is Final — that change was rolled back. Reopen it as a draft to edit it.`);
    // index.html renders after the rollback all the same.
    void nextTick(() => { layoutAll(); freshRaster(); });
    return false;
  }
  write();
  return true;
}
const toast = (m: string, type?: 'suggest' | 'error') => shell.toast(m, type);

// ---- selection (bizSelect / bizSyncSelectionUI) -----------------------------------------------------
function bizSelect(id: string | null, additive = false): void {
  let sel = additive ? [...selection.value] : [];
  if (id) {
    if (additive && sel.includes(id)) sel = sel.filter((x) => x !== id);
    else { sel = sel.filter((x) => x !== id); sel.push(id); } // re-added so it becomes the primary
  }
  selection.value = sel;
  if (!additive) selectedGroup.value = null;
}

// ---- the camera (b.view) -----------------------------------------------------------------------------
const cam = { panX: 0, panY: 0, zoom: 1 };
function loadCamera(flowId: string): void {
  const c = fs.getCamera(wsId, flowId);
  cam.panX = c && Number.isFinite(c.panX) ? c.panX : 0;
  cam.panY = c && Number.isFinite(c.panY) ? c.panY : 0;
  cam.zoom = c && Number.isFinite(c.zoom) ? Math.min(BZ_ZOOM_MAX, Math.max(BZ_ZOOM_MIN, c.zoom)) : 1;
  zoomLabel();
}
function saveCamera(): void {
  if (props.flow) fs.putCamera(wsId, props.flow.id, cam);
}
/** bizApplyTransform. */
function applyTransform(): void {
  const w = worldEl.value;
  if (w) w.style.transform = `translate(${cam.panX}px, ${cam.panY}px) scale(${cam.zoom})`;
  drawMinimap();
}
/**
 * bizZoomLabel: the pill's percentage, written straight into it as the source writes it — a zoom is
 * not a render, and re-rendering the canvas for one would re-measure every noodle for nothing.
 */
function zoomLabel(): void { if (zoomEl.value) zoomEl.value.textContent = Math.round((cam.zoom || 1) * 100) + '%'; }
/** bizZoomTo: zoom holding (cx, cy) in canvas space fixed — the centre when omitted. */
function zoomTo(next: number, cx?: number, cy?: number): void {
  const old = cam.zoom || 1;
  next = Math.min(BZ_ZOOM_MAX, Math.max(BZ_ZOOM_MIN, next));
  if (Math.abs(next - old) < 1e-4) return;
  const cv = canvasEl.value;
  if (cx == null && cv) { const r = cv.getBoundingClientRect(); cx = r.width / 2; cy = r.height / 2; }
  cx = cx || 0; cy = cy || 0;
  cam.panX = cx - ((cx - cam.panX) * (next / old));
  cam.panY = cy - ((cy - cam.panY) * (next / old));
  cam.zoom = next;
  applyTransform(); zoomLabel(); saveCamera();
}
const zoomBy = (factor: number) => zoomTo((cam.zoom || 1) * factor);
/** bizFit: every card and frame in view, centred, with breathing room. */
function fit(): void {
  const cv = canvasEl.value, world = worldEl.value;
  const nodes = world ? [...world.querySelectorAll<HTMLElement>('.bz-node, .bz-group')] : [];
  if (!cv || !nodes.length) { cam.zoom = 1; cam.panX = 40; cam.panY = 40; applyTransform(); zoomLabel(); saveCamera(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.offsetLeft); minY = Math.min(minY, n.offsetTop);
    maxX = Math.max(maxX, n.offsetLeft + n.offsetWidth); maxY = Math.max(maxY, n.offsetTop + n.offsetHeight);
  }
  const pad = 56, r = cv.getBoundingClientRect();
  const bw = (maxX - minX) + pad * 2, bh = (maxY - minY) + pad * 2;
  const z = Math.min(BZ_ZOOM_MAX, Math.max(BZ_ZOOM_MIN, Math.min(r.width / bw, r.height / bh)));
  cam.zoom = z;
  cam.panX = r.width / 2 - ((minX + maxX) / 2) * z;
  cam.panY = r.height / 2 - ((minY + maxY) / 2) * z;
  applyTransform(); zoomLabel(); saveCamera();
}
/** bzScreenToWorld: a screen point, through #bz-world's translate(pan) scale(zoom). */
function screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const cv = canvasEl.value;
  const r = cv ? cv.getBoundingClientRect() : { left: 0, top: 0 };
  return { x: (clientX - r.left - cam.panX) / cam.zoom, y: (clientY - r.top - cam.panY) / cam.zoom };
}
/** bzSocketWorld: a socket's centre in world coordinates, measured as drawEdges measures it. */
function socketWorld(el: Element | null): { x: number; y: number } {
  const world = worldEl.value;
  if (!world || !el) return { x: 0, y: 0 };
  const z = cam.zoom || 1, wr = world.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - wr.left) / z, y: (r.top + r.height / 2 - wr.top) / z };
}
/** The centre of the view, in world coordinates — where bizAddTask and bizEmbedAtCentre drop. */
function viewCentre(): { x: number; y: number } | null {
  const cv = canvasEl.value;
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  return screenToWorld(r.left + cv.clientWidth / 2, r.top + cv.clientHeight / 2);
}

// ---- frames (bizLayoutGroups, bizGroupAt, bizDragHintSync) -------------------------------------------
type Rect = { x: number; y: number; w: number; h: number };
let groupRect: Record<string, Rect> = Object.create(null);
/**
 * Size every expanded frame to its members once they are laid out (card height is content). The
 * rects are cached for the collapse-in-place hand-off and bounds, never written to the document.
 * skipIds: boxes being dragged out of their frame, which the frame must not chase.
 */
function layoutGroups(skipIds?: Set<string>): void {
  const f = props.flow, world = worldEl.value;
  const prev = groupRect;
  groupRect = Object.create(null);
  if (!world || !f) return;
  for (const g of groupsOf(f)) {
    const frame = world.querySelector<HTMLElement>(`.bz-group[data-bz-group="${q(g.id)}"]`);
    if (!frame) continue;
    const hh = frame.querySelector<HTMLElement>('.bz-group-head')?.offsetHeight || 26;
    const gp = groupPos(g.id);
    if (g.collapsed) {
      groupRect[g.id] = { x: gp.x, y: gp.y, w: frame.offsetWidth, h: frame.offsetHeight };
      continue;
    }
    const els = groupMembers(f, g.id)
      .filter((t) => !(skipIds && skipIds.has(t.id)))
      .map((t) => nodeEl(t.id)).filter((x): x is HTMLElement => !!x);
    if (!els.length) {
      const r = prev[g.id] || { x: gp.x, y: gp.y, w: BZ_NODE_W, h: hh + 46 };
      frame.style.left = Math.round(r.x) + 'px'; frame.style.top = Math.round(r.y) + 'px';
      frame.style.width = Math.round(r.w) + 'px'; frame.style.height = Math.round(r.h) + 'px';
      groupRect[g.id] = r;
      continue;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      minX = Math.min(minX, el.offsetLeft); minY = Math.min(minY, el.offsetTop);
      maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth); maxY = Math.max(maxY, el.offsetTop + el.offsetHeight);
    }
    const r = { x: Math.round(minX - BZ_GROUP_PAD), y: Math.round(minY - BZ_GROUP_PAD - hh),
      w: Math.round(maxX - minX + BZ_GROUP_PAD * 2), h: Math.round(maxY - minY + BZ_GROUP_PAD * 2 + hh) };
    frame.style.left = r.x + 'px'; frame.style.top = r.y + 'px';
    frame.style.width = r.w + 'px'; frame.style.height = r.h + 'px';
    groupRect[g.id] = r;
  }
}
/** bizGroupAt: the expanded frame a world point falls inside — the last one drawn wins. */
function groupAt(wx: number, wy: number, exceptId?: string): { id: string } | null {
  const f = props.flow;
  if (!f) return null;
  let hit: { id: string } | null = null;
  for (const g of groupsOf(f)) {
    if (g.id === exceptId || g.collapsed) continue;
    const r = groupRect[g.id];
    if (!r) continue;
    if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) hit = g;
  }
  return hit;
}
/** bizDragHintSync: the dragged box's own frame, that frame while detaching, and the frame it would join. */
function dragHintSync(): void {
  const world = worldEl.value, f = props.flow;
  if (!world || !bizDrag || !f) return;
  const detach = !!bizDrag.detach;
  const srcIds = new Set<string>();
  for (const it of bizDrag.items) { const t = f.steps[it.id]; if (t && t.groupId) srcIds.add(t.groupId); }
  let targetId: string | null = null;
  if (detach || !srcIds.size) {
    const el = bizDrag.el;
    const g = el && groupAt(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + 20);
    if (g && !srcIds.has(g.id)) targetId = g.id;
  }
  for (const el of world.querySelectorAll<HTMLElement>('.bz-group')) {
    const isSrc = srcIds.has(el.dataset.bzGroup!);
    el.classList.toggle('is-drag-src', isSrc);
    el.classList.toggle('is-detaching', isSrc && detach);
    el.classList.toggle('is-drop-target', el.dataset.bzGroup === targetId);
  }
}
function dragHintClear(): void {
  document.querySelectorAll('.bz-group.is-drag-src, .bz-group.is-detaching, .bz-group.is-drop-target')
    .forEach((el) => el.classList.remove('is-drag-src', 'is-detaching', 'is-drop-target'));
}

// ---- the handoffs (drawBizEdges and its geometry, verbatim) ---------------------------------------
/** bizEdgePath: a cubic between two sockets with horizontal tangents — the noodle. */
function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}
/** bizEdgePathVia: the same noodle routed through its redirectors, one continuous cable. */
function edgePathVia(x1: number, y1: number, x2: number, y2: number, via: ReadonlyArray<{ x: number; y: number }>): string {
  if (!via || !via.length) return edgePath(x1, y1, x2, y2);
  const pts = [{ x: x1, y: y1 }, ...via, { x: x2, y: y2 }];
  const tan = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { x: 1, y: 0 };
    const a = pts[i - 1]!, c = pts[i + 1]!;
    const vx = c.x - a.x, vy = c.y - a.y, len = Math.hypot(vx, vy) || 1;
    return { x: vx / len, y: vy / len };
  });
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]!, qq = pts[i + 1]!;
    const seg = Math.hypot(qq.x - p.x, qq.y - p.y);
    const hl = Math.min(Math.max(12, Math.min(seg * 0.42, 120)), seg * 0.5);
    const c1 = { x: p.x + tan[i]!.x * hl, y: p.y + tan[i]!.y * hl };
    const c2 = { x: qq.x - tan[i + 1]!.x * hl, y: qq.y - tan[i + 1]!.y * hl };
    d += ` C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${qq.x} ${qq.y}`;
  }
  return d;
}
/** bizViaInsertIndex: the leg of a routed noodle a point is nearest — where a new redirector goes. */
function viaInsertIndex(p1: { x: number; y: number }, p2: { x: number; y: number }, via: ReadonlyArray<{ x: number; y: number }>, px: number, py: number): number {
  const pts = [p1, ...(via || []), p2];
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, c = pts[i + 1]!;
    const vx = c.x - a.x, vy = c.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / len2)) : 0;
    const d = Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
/** bizEndpointSel: which socket an edge end lands on — a collapsed frame's, a nested box's port, or the box's own. */
function endpointSel(f: Flow, taskId: string, port: string | null, side: 'in' | 'out'): string | null {
  const t = f.steps[taskId];
  if (!t) return null;
  const g = t.groupId ? f.groups[t.groupId] : null;
  if (g && g.collapsed) return `.bz-group[data-bz-group="${q(g.id)}"] .bz-socket.${side}[data-port="${q(taskId)}"]`;
  if (isSubflow(t)) {
    const open = subflowOpenPorts(ws.value, f, t, side);
    if (!open.length) return null;
    const p = (port && open.some((o) => o.id === port)) ? port : open[0]!.id;
    return `.bz-node[data-bz-node="${q(taskId)}"] .bz-socket.${side}[data-port="${q(p)}"]`;
  }
  return `.bz-node[data-bz-node="${q(taskId)}"] > .bz-socket.${side}:not([data-port])`;
}
/** Endpoint geometry from the last paint, keyed by edge id — where a new redirector belongs. */
let edgeEnds: Record<string, { p1: { x: number; y: number }; p2: { x: number; y: number } }> = Object.create(null);
/**
 * drawBizEdges: every handoff in world coordinates, measured from the live sockets, so a card mid-drag
 * keeps its noodles attached. `rubber` is the line being pulled out of a socket.
 */
function drawEdges(rubber?: { x1: number; y1: number; x2: number; y2: number }): void {
  const world = worldEl.value, svg = edgesEl.value, f = props.flow;
  if (!world || !svg) return;
  const rsvg = redirsEl.value;
  if (!f) { svg.innerHTML = ''; if (rsvg) rsvg.innerHTML = ''; drawMinimap(); return; }
  const z = cam.zoom || 1;
  const wr = world.getBoundingClientRect();
  const pointAt = (sel: string | null) => {
    if (!sel) return null;
    const el = world.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - wr.left) / z, y: (r.top + r.height / 2 - wr.top) / z };
  };
  let maxX = 800, maxY = 600;
  for (const el of world.querySelectorAll<HTMLElement>('.bz-node, .bz-group')) {
    maxX = Math.max(maxX, el.offsetLeft + el.offsetWidth + 120);
    maxY = Math.max(maxY, el.offsetTop + el.offsetHeight + 60);
  }
  svg.setAttribute('width', String(maxX)); svg.setAttribute('height', String(maxY));
  const css = getComputedStyle(document.body);
  const tok = (name: string, fallback: string) => (css.getPropertyValue(name) || '').trim() || fallback;
  const C_PLAIN = tok('--accent', ACCENT);
  const C_BRANCH = tok('--c', '#fcc419');
  const C_NEST = tok('--p', '#22b8cf');
  let inner = '<defs>'
    + `<marker id="bz-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="${C_PLAIN}"/></marker>`
    + `<marker id="bz-arrow-b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="${C_BRANCH}"/></marker>`
    + `<marker id="bz-arrow-n" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="${C_NEST}"/></marker>`
    + '</defs>';
  const edges = edgesOf(f);
  const fromCount: Record<string, number> = {};
  for (const e of edges) fromCount[e.from] = (fromCount[e.from] || 0) + 1;
  const branchSrc = new Set(Object.keys(fromCount).filter((k) => fromCount[k]! >= 2));
  let redirs = '';
  edgeEnds = Object.create(null);
  for (const e of edges) {
    const from = f.steps[e.from], to = f.steps[e.to];
    if (!from || !to) continue;
    if (from.groupId && from.groupId === to.groupId) {
      const g = f.groups[from.groupId];
      if (g && g.collapsed) continue;
    }
    const p1 = pointAt(endpointSel(f, e.from, e.fromPort, 'out'));
    const p2 = pointAt(endpointSel(f, e.to, e.toPort, 'in'));
    if (!p1 || !p2) continue;
    edgeEnds[e.id] = { p1, p2 };
    const nested = isSubflow(from) || isSubflow(to);
    const branch = branchSrc.has(e.from);
    const stroke = nested ? C_NEST : branch ? C_BRANCH : C_PLAIN;
    const marker = nested ? 'bz-arrow-n' : branch ? 'bz-arrow-b' : 'bz-arrow';
    const via = liveVia.get(e.id) ?? e.via;
    inner += `<path class="bz-edge${nested ? ' is-nested' : ''}" data-bz-edge="${escapeHtml(e.id)}" d="${edgePathVia(p1.x, p1.y, p2.x, p2.y, via)}" fill="none" stroke="${stroke}" stroke-width="2.5" marker-end="url(#${marker})"/>`;
    via.forEach((v, i) => {
      redirs += `<circle class="bz-via" data-bz-via="${escapeHtml(e.id)}" data-via-i="${i}" cx="${v.x}" cy="${v.y}" r="6" fill="${stroke}"><title>Redirector — drag to route this handoff. Double-click to remove it.</title></circle>`;
    });
    // The label rides the middle of the route, not the straight line between the ends.
    if (e.label) {
      const mid = via.length ? via[(via.length - 1) >> 1]! : { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const lx = via.length % 2 === 0 && via.length ? (via[via.length / 2 - 1]!.x + via[via.length / 2]!.x) / 2 : mid.x;
      const ly = via.length % 2 === 0 && via.length ? (via[via.length / 2 - 1]!.y + via[via.length / 2]!.y) / 2 : mid.y;
      inner += `<text class="bz-edge-label" x="${lx}" y="${ly - 10}" text-anchor="middle">${escapeHtml(e.label)}</text>`;
    }
  }
  inner += redirs;
  if (rubber) {
    inner += `<path class="bz-rubber" d="${edgePath(rubber.x1, rubber.y1, rubber.x2, rubber.y2)}" fill="none" stroke="${C_PLAIN}" stroke-width="2" stroke-dasharray="6 4" opacity="0.7"/>`;
  }
  svg.innerHTML = inner;
  if (rsvg) {
    rsvg.setAttribute('width', String(maxX)); rsvg.setAttribute('height', String(maxY));
    rsvg.innerHTML = redirs;
  }
  drawMinimap();
}

// ---- the minimap (drawBizMinimap / bizMiniNavigate) ------------------------------------------------
let miniMap: { s: number; ox: number; oy: number } | null = null;
/** The whole graph in 200×140: frames, hairline handoffs, steps coloured by status, the view. */
function drawMinimap(): void {
  const mm = miniEl.value, cv = canvasEl.value, world = worldEl.value, f = props.flow;
  if (!mm || !cv || !world) return;
  const z = cam.zoom || 1;
  const nodes = [...world.querySelectorAll<HTMLElement>('.bz-node')];
  const frameEls = [...world.querySelectorAll<HTMLElement>('.bz-group')];
  mm.style.display = (nodes.length || frameEls.length) ? '' : 'none';
  if ((!nodes.length && !frameEls.length) || !f) return;
  const MW = 200, MH = 140;
  const dpr = window.devicePixelRatio || 1;
  if (mm.width !== MW * dpr) { mm.width = MW * dpr; mm.height = MH * dpr; }
  const c2 = mm.getContext('2d');
  if (!c2) return;
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  c2.clearRect(0, 0, MW, MH);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  type Box = { id: string; x: number; y: number; w: number; h: number; collapsed?: boolean; color?: string };
  const boxes: Box[] = nodes.map((n) => {
    const r = { id: n.dataset.bzNode!, x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight };
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    return r;
  });
  const frameBoxes: Box[] = frameEls.map((n) => {
    const r = { id: n.dataset.bzGroup!, x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight,
      collapsed: n.classList.contains('collapsed'),
      color: (getComputedStyle(n).getPropertyValue('--bzg-color') || '').trim() };
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    return r;
  });
  const cr = cv.getBoundingClientRect();
  const vx = -cam.panX / z, vy = -cam.panY / z, vw = cr.width / z, vh = cr.height / z;
  minX = Math.min(minX, vx); minY = Math.min(minY, vy);
  maxX = Math.max(maxX, vx + vw); maxY = Math.max(maxY, vy + vh);
  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const s = Math.min((MW - 8) / (maxX - minX), (MH - 8) / (maxY - minY), 0.3);
  const ox = (MW - (maxX - minX) * s) / 2 - minX * s;
  const oy = (MH - (maxY - minY) * s) / 2 - minY * s;
  miniMap = { s, ox, oy };
  const css = getComputedStyle(document.body);
  const ACC = (css.getPropertyValue('--accent') || '#51cf66').trim();
  for (const r of frameBoxes) {
    c2.globalAlpha = 0.16; c2.fillStyle = r.color || ACC;
    c2.fillRect(r.x * s + ox, r.y * s + oy, Math.max(4, r.w * s), Math.max(3, r.h * s));
    c2.globalAlpha = 0.7; c2.lineWidth = 1; c2.strokeStyle = r.color || ACC;
    c2.strokeRect(r.x * s + ox, r.y * s + oy, Math.max(4, r.w * s), Math.max(3, r.h * s));
  }
  const byId: Record<string, Box> = {};
  for (const r of boxes) byId[r.id] = r;
  // A step folded into a collapsed frame has no box of its own, so its edges end on the frame.
  for (const g of groupsOf(f)) {
    if (!g.collapsed) continue;
    const fr = frameBoxes.find((x) => x.id === g.id);
    if (fr) for (const t of groupMembers(f, g.id)) byId[t.id] = fr;
  }
  c2.strokeStyle = (css.getPropertyValue('--text-dim') || '#888').trim();
  c2.globalAlpha = 0.5; c2.lineWidth = 1;
  for (const ed of edgesOf(f)) {
    const a = byId[ed.from], b = byId[ed.to];
    if (!a || !b) continue;
    c2.beginPath();
    c2.moveTo((a.x + a.w) * s + ox, (a.y + a.h / 2) * s + oy);
    c2.lineTo(b.x * s + ox, (b.y + b.h / 2) * s + oy);
    c2.stroke();
  }
  const ST_COLOR: Record<string, string> = {
    todo: (css.getPropertyValue('--text-dim') || '#888').trim(),
    doing: (css.getPropertyValue('--warn') || '#fcc419').trim(),
    done: ACC,
  };
  const NEST_COLOR = (css.getPropertyValue('--p') || '#22b8cf').trim();
  const sel = new Set(selection.value);
  for (const r of boxes) {
    const t = f.steps[r.id];
    const st = (t && t.taskStatus) || 'todo';
    c2.globalAlpha = st === 'todo' ? 0.55 : 0.9;
    c2.fillStyle = isSubflow(t) ? NEST_COLOR : (ST_COLOR[st] || ST_COLOR.todo!);
    c2.fillRect(r.x * s + ox, r.y * s + oy, Math.max(4, r.w * s), Math.max(3, r.h * s));
    if (sel.has(r.id)) {
      c2.globalAlpha = 1; c2.lineWidth = 1.5; c2.strokeStyle = ACC;
      c2.strokeRect(r.x * s + ox - 1.5, r.y * s + oy - 1.5, Math.max(4, r.w * s) + 3, Math.max(3, r.h * s) + 3);
    }
  }
  c2.globalAlpha = 1; c2.lineWidth = 1.5; c2.strokeStyle = ACC;
  c2.strokeRect(vx * s + ox, vy * s + oy, vw * s, vh * s);
}
/** bizMiniNavigate: centre the view on the minimap point under the cursor. */
function miniNavigate(clientX: number, clientY: number): void {
  const mm = miniEl.value, cv = canvasEl.value;
  if (!mm || !cv || !miniMap) return;
  const r = mm.getBoundingClientRect();
  const { s, ox, oy } = miniMap;
  const wx = (clientX - r.left - ox) / s, wy = (clientY - r.top - oy) / s;
  const z = cam.zoom || 1;
  const cr = cv.getBoundingClientRect();
  cam.panX = cr.width / 2 - wx * z;
  cam.panY = cr.height / 2 - wy * z;
  applyTransform();
}

/**
 * renderBizcase rebuilds #bz-world from scratch, so after every one of its renders the browser
 * rasterizes the world afresh at the current zoom and pan — and a world only panned or zoomed since
 * (bizApplyTransform) keeps its old raster, composited at a fractional offset or a stale scale. Here
 * the element persists, so the same fresh raster is asked for where index.html would have rendered:
 * lifting will-change for two frames makes Chrome drop the layer and paint a new one.
 */
let rasterFrame = 0;
/** Set just before a write index.html makes without re-rendering (a drop, a bend, a blur commit). */
let quietWrite = false;
function freshRaster(): void {
  const w = worldEl.value;
  if (!w) return;
  // The same rebuild throws away any text a shift-click or a drag had selected on the cards —
  // except under someone's caret: a colleague's edit must never cost this person their typing.
  const sl = document.getSelection();
  const typing = document.activeElement as HTMLElement | null;
  if (sl && sl.rangeCount && !(typing?.isContentEditable && w.contains(typing))
    && ((sl.anchorNode && w.contains(sl.anchorNode)) || (sl.focusNode && w.contains(sl.focusNode)))) sl.removeAllRanges();
  w.style.willChange = 'auto';
  cancelAnimationFrame(rasterFrame);
  rasterFrame = requestAnimationFrame(() => {
    rasterFrame = requestAnimationFrame(() => { rasterFrame = 0; w.style.willChange = ''; });
  });
}

/** After every render: frames sized from their members, the view, the noodles, the minimap. */
function layoutAll(): void {
  layoutGroups(bizDrag?.moved && bizDrag.detach ? new Set(bizDrag.items.map((i) => i.id)) : undefined);
  applyTransform();
  drawEdges(bizConnect && lastRubber ? lastRubber : undefined);
}

// ---- the clipboard and the step mutations -----------------------------------------------------------
const noRaci = () => Object.fromEntries(COLS.map((k) => [k, ''])) as Record<string, string>;
/** bizCopyTask. */
function copyTask(id: string): boolean {
  const t = props.flow?.steps[id];
  if (!t) return false;
  const { id: _id, flowId: _flowId, ...rest } = JSON.parse(JSON.stringify(t)) as FlowStep;
  clip = rest;
  pasteN = 0;
  return true;
}
/** bizCutTask. */
function cutTask(id: string): void {
  if (!editable() || !copyTask(id)) return;
  commit(() => deleteStep(doc, id));
  selection.value = selection.value.filter((x) => x !== id);
  toast('Step cut — Ctrl+V to paste', 'suggest');
}
/** bizPasteTask: the clip again, 28px further on each time. */
function pasteTask(): void {
  if (!editable()) return;
  if (!clip) { toast('Nothing to paste — copy a step first (Ctrl+C or ⧉)', 'suggest'); return; }
  pasteN++;
  const src = clip;
  const t = JSON.parse(JSON.stringify(src)) as typeof src;
  commit(() => {
    const id = addStep(doc, props.flow!.id, { ...t, x: Math.round((src.x || 0) + 28 * pasteN), y: Math.round((src.y || 0) + 28 * pasteN) });
    selection.value = [id];
  });
}
/** bizPasteTaskAt: the context menu's paste, where the menu was opened. */
function pasteTaskAt(wx: number, wy: number): void {
  if (!guarded()) return;
  if (!clip) { toast('Nothing to paste — copy a step first (Ctrl+C or ⧉)', 'suggest'); return; }
  const t = JSON.parse(JSON.stringify(clip)) as NonNullable<typeof clip>;
  const x = Math.round(wx), y = Math.round(wy);
  const g = groupAt(x + BZ_NODE_W / 2, y + 24);
  const id = addStep(doc, props.flow!.id, { ...t, x, y, groupId: g ? g.id : null });
  selection.value = [id];
  pasteN = 0; // this paste set the position, so the cascade restarts from here
}
/** bizAddTask: a new step in the middle of the view, its name ready to type over. */
function addTaskAtCentre(): void {
  if (!editable()) return;
  let wx = 80, wy = 80;
  const c = viewCentre();
  if (c) { wx = Math.round(c.x - BZ_NODE_W / 2); wy = Math.round(c.y - 40); }
  const g = groupAt(wx + BZ_NODE_W / 2, wy + 24);
  let id = '';
  commit(() => { id = addStep(doc, props.flow!.id, { name: 'New task', raci: noRaci(), x: wx, y: wy, groupId: g ? g.id : null }); });
  if (id) void nextTick(() => focusName(id, false));
}
/** bizAddTaskAt: the same, where the context menu was opened, and selected. */
function addTaskAt(wx: number, wy: number): void {
  if (!guarded()) return;
  const x = Math.round(wx), y = Math.round(wy);
  const g = groupAt(x + BZ_NODE_W / 2, y + 24);
  const id = addStep(doc, props.flow!.id, { name: 'New task', raci: noRaci(), x, y, groupId: g ? g.id : null });
  selection.value = [id];
  focusName(id, true);
}
/** bizDuplicateTask: one step copied in place, leaving the clipboard alone. */
function duplicateTask(id: string): void {
  if (!guarded()) return;
  const f = props.flow!, t = f.steps[id];
  if (!t) return;
  const { id: _id, flowId: _flowId, ...copy } = JSON.parse(JSON.stringify(t)) as FlowStep;
  copy.x = Math.round((t.x || 0) + 28);
  copy.y = Math.round((t.y || 0) + 28);
  if (!isSubflow(t)) copy.name = copyName(t.name, stepsOf(f).map((x) => x.name));
  selection.value = [addStep(doc, f.id, copy)];
}
/** bizDeleteTask. */
function deleteTask(id: string): void {
  if (!editable()) return;
  const f = props.flow!, t = f.steps[id];
  const msg = isSubflow(t)
    ? `Remove the nested "${taskLabel(ws.value, f, t)}" box? Its handoffs go with it; the flow itself stays in the gallery.`
    : `Delete task "${(t && t.name) || 'Untitled'}"? This also removes its handoffs.`;
  if (!confirm(msg)) return;
  if (partyTarget.value && partyTarget.value.taskId === id) { partyTarget.value = null; partyDraft.value = null; }
  commit(() => deleteStep(doc, id));
}
/** bizUnbindStep: drop the chart row, keeping what it supplied as the step's own letters. */
function unbindStep(taskId: string): void {
  const f = props.flow, t = f?.steps[taskId];
  if (!editable() || !f || !t || !t.bind) return;
  const eff = createLintContext(ws.value, activeChartId.value).stepRaci(f, t);
  commit(() => doc.transact(() => {
    for (const k of COLS) if (eff[k].from === 'chart') setStepRaci(doc, taskId, k, eff[k].letters);
    setStepField(doc, taskId, 'bind', null);
    setField(maps(doc).steps, taskId, 'bindOverrides', []);
  }, LOCAL_ORIGIN));
  toast('Unlinked — the row\'s RACI was copied onto the step, so nothing was lost. It is the step\'s own now.', 'suggest');
}
/** The inline edits' blur commits (index.html's blur listener): only when the text changed. */
function commitStepText(id: string, field: 'name' | 'description' | 'entry' | 'exit', value: string): void {
  const t = props.flow?.steps[id];
  if (!t || !editable() || (t[field] || '') === value) return;
  commit(() => { quietWrite = field !== 'name'; setStepField(doc, id, field, value); });
}
function commitGroupName(gid: string, value: string): void {
  const g = props.flow?.groups[gid];
  if (!g || !editable() || g.name === value) return;
  commit(() => setGroupField(doc, gid, 'name', value));
}
/** focusFlowStepName / bizAddTask's focus: the caret in the name, its text selected. */
function focusName(id: string, nextFrame: boolean): void {
  const go = () => {
    const el = worldEl.value?.querySelector<HTMLElement>(`.bz-node[data-bz-node="${q(id)}"] .bz-node-name`);
    if (!el) return;
    if (el.getAttribute('contenteditable') === null) el.setAttribute('contenteditable', 'true');
    el.focus();
    const sl = document.getSelection();
    if (sl && sl.selectAllChildren) sl.selectAllChildren(el);
  };
  if (nextFrame) void nextTick(() => requestAnimationFrame(go)); else go();
}
function focusGroupName(gid: string): void {
  void nextTick(() => requestAnimationFrame(() => {
    const el = worldEl.value?.querySelector<HTMLElement>(`[data-bz-group-name="${q(gid)}"]`);
    if (!el) return;
    el.focus();
    const sl = document.getSelection();
    if (sl && sl.selectAllChildren) sl.selectAllChildren(el);
  }));
}

// ---- nested flows (bizEmbedFlow, bizOpenSubflow, bizTogglePort) ---------------------------------------
/** bizEmbedFlow: a box referencing another flow — never a copy of it — where it was dropped. */
function embedFlow(refId: string, wx: number, wy: number): void {
  if (!editable()) return;
  const host = props.flow!, ref = ws.value.flows[refId];
  if (!ref) { toast('That flow no longer exists.', 'error'); return; }
  if (refId === host.id) { toast('A flow cannot contain itself.', 'error'); return; }
  if (embedWouldCycle(ws.value, host.id, refId)) {
    toast(`"${ref.name || 'Untitled'}" already contains this flow somewhere inside it — nesting it here would close a loop.`, 'error');
    return;
  }
  const x = Math.round(wx), y = Math.round(wy);
  const g = groupAt(x + BZ_NODE_W / 2, y + 24);
  commit(() => {
    const id = addStep(doc, host.id, { kind: 'subflow', refId, name: '', x, y, groupId: g ? g.id : null, ports: { in: [], out: [] } });
    selection.value = [id];
  });
  toast(`"${ref.name || 'Untitled'}" nested — every entry and exit point is exposed as its own mating point. Untick the ones this host doesn't use.`);
}
function embedAtCentre(id: string): void {
  const c = viewCentre() ?? { x: 80, y: 80 };
  embedFlow(id, c.x - BZ_NODE_W / 2, c.y - 28);
}
/** bizOpenSubflow: descend into the nested flow, remembering the way back. */
function openSubflow(taskId: string): void {
  const f = props.flow, t = f?.steps[taskId];
  if (!f || !isSubflow(t)) return;
  const ref = refFlow(ws.value, f, t);
  if (!ref) return;
  fs.navStack.value = [...fs.navStack.value, f.id];
  fs.switchFlow(ref.id, true);
}
/** bizTogglePort: expose or hide one mating point; a handoff wired to a hidden one goes with it. */
function togglePort(taskId: string, side: 'in' | 'out', portId: string): void {
  if (!editable()) return;
  const f = props.flow!, t = f.steps[taskId];
  if (!isSubflow(t)) return;
  const P = subflowPorts(ws.value, f, t);
  if (!P.ref) return;
  const all = P[side].map((p) => p.id);
  const on = new Set(P[side].filter((p) => p.on).map((p) => p.id));
  if (on.has(portId)) on.delete(portId); else on.add(portId);
  const next = all.filter((x) => on.has(x));
  if (!next.length) { toast('A nested flow needs at least one mating point on each side.', 'error'); return; }
  const open = new Set(next);
  const doomed = edgesOf(f).filter((e) => {
    const port = side === 'in' ? e.toPort : e.fromPort;
    return (side === 'in' ? e.to : e.from) === taskId && port && !open.has(port);
  });
  commit(() => doc.transact(() => {
    setStepField(doc, taskId, 'ports', { ...t.ports, [side]: next.length === all.length ? [] : next });
    for (const e of doomed) deleteEdge(doc, e.id);
  }, LOCAL_ORIGIN));
  if (doomed.length) toast(`${doomed.length} handoff${doomed.length === 1 ? '' : 's'} removed — that mating point is no longer exposed.`, 'suggest');
}

// ---- frames (bizGroupSelection, bizUngroup, bizDeleteGroup, bizToggleGroupCollapse, colour) --------
function groupSelection(): void {
  if (!editable()) return;
  const f = props.flow!;
  const sel = selection.value.map((id) => f.steps[id]).filter((t): t is FlowStep => !!t);
  if (!sel.length) { toast('Select steps first — click one, then shift-click others, or shift-drag a box around them.', 'suggest'); return; }
  const n = Object.keys(f.groups).length;
  commit(() => {
    selectedGroup.value = addGroupFrame(doc, f.id, {
      name: 'Group ' + (n + 1),
      color: BZ_GROUP_COLORS[n % BZ_GROUP_COLORS.length]!,
      x: Math.round(Math.min(...sel.map((x) => x.x)) - BZ_GROUP_PAD),
      y: Math.round(Math.min(...sel.map((x) => x.y)) - BZ_GROUP_PAD - 26),
    }, sel.map((x) => x.id));
  });
  toast(`Grouped ${sel.length} step${sel.length === 1 ? '' : 's'} — drag them freely, the frame follows. Hold ${BZ_DETACH_KEY_LONG} while dragging one to pull it back out.`);
}
function ungroup(gid: string): void {
  if (!editable()) return;
  commit(() => deleteGroup(doc, gid));
  if (selectedGroup.value === gid) selectedGroup.value = null;
  toast('Ungrouped — the steps stay exactly where they are.', 'suggest');
}
function deleteFrame(gid: string): void {
  if (!editable()) return;
  const f = props.flow!, g = f.groups[gid];
  if (!g) return;
  const n = groupMembers(f, gid).length;
  if (n && !confirm(`Delete the frame "${g.name || 'Group'}"? Its ${n} step${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} on the canvas.`)) return;
  ungroup(gid);
}
function toggleCollapse(gid: string): void {
  if (!editable()) return;
  const g = props.flow!.groups[gid];
  if (!g) return;
  commit(() => doc.transact(() => {
    // Fold up exactly where the frame sits now, so the collapsed box replaces it in place.
    if (!g.collapsed) {
      const r = groupRect[gid];
      if (r) { setGroupField(doc, gid, 'x', r.x); setGroupField(doc, gid, 'y', r.y); }
    }
    setGroupField(doc, gid, 'collapsed', !g.collapsed);
  }, LOCAL_ORIGIN));
}
function cycleColor(gid: string): void {
  if (!editable()) return;
  const g = props.flow!.groups[gid];
  if (!g) return;
  const at = (BZ_GROUP_COLORS as readonly string[]).indexOf(g.color);
  commit(() => setGroupField(doc, gid, 'color', BZ_GROUP_COLORS[(at + 1) % BZ_GROUP_COLORS.length]));
}

// ---- the popovers and the party panel the canvas opens (drawn by components/flow/*) -------------------
function anchorOf(el: Element): FlowAnchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}
/** openBizPartyPanel: target the (step, column) and seed the draft as the source does. */
function openParty(taskId: string, col: string): void {
  const f = props.flow, t = f?.steps[taskId], c = ctx.value;
  if (!f || !t || !c) return;
  partyTarget.value = { taskId, col };
  const own = Object.hasOwn(t.parties, col) ? t.parties[col] : undefined;
  partyDraft.value = own ? { ...own } : (defaultPartyForTask(c, t, col) || null);
}
/** jumpToChartNode: the org chart, drilled to the row. */
function jumpToChartNode(chartId: string, nodeId: string): void {
  const chart = ws.value.charts[chartId];
  if (!chart || !chart.nodes[nodeId]) { toast('The linked chart task no longer exists.', 'error'); return; }
  activeChartId.value = chartId;
  void navigateTo({ path: `/w/${wsId}`, query: { node: nodeId } });
}

// ---- the table and the gallery toggles the canvas menu offers ---------------------------------------
function toggleGallery(): void {
  const on = !fs.galleryOpen.value;
  fs.setGallery(on);
  if (!on) toast('Gallery hidden — ⊞ Gallery in the toolbar brings it back.', 'suggest');
}
function toggleTable(): void {
  const f = props.flow;
  if (f) fs.setTable(f.id, !fs.isTableOpen(f.id));
}

// ---- the jumps into the canvas (bizJumpToTask's second half) ----------------------------------------
function flash(taskId: string): void {
  flashId.value = null;
  void nextTick(() => {
    flashId.value = taskId;
    setTimeout(() => { if (flashId.value === taskId) flashId.value = null; }, 3500);
  });
}
/** Centre a step (bizJumpToTask / bizBindNextUnbound's arithmetic). */
function centreOn(taskId: string): boolean {
  const t = props.flow?.steps[taskId], cv = canvasEl.value;
  if (!t || !cv) return false;
  cam.panX = cv.clientWidth / 2 - (t.x + BZ_NODE_W / 2) * cam.zoom;
  cam.panY = cv.clientHeight / 2 - (t.y + 70) * cam.zoom;
  applyTransform(); saveCamera();
  return true;
}
function focusTask(taskId: string): void {
  if (!props.flow?.steps[taskId]) return;
  requestAnimationFrame(() => { centreOn(taskId); flash(taskId); });
}
function centreTask(taskId: string): void {
  requestAnimationFrame(() => { centreOn(taskId); });
}
/** A jump waiting for its flow to be on screen. */
let pendingJump: string | null = null;
function tryJump(): void {
  const id = pendingJump, f = props.flow;
  if (!id || !f) return;
  pendingJump = null;
  if (f.steps[id]) void nextTick(() => focusTask(id));
}
/** The warnings pill (the shell's `raci:jump`), and Tasks / Object Gallery links (`?step=`). */
const jumpRequest = useState<{ kind: 'chart' | 'flow'; id: string; flowId: string | null; at: number } | null>('raci:jump', () => null);
watch(jumpRequest, (j) => {
  if (j?.kind !== 'flow') return;
  jumpRequest.value = null;
  if (j.flowId && j.flowId !== activeFlowId.value) activeFlowId.value = j.flowId;
  pendingJump = j.id;
  tryJump();
}, { immediate: true });
watch(() => [route.query.flow, route.query.step, session.ready.value] as const, ([flowQ, stepQ, ready]) => {
  if (!ready || (typeof flowQ !== 'string' && typeof stepQ !== 'string')) return;
  if (typeof flowQ === 'string' && ws.value.flows[flowQ]) activeFlowId.value = flowQ;
  if (typeof stepQ === 'string' && stepQ) pendingJump = stepQ;
  // Honoured once: the query goes, so a reload does not jump again.
  const { flow: _f, step: _s, ...rest } = route.query;
  void router.replace({ query: rest });
  void nextTick(tryJump);
}, { immediate: true });

// ---- the right-click menus (ctxFlowStepItems, ctxFlowGroupItems, ctxFlowCanvasItems) ----------------
const LOCK_NOTE = { note: 'This flow is Final. Reopen it as a draft — the button is in the strip above — to edit it.' };
function stepItems(id: string): CtxEntry[] | null {
  const f = props.flow!, t = f.steps[id];
  if (!t) return null;
  const sub = isSubflow(t);
  const head: CtxEntry[] = [{ title: taskLabel(ws.value, f, t) }];
  if (sub) head.push({ label: 'Open the nested flow', ico: '⤢', run: () => openSubflow(id) });
  if (f.status === 'final') return [...head, { sep: true }, LOCK_NOTE];
  if (!props.canEdit) return head;
  const selN = selection.value.length;
  const linked = f.mode === 'linked';
  const bound = !sub && linked && !!t.bind;
  return [
    ...head,
    !sub && { label: 'Rename', ico: '✎', run: () => focusName(id, true) },
    { sep: true },
    { label: 'Duplicate', ico: '⧉', run: () => duplicateTask(id) },
    { label: 'Copy', ico: '⎘', kbd: 'Ctrl+C', run: () => { if (copyTask(id)) toast('Step copied — Ctrl+V to paste.', 'suggest'); } },
    { label: 'Cut', ico: '✂', kbd: 'Ctrl+X', run: () => cutTask(id) },
    { label: clip ? 'Paste step' : 'Paste', ico: '⎙', kbd: 'Ctrl+V', disabled: !clip, run: () => pasteTask() },
    { sep: true },
    !sub && linked && { label: bound ? 'Re-point at another chart row…' : 'Link to a chart row…', ico: '⛓', run: () => openBindPicker(id) },
    !sub && bound && { label: 'Unlink from the chart row', ico: '⛓', run: () => unbindStep(id) },
    { label: selN > 1 ? `Group the ${selN} selected steps` : 'Group with…', ico: '▭', disabled: selN < 2,
      hint: selN < 2 ? 'Select two or more steps first (shift-click, or shift-drag a marquee)' : '', run: () => groupSelection() },
    !!t.groupId && { label: 'Take out of its frame', ico: '⤨', hint: `Same as holding ${BZ_DETACH_KEY_LONG} while dragging it out`,
      run: () => { if (editable()) commit(() => setStepField(doc, id, 'groupId', null)); } },
    { sep: true },
    { label: sub ? 'Remove this nested box' : 'Delete step', ico: '✕', danger: true,
      hint: sub ? 'Removes the reference only — the flow itself stays in the gallery' : 'Also removes its handoffs', run: () => deleteTask(id) },
  ];
}
function groupItems(gid: string): CtxEntry[] | null {
  const f = props.flow!, g = f.groups[gid];
  if (!g) return null;
  const head: CtxEntry[] = [{ title: g.name || 'Unnamed frame' }];
  if (f.status === 'final') return [...head, LOCK_NOTE];
  if (!props.canEdit) return head;
  return [
    ...head,
    { label: g.collapsed ? 'Expand — show the steps' : 'Collapse into one box', ico: g.collapsed ? '▾' : '▸', run: () => toggleCollapse(gid) },
    { label: 'Rename', ico: '✎', run: () => focusGroupName(gid) },
    { label: 'Cycle the frame colour', ico: '◧', run: () => cycleColor(gid) },
    { sep: true },
    { label: 'Ungroup', ico: '⤨', hint: 'Release the steps and keep them where they are', run: () => ungroup(gid) },
    { label: 'Delete the frame', ico: '✕', danger: true, hint: 'The steps stay on the canvas', run: () => deleteFrame(gid) },
  ];
}
function canvasItems(e: MouseEvent): CtxEntry[] | null {
  const f = props.flow;
  if (!f) return null;
  const head: CtxEntry[] = [{ title: f.name || 'Untitled flow' }];
  const fitItem = { label: 'Fit to the canvas', ico: '⤢', run: () => fit() };
  if (f.status === 'final') return [...head, fitItem, { sep: true }, LOCK_NOTE];
  // A step added from the menu belongs where the menu was opened — the click IS the placement.
  const at = screenToWorld(e.clientX, e.clientY);
  const view: CtxEntry[] = [
    fitItem,
    { label: fs.isTableOpen(f.id) ? 'Hide the step table' : 'Show the step table', ico: '▤', run: () => toggleTable() },
    { label: fs.galleryOpen.value ? 'Hide the flow gallery' : 'Show the flow gallery', ico: '▦', run: () => toggleGallery() },
    { label: 'Flow details…', ico: '✎', run: () => shell.openMeta('flow', f.id) },
  ];
  if (!props.canEdit) return [...head, ...view];
  const n = selection.value.length;
  return [
    ...head,
    { label: 'Add a step here', ico: '＋', run: () => addTaskAt(at.x - BZ_NODE_W / 2, at.y - 24) },
    { label: clip ? 'Paste step here' : 'Paste', ico: '⎙', kbd: 'Ctrl+V', disabled: !clip, run: () => pasteTaskAt(at.x - BZ_NODE_W / 2, at.y - 24) },
    n > 1 && { label: `Group the ${n} selected steps`, ico: '▭', run: () => groupSelection() },
    { sep: true },
    ...view,
  ];
}
/** openBindPicker: drive the bind bar the card already has, so the popover is the same popover. */
function openBindPicker(id: string): void {
  const el = worldEl.value?.querySelector(`[data-bz-bind="${q(id)}"]`);
  if (el) popover.value = { kind: 'bind', taskId: id, anchor: anchorOf(el) };
}
function onContextMenu(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('input, textarea')) return;
  // A live text selection inside a name means someone is lining up a copy: the browser's menu.
  const edit = t.closest('[contenteditable="true"]');
  if (edit) {
    const sl = document.getSelection();
    if (sl && !sl.isCollapsed && sl.anchorNode && edit.contains(sl.anchorNode)) return;
  }
  if (!props.flow) return;
  const node = t.closest<HTMLElement>('[data-bz-node]');
  const grp = node ? null : t.closest<HTMLElement>('[data-bz-group]');
  const items = node ? stepItems(node.dataset.bzNode!) : grp ? groupItems(grp.dataset.bzGroup!) : canvasItems(e);
  if (items && menu.open(e.clientX, e.clientY, items)) e.preventDefault();
}

// ---- pointer gestures (index.html's document-level mousedown / mousemove / mouseup) ------------------
interface DragItem { id: string; ox: number; oy: number; el: HTMLElement | null }
let bizDrag: { id: string; el: HTMLElement; sx: number; sy: number; moved: boolean; items: DragItem[]; detach: boolean } | null = null;
let bizConnect: { fromId: string; fromPort: string | null; x1: number; y1: number } | null = null;
let lastRubber: { x1: number; y1: number; x2: number; y2: number } | null = null;
let bizPan: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
let suppressClick = false;
let viaDrag: { edgeId: string; index: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; pending: boolean;
  created?: boolean; via: Array<{ x: number; y: number }> } | null = null;
let groupDrag: { id: string; el: HTMLElement; sx: number; sy: number; gx: number; gy: number; moved: boolean; items: DragItem[] } | null = null;
let marquee: { sx: number; sy: number; el: HTMLElement; cx?: number; cy?: number } | null = null;
let miniDrag = false;

/** bizDragItems: the boxes a drag will move, each remembering where it started. */
function dragItems(ids: string[]): DragItem[] {
  const f = props.flow;
  if (!f) return [];
  return ids.map((id) => {
    const t = f.steps[id];
    return t ? { id, ox: t.x, oy: t.y, el: nodeEl(id) } : null;
  }).filter((x): x is DragItem => !!x);
}

function onMouseDown(e: MouseEvent): void {
  const t = e.target as Element;
  // A drag that ends over another element produces no click, so a stale suppression flag would eat
  // the next real one. A click always lands before the next mousedown.
  suppressClick = false;
  const f = props.flow;
  if (!f) return;
  const outSock = t.closest<HTMLElement>('.bz-socket.out');
  if (outSock) { // begin a connection from an output socket
    if (!props.canEdit) return;
    e.preventDefault(); e.stopPropagation();
    const id = outSock.dataset.bzNodeId!;
    // On a nested box the socket names its exit; on a collapsed frame data-port names the member.
    const owner = f.steps[id];
    const fromPort = (isSubflow(owner) && outSock.dataset.port) ? outSock.dataset.port : null;
    const p = socketWorld(outSock);
    bizConnect = { fromId: id, fromPort, x1: p.x, y1: p.y };
    document.body.classList.add('bz-connecting');
    return;
  }
  if (t.closest('.bz-socket')) return; // an input socket is not a drag origin
  if (t.closest('.bz-node-del') || t.closest('.bz-node-copy') || t.closest('.bz-sub-open') || t.closest('.bz-port-tgl')) return;
  if (t.closest('.bz-sub-repoint') || t.closest('.bz-sub-ref-name')) return;
  if (t.closest('.bz-grp-btn')) return;
  if (t.closest('.bz-group-name')) return; // the frame's title keeps its caret
  const gHead = t.closest('.bz-group-head');
  if (gHead) { // drag the frame, and every step inside it
    const gEl = gHead.closest<HTMLElement>('.bz-group')!;
    const g = f.groups[gEl.dataset.bzGroup!];
    if (g) {
      selectedGroup.value = g.id; selection.value = [];
      if (props.canEdit) {
        groupDrag = { id: g.id, el: gEl, sx: e.clientX, sy: e.clientY, gx: g.x, gy: g.y, moved: false,
          items: dragItems(groupMembers(f, g.id).map((x) => x.id)) };
      }
    }
    return;
  }
  const selNode = t.closest<HTMLElement>('.bz-node');
  if (selNode) bizSelect(selNode.dataset.bzNode!, e.shiftKey); // shift-click extends the selection
  const head = t.closest('.bz-node-head');
  if (head) { // drag the box (and the rest of the selection); no preventDefault, so the caret works
    const el = head.closest<HTMLElement>('.bz-node')!;
    const step = f.steps[el.dataset.bzNode!];
    if (step && props.canEdit) {
      const ids = (selection.value.includes(step.id) && selection.value.length > 1) ? [...selection.value] : [step.id];
      // detach is re-read on every move, so the key can be pressed or let go mid-drag.
      bizDrag = { id: step.id, el, sx: e.clientX, sy: e.clientY, moved: false, items: dragItems(ids), detach: e.altKey };
    }
    return;
  }
  // Redirectors (v0.35): grab a handle to move it, or the noodle itself to bend it.
  const viaEl = t.closest<SVGElement>('[data-bz-via]');
  if (viaEl) {
    const ed = f.edges[viaEl.dataset.bzVia!];
    const i = +(viaEl.dataset.viaI ?? -1);
    if (ed && ed.via[i] && props.canEdit) {
      e.preventDefault();
      viaDrag = { edgeId: ed.id, index: i, sx: e.clientX, sy: e.clientY, ox: ed.via[i]!.x, oy: ed.via[i]!.y, moved: false, pending: false,
        via: ed.via.map((v) => ({ x: v.x, y: v.y })) };
      document.body.classList.add('bz-routing');
    }
    return;
  }
  const edgeEl = t.closest<SVGElement>('[data-bz-edge]');
  if (edgeEl) {
    // Where on the route the grab landed decides which leg the new redirector splits.
    const ed = f.edges[edgeEl.dataset.bzEdge!];
    if (ed && props.canEdit) {
      const w = screenToWorld(e.clientX, e.clientY);
      viaDrag = { edgeId: ed.id, index: -1, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y, moved: false, pending: true,
        via: ed.via.map((v) => ({ x: v.x, y: v.y })) };
    }
    return; // a click without travel still opens the popover
  }
  if (t.closest('.bz-node')) return; // a cell is handled on click
  if (t.closest('#bz-minimap')) { // jump the view there, then drag to steer
    e.preventDefault();
    miniDrag = true;
    miniNavigate(e.clientX, e.clientY);
    return;
  }
  if (t.closest('#bz-zoom-ctl')) return;
  const cv = canvasEl.value;
  if (cv) {
    if (e.shiftKey) { // shift-drag on empty canvas: marquee select
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'bz-marquee';
      cv.appendChild(box);
      marquee = { sx: e.clientX - r.left, sy: e.clientY - r.top, el: box };
      return;
    }
    bizSelect(null); // empty canvas: pan, and drop the selection
    bizPan = { sx: e.clientX, sy: e.clientY, ox: cam.panX, oy: cam.panY, moved: false };
    cv.classList.add('panning');
  }
}

function onMouseMove(e: MouseEvent): void {
  const f = props.flow;
  if (viaDrag) {
    const z = cam.zoom || 1;
    const dx = (e.clientX - viaDrag.sx) / z, dy = (e.clientY - viaDrag.sy) / z;
    if (!viaDrag.moved && Math.hypot(dx, dy) < 4) return; // below the threshold it is a click
    const ed = f?.edges[viaDrag.edgeId];
    if (!ed) { viaDrag = null; return; }
    // The first real travel on a noodle creates the redirector, at the point that was grabbed.
    if (viaDrag.pending) {
      const ends = edgeEnds[ed.id];
      const at = ends ? viaInsertIndex(ends.p1, ends.p2, viaDrag.via, viaDrag.ox, viaDrag.oy) : viaDrag.via.length;
      viaDrag.via.splice(at, 0, { x: Math.round(viaDrag.ox), y: Math.round(viaDrag.oy) });
      viaDrag.index = at; viaDrag.pending = false; viaDrag.created = true;
      document.body.classList.add('bz-routing');
    }
    viaDrag.moved = true;
    const v = viaDrag.via[viaDrag.index];
    if (v) { v.x = Math.round(viaDrag.ox + dx); v.y = Math.round(viaDrag.oy + dy); }
    liveVia.set(ed.id, viaDrag.via);
    drawEdges();
    return;
  }
  if (miniDrag) { miniNavigate(e.clientX, e.clientY); return; }
  if (marquee) {
    const cv = canvasEl.value!;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const s = marquee.el.style;
    s.left = Math.min(x, marquee.sx) + 'px'; s.top = Math.min(y, marquee.sy) + 'px';
    s.width = Math.abs(x - marquee.sx) + 'px'; s.height = Math.abs(y - marquee.sy) + 'px';
    marquee.cx = x; marquee.cy = y;
    return;
  }
  if (groupDrag) {
    const z = cam.zoom || 1;
    const dx = (e.clientX - groupDrag.sx) / z, dy = (e.clientY - groupDrag.sy) / z;
    if (!groupDrag.moved && Math.hypot(dx, dy) < 4) return;
    groupDrag.moved = true;
    // Members move with the frame whether or not they are drawn, so expanding it later puts them back.
    for (const it of groupDrag.items) {
      const x = Math.round(it.ox + dx), y = Math.round(it.oy + dy);
      live.set(it.id, { x, y });
      if (it.el) { it.el.style.left = x + 'px'; it.el.style.top = y + 'px'; }
    }
    const g = f?.groups[groupDrag.id];
    if (g) {
      const gp = { x: Math.round(groupDrag.gx + dx), y: Math.round(groupDrag.gy + dy) };
      liveGroup.set(g.id, gp);
      if (g.collapsed) { groupDrag.el.style.left = gp.x + 'px'; groupDrag.el.style.top = gp.y + 'px'; }
    }
    layoutGroups();
    drawEdges();
    return;
  }
  if (bizDrag) {
    const z = cam.zoom || 1;
    const dx = (e.clientX - bizDrag.sx) / z, dy = (e.clientY - bizDrag.sy) / z;
    if (!bizDrag.moved && Math.hypot(dx, dy) < 4) return; // a small move is a click (places the caret)
    bizDrag.moved = true;
    bizDrag.detach = e.altKey;
    for (const it of bizDrag.items) {
      if (!f?.steps[it.id] || !it.el) continue;
      const x = Math.round(it.ox + dx), y = Math.round(it.oy + dy);
      live.set(it.id, { x, y });
      it.el.style.left = x + 'px'; it.el.style.top = y + 'px';
      it.el.classList.add('dragging');
    }
    // The frame follows its members live, and freezes only while the detach key is held.
    layoutGroups(bizDrag.detach ? new Set(bizDrag.items.map((i) => i.id)) : undefined);
    dragHintSync();
    drawEdges();
    return;
  }
  if (bizConnect) {
    const wp = screenToWorld(e.clientX, e.clientY);
    lastRubber = { x1: bizConnect.x1, y1: bizConnect.y1, x2: wp.x, y2: wp.y };
    drawEdges(lastRubber);
    return;
  }
  if (bizPan) {
    cam.panX = bizPan.ox + (e.clientX - bizPan.sx);
    cam.panY = bizPan.oy + (e.clientY - bizPan.sy);
    bizPan.moved = true;
    applyTransform();
  }
}

/** Put the DOM back where the document says, after a drop the Final lock refused. */
function snapBack(ids: Iterable<string>): void {
  for (const id of ids) {
    const t = props.flow?.steps[id], el = nodeEl(id);
    if (t && el) { el.style.left = Math.round(t.x) + 'px'; el.style.top = Math.round(t.y) + 'px'; }
  }
  for (const [gid] of liveGroup) {
    const g = props.flow?.groups[gid];
    const el = worldEl.value?.querySelector<HTMLElement>(`.bz-group[data-bz-group="${q(gid)}"]`);
    if (g && g.collapsed && el) { el.style.left = Math.round(g.x) + 'px'; el.style.top = Math.round(g.y) + 'px'; }
  }
}

function onMouseUp(e: MouseEvent): void {
  const f = props.flow;
  if (viaDrag) {
    document.body.classList.remove('bz-routing');
    const d = viaDrag;
    viaDrag = null;
    if (d.moved) {
      suppressClick = true; // a bend is not a click on the handoff
      const ok = commit(() => { quietWrite = true; setEdgeField(doc, d.edgeId, 'via', d.via); });
      liveVia.delete(d.edgeId);
      if (!ok) drawEdges();
      // Taught once per session, and only when a redirector was actually made.
      if (ok && d.created && !routedOnce) {
        routedOnce = true;
        toast('Redirector added — drag it to route the handoff around anything in the way, double-click it to remove.', 'suggest');
      }
    }
    return;
  }
  if (miniDrag) { miniDrag = false; saveCamera(); return; }
  if (marquee) {
    const m = marquee;
    marquee = null;
    const cv = canvasEl.value;
    const x0 = Math.min(m.sx, m.cx == null ? m.sx : m.cx);
    const x1 = Math.max(m.sx, m.cx == null ? m.sx : m.cx);
    const y0 = Math.min(m.sy, m.cy == null ? m.sy : m.cy);
    const y1 = Math.max(m.sy, m.cy == null ? m.sy : m.cy);
    m.el.remove();
    if (x1 - x0 > 3 && y1 - y0 > 3 && cv) {
      const r = cv.getBoundingClientRect();
      // Intersection, not containment: brushing a box is enough to catch it.
      const sel = [...selection.value];
      cv.querySelectorAll<HTMLElement>('.bz-node').forEach((el) => {
        const b = el.getBoundingClientRect();
        const bx0 = b.left - r.left, bx1 = b.right - r.left, by0 = b.top - r.top, by1 = b.bottom - r.top;
        const id = el.dataset.bzNode!;
        if (bx1 >= x0 && bx0 <= x1 && by1 >= y0 && by0 <= y1 && !sel.includes(id)) sel.push(id);
      });
      selection.value = sel;
      if (sel.length) toast(`${sel.length} step${sel.length === 1 ? '' : 's'} selected — ⊟ Group to frame them.`, 'suggest');
    }
    return;
  }
  if (groupDrag) {
    const d = groupDrag;
    groupDrag = null;
    if (d.moved) {
      suppressClick = true;
      const gp = liveGroup.get(d.id);
      const moves = d.items.map((it) => ({ id: it.id, ...(live.get(it.id) ?? { x: it.ox, y: it.oy }) }));
      const ok = commit(() => doc.transact(() => {
        quietWrite = true;
        moveSteps(doc, moves);
        if (gp && f?.groups[d.id]) { setGroupField(doc, d.id, 'x', gp.x); setGroupField(doc, d.id, 'y', gp.y); }
      }, LOCAL_ORIGIN));
      const ids = d.items.map((it) => it.id);
      live.clear();
      if (!ok) { snapBack(ids); }
      liveGroup.clear();
      if (!ok) { layoutGroups(); drawEdges(); }
    }
    return;
  }
  if (bizDrag) {
    const d = bizDrag;
    if (d.moved) {
      for (const it of d.items) it.el?.classList.remove('dragging');
      d.el.style.zIndex = '6';
      frontId.value = d.id;
      suppressClick = true;
      // Where a box lands decides its frame — but only for a box with no frame to lose, or a drag
      // that asked to leave one. The only place geometry writes membership.
      let escaped = 0;
      const regroup: Array<{ id: string; groupId: string | null }> = [];
      for (const it of d.items) {
        const t = f?.steps[it.id];
        if (!t || !it.el) continue;
        if (t.groupId && !d.detach) continue;
        const g = groupAt(it.el.offsetLeft + it.el.offsetWidth / 2, it.el.offsetTop + 20);
        const next = g ? g.id : null;
        if (next !== t.groupId) { if (t.groupId && !next) escaped++; regroup.push({ id: t.id, groupId: next }); }
      }
      dragHintClear();
      const moves = d.items.filter((it) => it.el && live.has(it.id)).map((it) => ({ id: it.id, ...live.get(it.id)! }));
      const ok = commit(() => doc.transact(() => {
        quietWrite = !regroup.length;
        moveSteps(doc, moves);
        for (const r of regroup) setStepField(doc, r.id, 'groupId', r.groupId);
      }, LOCAL_ORIGIN));
      live.clear();
      if (!ok) { snapBack(d.items.map((it) => it.id)); layoutGroups(); drawEdges(); }
      if (escaped) toast(`${escaped} step${escaped === 1 ? '' : 's'} pulled out of the frame.`, 'suggest');
    }
    bizDrag = null;
    dragHintClear();
    return;
  }
  if (bizConnect) {
    document.body.classList.remove('bz-connecting');
    const { fromId, fromPort } = bizConnect;
    bizConnect = null; lastRubber = null;
    const t = e.target as Element;
    // Drop resolution, most specific first: an input socket names its own mating point; a bare box
    // takes its first exposed one; a collapsed frame can only be joined at an existing crossing.
    const inSock = t.closest<HTMLElement>('.bz-socket.in');
    const targetNode = t.closest<HTMLElement>('.bz-node');
    const targetGroup = t.closest<HTMLElement>('.bz-group');
    let toId: string | null = null, toPort: string | null = null;
    if (f && inSock) {
      toId = inSock.dataset.bzNodeId!;
      const owner = f.steps[toId];
      toPort = (isSubflow(owner) && inSock.dataset.port) ? inSock.dataset.port : null;
    } else if (f && targetNode) {
      toId = targetNode.dataset.bzNode!;
      const owner = f.steps[toId];
      if (isSubflow(owner)) {
        const open = subflowOpenPorts(ws.value, f, owner, 'in');
        if (!open.length) { toast('That nested flow exposes no entry point — tick one on its card first.', 'error'); toId = null; }
        else toPort = open[0]!.id;
      }
    } else if (targetGroup) {
      const sock = targetGroup.querySelector<HTMLElement>('.bz-socket.in');
      if (sock) toId = sock.dataset.bzNodeId!;
      else toast('Nothing feeds into that collapsed group yet — expand it and connect to a step inside.', 'suggest');
    }
    if (f && toId && toId !== fromId) {
      const key = edgeKey({ from: fromId, fromPort, to: toId, toPort });
      if (edgesOf(f).some((x) => edgeKey(x) === key)) toast('Those two mating points are already connected.', 'suggest');
      else {
        const target = toId;
        commit(() => addEdge(doc, f.id, fromId, target, { label: '', artifactIds: [], fromPort, toPort, via: [] }));
      }
    }
    drawEdges();
    freshRaster();
    return;
  }
  if (bizPan) {
    canvasEl.value?.classList.remove('panning');
    if (bizPan.moved) saveCamera();
    bizPan = null;
  }
}

// ---- clicks (the bizcase branch of index.html's delegated click handler, in its order) --------------
/**
 * The shell drops focus from a clicked button, because index.html's re-render throws the button
 * away. Where the source does NOT re-render — a zoom pill, ⧉, a "point at…" opener, a delete that
 * was cancelled — its button keeps focus, and Space or Enter presses it again. Those hand it back,
 * once the shell's blur has run, unless something else has taken focus meanwhile.
 */
function keepFocus(el: Element | null): void {
  if (!(el instanceof HTMLElement)) return;
  setTimeout(() => {
    const a = document.activeElement;
    if ((!a || a === document.body) && el.isConnected) el.focus({ preventScroll: true });
  }, 0);
}
function onClick(e: MouseEvent): void {
  const t = e.target as Element;
  // A drag just ended — swallow its trailing click if it lands on what was dragged.
  if (suppressClick) {
    suppressClick = false;
    if (t.closest('.bz-node') || t.closest('.bz-group') || t.closest('[data-bz-edge]') || t.closest('[data-bz-via]')) return;
  }
  const f = props.flow;
  if (!f) return;
  const el = (sel: string) => t.closest<HTMLElement>(sel);
  let hit: HTMLElement | null;
  if ((hit = el('[data-bz-open-sub]'))) { openSubflow(hit.dataset.bzOpenSub!); return; }
  if ((hit = el('[data-bz-repoint]'))) {
    popover.value = { kind: 'repoint', taskId: hit.dataset.bzRepoint!, anchor: anchorOf(hit) };
    keepFocus(hit);
    return;
  }
  if ((hit = el('[data-bz-port]'))) { togglePort(hit.dataset.bzPort!, hit.dataset.side as 'in' | 'out', hit.dataset.portId!); return; }
  if ((hit = el('[data-bz-group-collapse]'))) { toggleCollapse(hit.dataset.bzGroupCollapse!); return; }
  if ((hit = el('[data-bz-group-color]'))) { cycleColor(hit.dataset.bzGroupColor!); return; }
  if ((hit = el('[data-bz-group-ungroup]'))) { ungroup(hit.dataset.bzGroupUngroup!); return; }
  if ((hit = el('[data-bz-group-del]'))) { const gid = hit.dataset.bzGroupDel!; deleteFrame(gid); if (props.flow?.groups[gid]) keepFocus(hit); return; }
  if ((hit = el('#bz-zoom-in'))) { zoomBy(1.1); keepFocus(hit); return; }
  if ((hit = el('#bz-zoom-out'))) { zoomBy(1 / 1.1); keepFocus(hit); return; }
  if ((hit = el('#bz-zoom-fit'))) { fit(); keepFocus(hit); return; }
  if (t.closest('#bz-zoom-level')) { zoomTo(1); return; }
  if ((hit = el('[data-bz-del-task]'))) { const id = hit.dataset.bzDelTask!; deleteTask(id); if (props.flow?.steps[id]) keepFocus(hit); return; }
  if ((hit = el('[data-bz-copy-task]'))) {
    if (copyTask(hit.dataset.bzCopyTask!)) toast('Step copied — Ctrl+V to paste', 'suggest');
    keepFocus(hit);
    return;
  }
  const edge = t.closest<SVGElement>('[data-bz-edge]');
  if (edge) {
    const id = edge.dataset.bzEdge!;
    if (f.edges[id]) popover.value = { kind: 'edge', edgeId: id, anchor: { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 } };
    return;
  }
  if ((hit = el('[data-bz-bind]'))) {
    const st = f.steps[hit.dataset.bzBind!];
    if (st && !isSubflow(st)) popover.value = { kind: 'bind', taskId: st.id, anchor: anchorOf(hit) };
    return;
  }
  if ((hit = el('[data-bz-bind-jump]'))) {
    const bt = f.steps[hit.dataset.bzBindJump!];
    if (bt && bt.bind) jumpToChartNode(bt.bind.chartId, bt.bind.nodeId);
    return;
  }
  if ((hit = el('[data-bz-cell]'))) {
    if (f.steps[hit.dataset.bzCell!]) popover.value = { kind: 'raci', taskId: hit.dataset.bzCell!, col: hit.dataset.col!, anchor: anchorOf(hit) };
    return;
  }
  if ((hit = el('[data-bz-party]'))) { openParty(hit.dataset.bzParty!, hit.dataset.col!); return; }
  // Nothing above took it: index.html closes the open popover at the end of its click handler.
  if (popover.value) popover.value = null;
}

/** Double-click a redirector to remove it; the handoff itself is untouched. */
function onDblClick(e: MouseEvent): void {
  const viaEl = (e.target as Element).closest<SVGElement>('[data-bz-via]');
  const f = props.flow;
  if (!viaEl || !f) return;
  const ed = f.edges[viaEl.dataset.bzVia!];
  const i = +(viaEl.dataset.viaI ?? -1);
  if (!ed || !ed.via[i] || !editable()) return;
  const via = ed.via.map((v) => ({ x: v.x, y: v.y }));
  via.splice(i, 1);
  commit(() => setEdgeField(doc, ed.id, 'via', via));
  toast(via.length ? 'Redirector removed.' : 'Redirector removed — the handoff runs straight again.', 'suggest');
}

/** Cursor-anchored zoom on the plain wheel, as the chart zooms. */
function onWheel(e: WheelEvent): void {
  if (!(e.target as Element | null)?.closest?.('#bz-canvas')) return;
  e.preventDefault();
  const r = canvasEl.value!.getBoundingClientRect();
  zoomTo((cam.zoom || 1) * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - r.left, e.clientY - r.top);
}

// ---- keys: the detach key mid-drag, and the step clipboard ------------------------------------------
function onKey(e: KeyboardEvent): void {
  if (e.type === 'keydown' || e.type === 'keyup') {
    // The frame answers the detach key even when the mouse is still — that is when people try it.
    if (bizDrag && bizDrag.moved && e.key === 'Alt') {
      bizDrag.detach = e.type === 'keydown';
      layoutGroups(bizDrag.detach ? new Set(bizDrag.items.map((i) => i.id)) : undefined);
      dragHintSync();
      drawEdges();
    }
  }
  if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const target = e.target as Element | null;
  if (target?.matches?.('input, textarea, [contenteditable="true"]')) return;
  const k = e.key.toLowerCase();
  if (k !== 'c' && k !== 'x' && k !== 'v') return;
  // A real text selection keeps the browser's own copy and cut.
  const textSel = window.getSelection && String(window.getSelection());
  if (textSel && (k === 'c' || k === 'x')) return;
  const primary = fs.primary.value;
  if (k === 'c' && primary) {
    e.preventDefault();
    if (copyTask(primary)) toast('Step copied — Ctrl+V to paste', 'suggest');
  } else if (k === 'x' && primary) {
    e.preventDefault(); cutTask(primary);
  } else if (k === 'v') {
    e.preventDefault(); pasteTask();
  }
}

// ---- a Flow Gallery card dropped on the canvas: nested where it lands --------------------------------
function onDragOver(e: DragEvent): void {
  if (!fs.dragFlowId.value) return;
  e.preventDefault();
  try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch { /* some browsers refuse */ }
  canvasEl.value?.classList.add('drop-target');
}
function onDrop(e: DragEvent): void {
  // Only a drag the gallery started (index.html's _bizDragCase): text dragged in from anywhere else,
  // whatever it says, nests nothing.
  const id = fs.dragFlowId.value;
  if (!id) return;
  e.preventDefault();
  const p = screenToWorld(e.clientX, e.clientY);
  fs.dragFlowId.value = null;
  document.body.classList.remove('bz-embedding');
  canvasEl.value?.classList.remove('drop-target');
  embedFlow(id, p.x - BZ_NODE_W / 2, p.y - 28);
}
watch(fs.dragFlowId, (v) => { if (!v) canvasEl.value?.classList.remove('drop-target'); });

// ---- lifecycle ---------------------------------------------------------------------------------------
// A different flow: its own camera, and nothing selected (bizSwitchCase).
watch(() => props.flow?.id, (id, was) => {
  if (id) loadCamera(id);
  if (was !== undefined && id !== was) { selection.value = []; selectedGroup.value = null; }
  void nextTick(() => { layoutAll(); freshRaster(); tryJump(); });
}, { immediate: true });
// Save and Load carry the camera: one that changes under an open flow is picked up.
const storedCam = computed(() => (props.flow ? fs.getCamera(wsId, props.flow.id) : null));
watch(storedCam, (c) => {
  if (!c || (c.panX === cam.panX && c.panY === cam.panY && c.zoom === cam.zoom)) return;
  loadCamera(props.flow!.id);
  applyTransform();
});
watch(selection, () => drawMinimap());
// Where index.html calls renderBizcase: any change to the document (but the quiet ones above), the
// party panel, the gallery and the table opening or closing.
watch(() => session.workspace.value, () => {
  if (quietWrite) { quietWrite = false; return; }
  freshRaster();
}, { flush: 'post' });
watch(() => [partyTarget.value, fs.galleryOpen.value, props.flow ? fs.isTableOpen(props.flow.id) : false], () => freshRaster(), { flush: 'post' });

/**
 * index.html lays the canvas out at the end of every render, and nothing else ever changes a card's
 * size there. Here things outside this component can: the shell sets body[data-lock] a tick after a
 * Final flow opens (hiding ⧉ and ×, so a long name stops wrapping), a theme or a web font lands. So
 * every card is watched, and the frames and noodles follow any change in its size — once a frame.
 */
let cardObs: ResizeObserver | null = null;
const watched = new Set<Element>();
let relayout = 0;
function watchCards(): void {
  const world = worldEl.value;
  if (!cardObs || !world) return;
  // A card that has left the canvas is let go, so the observer does not keep it alive.
  for (const el of watched) if (!el.isConnected) { cardObs.unobserve(el); watched.delete(el); }
  for (const el of world.querySelectorAll('.bz-node')) {
    if (watched.has(el)) continue;
    watched.add(el);
    cardObs.observe(el);
  }
}
onUpdated(() => { layoutAll(); watchCards(); });

let resizeObs: ResizeObserver | null = null;
const onResize = () => drawMinimap();
onMounted(() => {
  if (window.ResizeObserver) {
    cardObs = new ResizeObserver(() => {
      if (relayout) return;
      relayout = requestAnimationFrame(() => { relayout = 0; layoutAll(); });
    });
    watchCards();
  }
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);
  document.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver && canvasEl.value) {
    resizeObs = new ResizeObserver(() => drawMinimap());
    resizeObs.observe(canvasEl.value);
  }
  zoomLabel();
  layoutAll();
  // Card heights are text: lay out again once the fonts they are set in have arrived.
  void document.fonts?.ready.then(() => layoutAll());
  fs.canvas.register({ addTaskAtCentre, embedAtCentre, fit, focusTask, centreTask, groupSelection });
});
onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('keyup', onKey);
  document.removeEventListener('wheel', onWheel);
  window.removeEventListener('resize', onResize);
  resizeObs?.disconnect();
  cardObs?.disconnect();
  if (relayout) cancelAnimationFrame(relayout);
  cancelAnimationFrame(rasterFrame);
  document.body.classList.remove('bz-connecting', 'bz-routing', 'bz-embedding');
  marquee?.el.remove();
  fs.canvas.register(null);
});
</script>
