/**
 * The flow screen's per-person view state, shared by its two halves: the canvas (the page,
 * `pages/w/[id]/flow.vue`) and the chrome around it (`components/flow/*` — the toolbar, the strips,
 * the gallery, the table, the party panel, the popovers).
 *
 * index.html keeps all of this in module globals or in its local state — `state.bizGallery`, a
 * flow's `showTable` and `view`, `_bizSel` / `_bizSelGroup`, `bizPartyTarget`, `openPopover`.
 * Every one is a fact about ONE person's screen, so none of it goes in the shared document: one
 * person opening the gallery or selecting a step must not change anyone else's screen. What should
 * survive a reload lives in localStorage, as the chart's camera does.
 */
import type { OrgRef } from '@raci/core';

/** Where a popover hangs: a snapshot of the clicked element's box (getBoundingClientRect). */
export interface FlowAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** The popovers the canvas opens and the chrome draws — index.html's openBiz*Popover. */
export type FlowPopover =
  /** openBizRaciPopover: a step's cell in the card's RACI strip. */
  | { kind: 'raci'; taskId: string; col: string; anchor: FlowAnchor }
  /** openBizEdgePopover: a handoff — its label, condition and deliverables. */
  | { kind: 'edge'; edgeId: string; anchor: FlowAnchor }
  /** openBizBindPopover: a Chart-Linked step's bind bar — which chart row it implements. */
  | { kind: 'bind'; taskId: string; anchor: FlowAnchor }
  /**
   * openSubflowPickerPopover: a nested-flow box's "point it at another flow". Opened from the box
   * and drawn by the canvas itself (components/flow/canvas/Repoint.vue) — one slot with the others,
   * as index.html has one openPopover.
   */
  | { kind: 'repoint'; taskId: string; anchor: FlowAnchor };

/**
 * What the chrome asks of the canvas. The canvas registers it when it mounts; until then (and on
 * a screen with no canvas) every call is a no-op.
 */
export interface FlowCanvasBridge {
  /** index.html's bizAddTask: a new step dropped at the centre of the view, selected. */
  addTaskAtCentre(): void;
  /** bizEmbedAtCentre: a nested-flow box referencing `flowId`, at the centre of the view. */
  embedAtCentre(flowId: string): void;
  /** bizFit: frame every step in the view. */
  fit(): void;
  /** Centre a step in the view and flash it (the jumps from Tasks, the warnings, the table). */
  focusTask(taskId: string): void;
  /** Centre a step without the flash — bizBindNextUnbound's "centre the next unlinked step". */
  centreTask(taskId: string): void;
  /** bizGroupSelection: wrap the selected steps in a frame. */
  groupSelection(): void;
}

const LS_GALLERY = 'raci-flow-gallery-v1';
const LS_TABLE = 'raci-flow-table-v1';

/** The per-flow camera, kept per browser — what Save writes as a flow's `view`. */
export interface FlowCamera { panX: number; panY: number; zoom: number }
export const FLOW_CAMERA_PREFIX = 'raci-flow-camera-v1:';

const bridge = shallowRef<FlowCanvasBridge | null>(null);

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch { return fallback; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: session only */ }
}

export function useFlowScreen() {
  /** state.bizGallery — the Flow Gallery pane. Open by default, as index.html's defaultState has it. */
  const galleryOpen = useState<boolean>('raci:flow:gallery', () => (import.meta.client ? read(LS_GALLERY, true) : true));
  /** Each flow's showTable — the RACI table pane beside the canvas. */
  const tableOpen = useState<Record<string, boolean>>('raci:flow:table', () => (import.meta.client ? read(LS_TABLE, {}) : {}));
  /** _bizSel, in the order boxes were added: the LAST is the primary (the Ctrl+C / Ctrl+X target). */
  const selection = useState<string[]>('raci:flow:selection', () => []);
  /** _bizSelGroup — a selected frame. */
  const selectedGroup = useState<string | null>('raci:flow:selectedGroup', () => null);
  /** bizPartyTarget — whose party the #bz-party-panel is assigning. */
  const partyTarget = useState<{ taskId: string; col: string } | null>('raci:flow:partyTarget', () => null);
  /** bizPartyDraft — the panel's unsaved pick. */
  const partyDraft = useState<OrgRef | null>('raci:flow:partyDraft', () => null);
  /** openPopover, for the flow's three popovers. */
  const popover = useState<FlowPopover | null>('raci:flow:popover', () => null);

  function setGallery(on: boolean): void { galleryOpen.value = on; write(LS_GALLERY, on); }
  function isTableOpen(flowId: string | null | undefined): boolean { return !!(flowId && tableOpen.value[flowId]); }
  function setTable(flowId: string, on: boolean): void {
    tableOpen.value = { ...tableOpen.value, [flowId]: on };
    write(LS_TABLE, tableOpen.value);
  }
  /** The primary selection — bizPrimarySel. */
  const primary = computed(() => selection.value[selection.value.length - 1] ?? null);

  /**
   * Each flow's camera — index.html's per-flow `view` — cached for the session and kept per browser
   * under FLOW_CAMERA_PREFIX + workspace + ':' + flow. The canvas reads and writes it through these
   * two, and so do Save (which writes it into the file) and Load (which brings the file's back).
   */
  const cameras = useState<Record<string, FlowCamera>>('raci:flow:cameras', () => ({}));
  function getCamera(workspaceId: string, flowId: string): FlowCamera | null {
    const key = FLOW_CAMERA_PREFIX + workspaceId + ':' + flowId;
    if (cameras.value[key]) return cameras.value[key]!;
    const stored = import.meta.client ? read<FlowCamera | null>(key, null) : null;
    return stored && Number.isFinite(stored.panX) && Number.isFinite(stored.panY) && Number.isFinite(stored.zoom) ? stored : null;
  }
  function putCamera(workspaceId: string, flowId: string, cam: FlowCamera): void {
    const key = FLOW_CAMERA_PREFIX + workspaceId + ':' + flowId;
    cameras.value = { ...cameras.value, [key]: { panX: cam.panX, panY: cam.panY, zoom: cam.zoom } };
    write(key, cameras.value[key]);
  }

  /**
   * _bizNavStack — the flows this person descended through to reach the open one (⇱ on a nested
   * box pushes; the toolbar's ↩ Back pops). Runtime-only, as in index.html: picking a flow from the
   * dropdown or the gallery is a jump, not a step out, and clears it.
   */
  const navStack = useState<string[]>('raci:flow:navStack', () => []);
  /**
   * _bizDragCase — the flow a Flow Gallery card is being dragged as, from its dragstart to its
   * dragend. The canvas reads it to accept the drop and nest that flow where it lands.
   */
  const dragFlowId = useState<string | null>('raci:flow:dragFlowId', () => null);

  return {
    galleryOpen, setGallery, tableOpen, isTableOpen, setTable,
    selection, selectedGroup, primary, partyTarget, partyDraft, popover, getCamera, putCamera,
    navStack, dragFlowId,
    /** The canvas's half of the seam (see FlowCanvasBridge). */
    canvas: {
      register(b: FlowCanvasBridge | null): void { bridge.value = b; },
      addTaskAtCentre: () => bridge.value?.addTaskAtCentre(),
      embedAtCentre: (flowId: string) => bridge.value?.embedAtCentre(flowId),
      fit: () => bridge.value?.fit(),
      focusTask: (taskId: string) => bridge.value?.focusTask(taskId),
      centreTask: (taskId: string) => bridge.value?.centreTask(taskId),
      groupSelection: () => bridge.value?.groupSelection(),
    },
  };
}
