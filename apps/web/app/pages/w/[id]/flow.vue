<template>
  <div class="flow-screen">
    <div class="tools">
      <select v-if="flows.length > 1" v-model="flowId" class="flow-pick" aria-label="Flow">
        <option v-for="f in flows" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <span v-else-if="flow" class="flow-name">{{ flow.name }}</span>

      <button :disabled="!canEdit || !flow" @click="addStepAtCentre">+ Step</button>
      <button :disabled="!canEdit" @click="createFlow">+ Flow</button>

      <span v-if="health" class="health" :title="healthTitle">
        {{ health.percent }}% <span class="dim">of {{ health.total }} checks</span>
      </span>
      <span v-if="issues.length" class="note warn" :title="issueTitle">
        {{ issues.length }} advisory finding(s)
      </span>

      <span class="spacer" />
      <button :disabled="!flow" title="Frame everything on the canvas" @click="fit">⤢ Fit</button>
      <span class="zoom">{{ Math.round(view.zoom * 100) }}%</span>
    </div>

    <p v-if="!flow" class="note">
      No business case flows yet.
      <button v-if="canEdit" @click="createFlow">Create one</button>
    </p>

    <div
      v-else
      ref="canvas"
      class="canvas"
      @pointerdown="startPan"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @wheel.prevent="onWheel"
    >
      <div class="world" :style="worldStyle">
        <!-- Handoffs are drawn under the cards, so a line never sits on top of the text it connects. -->
        <svg class="wires" :viewBox="wireBox" :style="wireStyle" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <g v-for="wire in wires" :key="wire.edgeId" class="wire" :class="{ bare: !wire.carries }">
            <path :d="wire.path" class="wire-line" marker-end="url(#arrow)" />
            <circle v-for="(p, i) in wire.via" :key="i" :cx="p.x" :cy="p.y" r="4" class="via" />
          </g>
        </svg>

        <!-- Labels ride above the wires but below the cards. -->
        <div
          v-for="wire in wires"
          :key="`l-${wire.edgeId}`"
          class="wire-label"
          :class="{ bare: !wire.carries }"
          :style="{ left: `${wire.labelAt.x}px`, top: `${wire.labelAt.y}px` }"
          :title="wire.title"
        >{{ wire.text }}</div>

        <article
          v-for="step in steps"
          :key="step.id"
          :ref="(el) => registerCard(step.id, el as HTMLElement | null)"
          class="node"
          :class="[`k-${step.kind}`, { dragging: dragging?.stepId === step.id }]"
          :style="{ left: `${step.x}px`, top: `${step.y}px` }"
          @pointerdown.stop="startDrag($event, step.id)"
        >
          <span class="socket in" />
          <span class="socket out" />

          <header class="node-head">
            <span class="node-kind">{{ step.kind === 'subflow' ? '⧉ nested' : kindOf(step) }}</span>
            <span v-if="severityOf(step.id)" class="pin" :class="severityOf(step.id)"
              :title="pinTitle(step.id)">!</span>
            <button v-if="canEdit" class="del" title="Delete this step" @pointerdown.stop
              @click="removeStep(step.id)">×</button>
          </header>

          <input
            class="node-name"
            :value="step.name"
            :disabled="!canEdit"
            placeholder="Step name"
            @pointerdown.stop
            @change="renameStep(step.id, ($event.target as HTMLInputElement).value)"
          >

          <p v-if="step.kind === 'subflow'" class="node-ref">
            → {{ refName(step) }}
          </p>

          <div v-else class="node-raci">
            <span
              v-for="col in columns"
              :key="col"
              class="rc"
              :class="{ set: (step.raci[col] ?? '') !== '' }"
              :title="`${columnLabel(col)}${step.raci[col] ? `: ${step.raci[col]}` : ' — no role'}`"
              @pointerdown.stop
              @click="canEdit && cycleRole(step.id, col)"
            >
              <span class="rc-col">{{ shortLabel(col) }}</span>
              <span class="rc-letters">{{ step.raci[col] || '·' }}</span>
            </span>
          </div>

          <p v-if="stepIoText(step.id)" class="node-io">{{ stepIoText(step.id) }}</p>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The flow canvas — PORTING.md slice 3, the largest single surface in the app.
 *
 * Steps are cards on a pannable, zoomable plane; handoffs are curves between their sockets. All of
 * the arithmetic — where a socket sits, the curve between two of them, which leg a click landed on,
 * what the canvas bounds are — is `flow-geometry.ts` in core, because in `index.html` every one of
 * those answers comes out of the DOM and none of it can be tested without a browser.
 *
 * STEP POSITIONS ARE DOCUMENT DATA, unlike the chart's drill path. Where a box sits is something a
 * person decided and everyone should see; the camera (pan and zoom) is per-person and stays here.
 * That split is the opposite of the chart screen's and it is deliberate in both directions.
 *
 * `moveStep` writes x and y as separate fields on purpose, so two people dragging different steps
 * never fight over a coordinate pair. Keep it that way.
 *
 * NOT PORTED YET, and worth saying rather than leaving to be found: dragging a socket to draw a new
 * handoff, redirector waypoints (the geometry renders them; nothing creates them yet), group
 * frames, the minimap, and marquee selection. The canvas, the cards, dragging, the wires and the
 * rules are here.
 */
import {
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  chartColumns,
  edgeGeometry,
  flowBounds,
  flowHealth,
  flowViolations,
  stepBoxes,
  workspaceViolations,
  type FlowStep,
  type FlowViolation,
} from '@raci/core';
import { addFlow, addStep, deleteStep, moveStep, setStepField, setStepRaci } from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

const flows = computed(() => Object.values(session.workspace.value.flows));
const flowId = ref<string | null>(null);
const flow = computed(() =>
  flowId.value
    ? (session.workspace.value.flows[flowId.value] ?? null)
    : (flows.value[0] ?? null),
);
watch(flows, (list) => {
  if (flowId.value && !session.workspace.value.flows[flowId.value]) flowId.value = list[0]?.id ?? null;
});

const steps = computed(() => (flow.value ? Object.values(flow.value.steps) : []));
const columns = computed(() => {
  const chart = Object.values(session.workspace.value.charts)[0];
  return chart ? chartColumns(chart) : [];
});

// ---- camera. Per-person: pan and zoom are not facts about the process. ---------------------------
const canvas = ref<HTMLElement | null>(null);
const view = ref({ zoom: 1, panX: 40, panY: 40 });
const worldStyle = computed(() => ({
  transform: `translate(${view.value.panX}px, ${view.value.panY}px) scale(${view.value.zoom})`,
}));

function onWheel(event: WheelEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return;
  const next = Math.min(2.5, Math.max(0.25, view.value.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
  // Zoom about the pointer, not the origin: zooming about a corner walks whatever you were
  // looking at off the screen.
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const scale = next / view.value.zoom;
  view.value = {
    zoom: next,
    panX: px - (px - view.value.panX) * scale,
    panY: py - (py - view.value.panY) * scale,
  };
}

function fit() {
  const rect = canvas.value?.getBoundingClientRect();
  const bounds = flow.value ? flowBounds(boxes.value.values()) : null;
  if (!rect || !bounds) {
    view.value = { zoom: 1, panX: 40, panY: 40 };
    return;
  }
  const pad = 56;
  const zoom = Math.min(
    2.5,
    Math.max(0.25, Math.min(rect.width / (bounds.width + pad * 2), rect.height / (bounds.height + pad * 2))),
  );
  view.value = {
    zoom,
    panX: rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom,
    panY: rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom,
  };
}

// ---- measured card heights ----------------------------------------------------------------------
// Core computes the geometry; the one thing it cannot know is how tall a card came out, because
// that is content-driven. The renderer measures and hands it over.
const heights = ref(new Map<string, number>());
const cards = new Map<string, HTMLElement>();

function registerCard(stepId: string, el: HTMLElement | null) {
  if (el) cards.set(stepId, el);
  else cards.delete(stepId);
}

function measure() {
  const next = new Map<string, number>();
  for (const [id, el] of cards) next.set(id, el.offsetHeight);
  // Only replace when something actually moved, or this loops: the write triggers a re-render,
  // which re-measures, which writes again.
  const changed =
    next.size !== heights.value.size ||
    [...next].some(([id, h]) => heights.value.get(id) !== h);
  if (changed) heights.value = next;
}

onMounted(() => {
  measure();
  fit();
});
watch([steps, () => session.workspace.value], () => nextTick(measure));

const boxes = computed(() => (flow.value ? stepBoxes(flow.value, heights.value) : new Map()));

// ---- wires ---------------------------------------------------------------------------------------
const wires = computed(() => {
  const f = flow.value;
  if (!f) return [];
  return Object.values(f.edges).flatMap((edge) => {
    const geometry = edgeGeometry(f, edge, boxes.value);
    if (!geometry) return [];
    const carried = edge.artifactIds
      .map((id) => session.workspace.value.artifacts[id]?.name ?? '(missing)')
      .join(', ');
    const text = [edge.label, carried].filter(Boolean).join(' — ');
    return [{
      ...geometry,
      carries: edge.artifactIds.length > 0,
      text: text || 'no deliverable',
      title: carried
        ? `Carries ${carried}`
        : 'This handoff names no deliverable — what, exactly, moves?',
    }];
  });
});

/**
 * The SVG spans the whole world in world coordinates.
 *
 * Sized from the content rather than fixed, so a step dragged far out stays on the canvas instead
 * of having its wires clipped at an arbitrary edge.
 */
const wireBox = computed(() => {
  const bounds = flowBounds(boxes.value.values());
  if (!bounds) return '0 0 100 100';
  const pad = 400;
  return `${bounds.minX - pad} ${bounds.minY - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`;
});
const wireStyle = computed(() => {
  const bounds = flowBounds(boxes.value.values());
  if (!bounds) return {};
  const pad = 400;
  return {
    left: `${bounds.minX - pad}px`,
    top: `${bounds.minY - pad}px`,
    width: `${bounds.width + pad * 2}px`,
    height: `${bounds.height + pad * 2}px`,
  };
});

// ---- rules ---------------------------------------------------------------------------------------
const issues = computed<FlowViolation[]>(() => {
  const f = flow.value;
  if (!f) return [];
  // Through the workspace wrapper, so an anchored flow gets the owner column it inherits from its
  // chart row. Calling flowViolations bare would nag every step for an owner it already has.
  const all = workspaceViolations(session.workspace.value).flows.get(f.id);
  return all ?? flowViolations(session.workspace.value, f.id);
});
const byStep = computed(() => {
  const map = new Map<string, FlowViolation[]>();
  for (const v of issues.value) {
    const list = map.get(v.stepId);
    if (list) list.push(v);
    else map.set(v.stepId, [v]);
  }
  return map;
});
const severityOf = (stepId: string): 'err' | 'warn' | null => {
  const found = byStep.value.get(stepId);
  if (!found?.length) return null;
  return found.some((v) => v.severity === 'err') ? 'err' : 'warn';
};
const pinTitle = (stepId: string) =>
  (byStep.value.get(stepId) ?? []).map((v) => v.message).join('\n');
const issueTitle = computed(() => issues.value.slice(0, 8).map((v) => v.message).join('\n'));

const health = computed(() =>
  flow.value ? flowHealth(session.workspace.value, flow.value.id) : null,
);
const healthTitle = computed(() =>
  health.value
    ? `${health.value.passed} of ${health.value.total} checks pass — every step with an owner and a doer, every handoff naming a deliverable.`
    : '',
);

// ---- labels ---------------------------------------------------------------------------------------
const columnLabel = (col: string) =>
  session.workspace.value.columnLabels[col] ??
  COL_LABELS_DEFAULT[col as keyof typeof COL_LABELS_DEFAULT] ??
  col;
const shortLabel = (col: string) =>
  session.workspace.value.columnShort[col] ??
  COL_SHORT_DEFAULT[col as keyof typeof COL_SHORT_DEFAULT] ??
  col;

const kindOf = (step: FlowStep) => {
  const outgoing = flow.value
    ? Object.values(flow.value.edges).filter((e) => e.from === step.id).length
    : 0;
  return outgoing >= 2 ? 'decision' : 'step';
};

const refName = (step: FlowStep) =>
  step.refId ? (session.workspace.value.flows[step.refId]?.name ?? '(missing flow)') : '(not pointed anywhere)';

/** A step's deliverables in and out, derived from its handoffs rather than stored on it. */
function stepIoText(stepId: string): string {
  const f = flow.value;
  if (!f) return '';
  const name = (id: string) => session.workspace.value.artifacts[id]?.name ?? '(missing)';
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const edge of Object.values(f.edges)) {
    if (edge.to === stepId) for (const id of edge.artifactIds) inputs.add(name(id));
    if (edge.from === stepId) for (const id of edge.artifactIds) outputs.add(name(id));
  }
  const parts: string[] = [];
  if (inputs.size) parts.push(`⇥ ${[...inputs].join(', ')}`);
  if (outputs.size) parts.push(`↦ ${[...outputs].join(', ')}`);
  return parts.join('   ');
}

// ---- dragging ------------------------------------------------------------------------------------
const dragging = ref<{ stepId: string; dx: number; dy: number } | null>(null);
const panning = ref<{ x: number; y: number; panX: number; panY: number } | null>(null);

function startDrag(event: PointerEvent, stepId: string) {
  if (!canEdit.value || !flow.value) return;
  const step = flow.value.steps[stepId];
  if (!step) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  // Remember the grab offset in world units, so the card does not jump to centre under the cursor.
  dragging.value = {
    stepId,
    dx: event.clientX / view.value.zoom - step.x,
    dy: event.clientY / view.value.zoom - step.y,
  };
}

function startPan(event: PointerEvent) {
  if (dragging.value) return;
  panning.value = { x: event.clientX, y: event.clientY, panX: view.value.panX, panY: view.value.panY };
}

function onPointerMove(event: PointerEvent) {
  if (dragging.value) {
    const { stepId, dx, dy } = dragging.value;
    moveStep(
      session.doc,
      stepId,
      Math.round(event.clientX / view.value.zoom - dx),
      Math.round(event.clientY / view.value.zoom - dy),
    );
    return;
  }
  if (panning.value) {
    view.value = {
      ...view.value,
      panX: panning.value.panX + (event.clientX - panning.value.x),
      panY: panning.value.panY + (event.clientY - panning.value.y),
    };
  }
}

const endDrag = () => {
  dragging.value = null;
  panning.value = null;
};

// ---- mutations -----------------------------------------------------------------------------------
const renameStep = (stepId: string, name: string) => setStepField(session.doc, stepId, 'name', name);
const removeStep = (stepId: string) => deleteStep(session.doc, stepId);

/**
 * Cycle a column through the framework's roles.
 *
 * A click is the whole interaction here because a flow step carries one letter per column far more
 * often than several — the chart is where a cell holds "AR". Clicking past the last role clears it.
 */
function cycleRole(stepId: string, column: string) {
  const step = flow.value?.steps[stepId];
  if (!step) return;
  const roles = ['A', 'R', 'C', 'I'];
  const at = roles.indexOf(step.raci[column] ?? '');
  setStepRaci(session.doc, stepId, column, at + 1 >= roles.length ? '' : roles[at + 1]!);
}

/** Drop a new step where the person is actually looking, not at the world origin. */
function addStepAtCentre() {
  const f = flow.value;
  const rect = canvas.value?.getBoundingClientRect();
  if (!f) return;
  const x = rect ? (rect.width / 2 - view.value.panX) / view.value.zoom : 100;
  const y = rect ? (rect.height / 2 - view.value.panY) / view.value.zoom : 100;
  addStep(session.doc, f.id, { name: '', x: Math.round(x), y: Math.round(y) });
}

function createFlow() {
  flowId.value = addFlow(session.doc, 'New business case');
}
</script>

<style scoped>
.flow-screen { display: flex; flex-direction: column; height: calc(100vh - 190px); min-height: 420px; }
.tools { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.tools .spacer { flex: 1; }
.flow-pick { font: inherit; font-size: 12px; background: var(--bg-2); color: inherit;
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.flow-name { font-weight: 600; font-size: 13px; }
.health { font-size: 12px; color: #51cf66; cursor: help; }
.health .dim { color: var(--text-dim); }
.zoom { font-size: 11px; color: var(--text-dim); min-width: 42px; text-align: right; }
.note { color: var(--text-dim); font-size: 12px; }
.note.warn { color: #ffd43b; cursor: help; }

.canvas { position: relative; flex: 1; overflow: hidden; cursor: grab;
  background: var(--bg); background-image:
    radial-gradient(circle, rgba(255, 255, 255, .05) 1px, transparent 1px);
  background-size: 22px 22px;
  border: 1px solid var(--border); border-radius: 8px; touch-action: none; }
.canvas:active { cursor: grabbing; }
.world { position: absolute; inset: 0; transform-origin: 0 0; }

.wires { position: absolute; overflow: visible; pointer-events: none; color: var(--text-dim); }
.wire-line { fill: none; stroke: var(--accent); stroke-width: 2; opacity: .75; }
.wire.bare .wire-line { stroke: #ffa94d; stroke-dasharray: 5 4; }
.via { fill: var(--accent); opacity: .8; }
.wire-label { position: absolute; transform: translate(-50%, -50%); font-size: 10px;
  background: var(--bg); color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 9px; padding: 1px 7px; white-space: nowrap; pointer-events: none; z-index: 1; }
.wire-label.bare { color: #ffa94d; border-color: #7a4a12; font-style: italic; }

.node { position: absolute; width: 220px; background: var(--bg-2);
  border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px 9px;
  box-shadow: 0 5px 16px rgba(0, 0, 0, .45); z-index: 2; cursor: grab;
  display: flex; flex-direction: column; gap: 5px; }
.node.dragging { border-color: var(--accent); box-shadow: 0 10px 28px rgba(0, 0, 0, .6); z-index: 5; }
.node.k-subflow { border-style: dashed; }
.socket { position: absolute; top: 50%; transform: translateY(-50%); width: 11px; height: 11px;
  border-radius: 50%; background: var(--bg); border: 2px solid var(--accent); z-index: 3; }
.socket.in { left: -7px; }
.socket.out { right: -7px; }

.node-head { display: flex; align-items: center; gap: 6px; }
.node-kind { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
.node-head .pin { margin-left: auto; color: #ffd43b; font-weight: 700; cursor: help; }
.node-head .pin.err { color: #ff6b6b; }
.node-head .del { background: none; border: 0; color: var(--text-dim); cursor: pointer;
  font-size: 13px; padding: 0 3px; }
.node-head .del:hover { color: #ff6b6b; }
.node-name { font: inherit; font-size: 13px; font-weight: 600; width: 100%;
  background: transparent; color: inherit; border: 0; border-bottom: 1px solid transparent;
  padding: 1px 0; cursor: text; }
.node-name:hover:not(:disabled) { border-bottom-color: var(--border); }
.node-name:focus { outline: none; border-bottom-color: var(--accent); }
.node-ref { margin: 0; font-size: 11px; color: var(--text-dim); font-style: italic; }

.node-raci { display: flex; flex-wrap: wrap; gap: 3px; }
.rc { display: flex; align-items: center; gap: 3px; font-size: 9px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; color: var(--text-dim); }
.rc:hover { border-color: var(--accent); }
.rc.set { color: var(--text); border-color: var(--accent); }
.rc-letters { font-weight: 700; font-size: 10px; }
.node-io { margin: 0; font-size: 10px; color: var(--text-dim); }
</style>
