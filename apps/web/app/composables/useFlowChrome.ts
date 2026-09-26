/**
 * The flow screen's chrome, the part more than one of its pieces needs — index.html's helpers and
 * mutations behind the toolbar, the strips, the gallery, the table, the party panel and the
 * popovers (components/flow/*), ported one for one so each keeps the source's words and order.
 *
 * Everything here reads the document through the legacy helpers in @raci/core (`createLintContext`
 * is index.html's bizStepRaci / bizBindCtx / inheritedOwnerColIn), so a cell, a count or a
 * tooltip here says what index.html says about the same document. Every write is a CRDT mutation
 * under LOCAL_ORIGIN; the per-person view state (gallery, table, selection, the Back trail, the
 * party panel, the popovers) lives in useFlowScreen, never in the document.
 */
import {
  COLS,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  ACTORS,
  artifactsInOrder,
  chartTierLabel,
  chartsInOrder,
  createLintContext,
  embedWouldCycle,
  flowsInOrder,
  framework,
  legacyChartShape,
  normalizeRaci,
  resolveActiveChart,
  resolveActiveFlow,
  stepLabel,
  subflowRefId,
  type BindContext,
  type Chart,
  type ChartNode,
  type ColKey,
  type Flow,
  type FlowEdge,
  type FlowStep,
  type OrgRef,
} from '@raci/core';
import {
  LOCAL_ORIGIN,
  addArtifact,
  addFlow,
  deleteEdge,
  deleteFlow,
  duplicateFlow,
  setEdgeField,
  setFlowField,
  setStepField,
  setStepOverrides,
  setStepParty,
  setStepRaci,
} from '@raci/crdt';
import type { ToastType } from '~/composables/useShell';
import { FLOW_CAMERA_PREFIX } from '~/composables/useFlowScreen';
import { legacyOrgLabel } from '~/composables/useOrgLabel';

/** index.html's BIZ_MODES / BIZ_MODE_META — the mode picker's options, icons and explanations. */
export const BIZ_MODES = ['free', 'linked'] as const;
export type BizMode = (typeof BIZ_MODES)[number];
export const BIZ_MODE_META: Readonly<Record<BizMode, { name: string; icon: string; blurb: string }>> = {
  free: { name: 'Free-Form', icon: '✦', blurb: 'Each step’s RACI is authored on the step itself. No chart stands behind it.' },
  linked: { name: 'Chart-Linked', icon: '⛓', blurb: 'Every step names the chart row it implements and inherits that row’s RACI.' },
};

/** index.html's STATUS_META, with the icons the strip and the picker print. */
export const ART_STATUS_META = {
  draft: { short: 'DRAFT', icon: '✎', blurb: 'Working copy — still being written, and free to change.' },
  final: { short: 'FINAL', icon: '✓', blurb: 'Signed off, and locked against edits.' },
} as const;

/** index.html's BZ_NODE_W: a step card's fixed width, which the gallery sketch scales from. */
export const BZ_NODE_W = 220;

/**
 * index.html's showToast(msg, 'ok'): a plain toast, neither the error's red nor the suggestion's
 * amber. The shell's toast binds its type as the class, as the source's does, so 'ok' draws the
 * source's unstyled toast — the shell's type just does not list it yet.
 */
export const TOAST_OK = 'ok' as unknown as ToastType;

/** bizBindCtx: what a bound step reads off its chart row, with the parts the chrome prints. */
export interface BindInfo {
  readonly ctx: BindContext;
  readonly chart: Chart;
  readonly node: ChartNode;
  /** The row's tier: 0 for a top-level row. */
  readonly tier: number;
  readonly tierLabel: string;
  /** Chart title › ancestors › the row. */
  readonly crumb: readonly string[];
  /** The row's and its ancestors' roster refs, shallow → deep. */
  readonly orgRefs: readonly OrgRef[];
}

/** resolveAnchor + bizAnchorCtx: the chart row an anchored flow hangs under. */
export interface AnchorInfo {
  readonly chart: Chart;
  readonly node: ChartNode;
  /** The row's ancestors, top first. */
  readonly ancestors: readonly ChartNode[];
  readonly ownerColumn: string | null;
  readonly orgRefs: readonly OrgRef[];
}

/** normalizeOrgRef: an entity ref, or a roster ref cut at its first missing level; null if neither. */
export function normalizeOrgRef(ref: unknown): OrgRef | null {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as Record<string, unknown>;
  if (typeof r.entityId === 'string' && r.entityId) return { entityId: r.entityId };
  if (!(ACTORS as readonly unknown[]).includes(r.actor)) return null;
  const actor = r.actor as (typeof ACTORS)[number];
  if (typeof r.divisionId !== 'string' || !r.divisionId) return { actor };
  if (typeof r.branchId !== 'string' || !r.branchId) return { actor, divisionId: r.divisionId };
  if (typeof r.teamId !== 'string' || !r.teamId) return { actor, divisionId: r.divisionId, branchId: r.branchId };
  return { actor, divisionId: r.divisionId, branchId: r.branchId, teamId: r.teamId };
}

export function useFlowChrome() {
  const session = useWorkspaceSession();
  const shell = useShell();
  const lock = useLock();
  const labels = useLabels();
  const screen = useFlowScreen();
  const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));
  const activeFlowId = useActiveFlowId();
  const activeChartId = useActiveChartId();

  const ws = computed(() => session.workspace.value);
  /** state.bizCases, in the source's array order. */
  const flows = computed(() => flowsInOrder(ws.value));
  /** abc(): the open flow, or the first one. */
  const active = computed(() => resolveActiveFlow(ws.value, activeFlowId.value));
  /** One rule-pass context per document snapshot — bizStepRaci, bizBindCtx and the cascade. */
  const lint = computed(() => createLintContext(ws.value, activeChartId.value));

  // ---- vocabulary --------------------------------------------------------------------------------
  /** COL_LABELS[k] / COL_SHORT[k]: the workspace's own, unless blank. */
  const colLabel = (k: string): string => ws.value.columnLabels[k] || COL_LABELS_DEFAULT[k as ColKey] || k;
  const colShort = (k: string): string => ws.value.columnShort[k] || COL_SHORT_DEFAULT[k as ColKey] || k;
  const orgLabel = (org: OrgRef | null | undefined) => legacyOrgLabel(ws.value, labels.actorLabel, org);
  /** partyLabel: orgLabel, plus a directorate on its own. */
  function partyLabel(ref: OrgRef | null | undefined): { short: string; full: string } | null {
    if (!ref) return null;
    if ('entityId' in ref) return orgLabel(ref);
    if (!(ACTORS as readonly string[]).includes(ref.actor)) return null;
    if (ref.divisionId) return orgLabel(ref);
    const name = labels.actorLabel(ref.actor);
    return { short: name, full: name };
  }

  // ---- the flow graph ----------------------------------------------------------------------------
  const steps = (f: Flow): FlowStep[] => Object.values(f.steps);
  /** b.edges, as index.html's loader keeps them. */
  const edges = (f: Flow): readonly FlowEdge[] => lint.value.edges(f);
  const isSub = (s: FlowStep | null | undefined): boolean => !!s && s.kind === 'subflow';
  /** bizTaskLabel. */
  const taskLabel = (f: Flow, s: FlowStep | null | undefined): string => (s ? stepLabel(ws.value, f, s) : '—');
  /** bizCaseName. */
  const flowName = (id: string): string => ws.value.flows[id]?.name || 'Untitled';
  /** bizHostsOf: every flow that nests `refId`. */
  const hostsOf = (refId: string): Flow[] =>
    flows.value.filter((b) => steps(b).some((t) => isSub(t) && subflowRefId(b, t) === refId));
  /** bizEmbedWouldCycle. */
  const wouldCycle = (hostId: string, refId: string): boolean => embedWouldCycle(ws.value, hostId, refId);
  /** A step of the OPEN flow, as bizTaskById finds it. */
  const stepOf = (id: string): FlowStep | null => active.value?.steps[id] ?? null;
  /** Where a step is, whichever flow holds it — for a panel still showing a step of a flow just left. */
  function locate(id: string): { flow: Flow; step: FlowStep } | null {
    for (const f of flows.value) {
      const step = f.steps[id];
      if (step) return { flow: f, step };
    }
    return null;
  }

  // ---- charts, anchors, binds ----------------------------------------------------------------------
  const isFreeChart = (c: Chart): boolean => legacyChartShape(c).free;
  /** bizLinkableCharts: the organization charts, in tab order. */
  const linkable = computed(() => chartsInOrder(ws.value).filter((c) => !isFreeChart(c)));
  const isLinked = (f: Flow | null | undefined): boolean => !!f && f.mode === 'linked';
  /** A row's ancestors in the legacy tree, top first. */
  function ancestorsIn(chart: Chart, nodeId: string): ChartNode[] {
    const out: ChartNode[] = [];
    for (let p = lint.value.tree(chart).byId.get(nodeId)?.parent ?? null; p; p = p.parent) out.unshift(p.node);
    return out;
  }
  const refsOf = (nodes: readonly ChartNode[]): OrgRef[] =>
    nodes.map((n) => normalizeOrgRef(n.org)).filter((r): r is OrgRef => r !== null);
  /** resolveAnchor + bizAnchorCtx. Null when unanchored or when the row is gone. */
  function anchorInfo(f: Flow | null | undefined): AnchorInfo | null {
    const a = f ? lint.value.anchor(f) : null;
    if (!a) return null;
    const ancestors = ancestorsIn(a.chart, a.node.id);
    return { chart: a.chart, node: a.node, ancestors, ownerColumn: a.ownerColumn, orgRefs: refsOf([...ancestors, a.node]) };
  }
  /** bizSourceChart: its own choice, else its anchor's chart, else the chart in front, else the first. */
  function sourceChart(f: Flow | null | undefined): Chart | null {
    const own = f?.sourceChartId ? ws.value.charts[f.sourceChartId] : undefined;
    if (own && !isFreeChart(own)) return own;
    const an = f ? lint.value.anchor(f) : null;
    if (an && !isFreeChart(an.chart)) return an.chart;
    const front = resolveActiveChart(ws.value, activeChartId.value);
    if (front && !isFreeChart(front)) return front;
    return linkable.value[0] ?? null;
  }
  /** bizBindCtx. Null for an unbound step, a nested box, or a row that is gone. */
  function bindInfo(step: FlowStep | null | undefined): BindInfo | null {
    const ctx = step ? lint.value.bind(step) : null;
    if (!ctx) return null;
    const ancestors = ancestorsIn(ctx.chart, ctx.node.id);
    return {
      ctx,
      chart: ctx.chart,
      node: ctx.node,
      tier: ancestors.length,
      tierLabel: chartTierLabel(ctx.chart, ancestors.length),
      crumb: [ctx.chart.title || 'Untitled chart', ...ancestors.map((n) => n.name || '(untitled)'), ctx.node.name || '(untitled)'],
      orgRefs: refsOf([...ancestors, ctx.node]),
    };
  }
  /** bizDefaultPartyForTask: the dashed default party a column falls back to. */
  function defaultParty(f: Flow, step: FlowStep, col: string): OrgRef | null {
    const refs = (isLinked(f) ? bindInfo(step)?.orgRefs : null) ?? anchorInfo(f)?.orgRefs ?? null;
    if (!refs) return null;
    const actor = labels.columnActor(col);
    if (!actor) return null;
    let ref: OrgRef = { actor };
    for (const r of refs) if ('actor' in r && r.actor === actor) ref = { ...r };
    return ref;
  }

  // ---- guards --------------------------------------------------------------------------------------
  /**
   * index.html's enforceLocks, for the paths where the source has no guard of its own: the edit is
   * made, saveState rolls it back, and the toast says so. Here the edit is simply not made.
   */
  function refusedByLock(f: Flow): boolean {
    if (f.status !== 'final') return false;
    lock.refuseLockedEdit('flow', `“${f.name || 'Untitled'}” is Final — that change was rolled back. Reopen it as a draft to edit it.`);
    return true;
  }

  // ---- the flow list -------------------------------------------------------------------------------
  /** closeBizPartyPanel. */
  function closeParty(): void {
    screen.partyTarget.value = null;
    screen.partyDraft.value = null;
  }
  /** bizAddCase. */
  function addCase(): void {
    if (!canEdit.value) return;
    const id = addFlow(session.doc, `Business case ${flows.value.length + 1}`);
    screen.switchFlow(id);
  }
  /** bizRenameCase. */
  function renameCase(): void {
    const b = active.value;
    if (!b || !canEdit.value) return;
    const nm = prompt('Rename business case:', b.name);
    if (nm == null) return;
    const next = nm.trim() || b.name;
    if (next !== b.name) setFlowField(session.doc, b.id, 'name', next);
  }
  /** bizDeleteCase. */
  function deleteCase(): void {
    const b = active.value;
    if (!b || !canEdit.value) return;
    if (!lock.guardEdit('flow', b)) return;
    if (flows.value.length <= 1) { shell.toast('Keep at least one business case.', 'error'); return; }
    const hosts = hostsOf(b.id);
    const warn = hosts.length
      ? `\n\n${hosts.length} other flow${hosts.length === 1 ? '' : 's'} nest${hosts.length === 1 ? 's' : ''} this one (${hosts.map((h) => h.name || 'Untitled').join(', ')}). Those boxes will be left pointing at a missing flow.`
      : '';
    if (!confirm(`Delete business case "${b.name}" and all its tasks?${warn}`)) return;
    closeParty();
    const next = flows.value.find((x) => x.id !== b.id)!;
    const trail = screen.navStack.value.filter((id) => id !== b.id);
    deleteFlow(session.doc, b.id);
    screen.switchFlow(next.id, true);
    screen.navStack.value = trail;
  }
  /** duplicateFlow + bizSwitchCase: a Draft copy, opened. */
  function duplicateCase(id: string): void {
    const src = ws.value.flows[id];
    if (!src || !canEdit.value) return;
    const taken = flows.value.map((b) => b.name);
    const want = /^Copy of /.test(src.name) ? src.name : `Copy of ${src.name || 'Untitled'}`;
    let name = want;
    for (let i = 2; taken.includes(name); i++) name = `${want} (${i})`;
    const copy = duplicateFlow(session.doc, id, name);
    if (!copy) return;
    // The copy carries the original's camera and table pane, as the source's JSON copy carries its
    // view and showTable — both are this browser's, so they are copied here rather than in the doc.
    if (screen.isTableOpen(id)) screen.setTable(copy, true);
    try {
      const cam = localStorage.getItem(`${FLOW_CAMERA_PREFIX}${session.workspaceId}:${id}`);
      if (cam !== null) localStorage.setItem(`${FLOW_CAMERA_PREFIX}${session.workspaceId}:${copy}`, cam);
    } catch { /* storage blocked: the copy opens with a fresh camera */ }
    screen.switchFlow(copy);
  }
  /** setCaseStatus. */
  function setStatus(id: string, st: 'draft' | 'final'): void {
    const b = ws.value.flows[id];
    if (!b || !canEdit.value || b.status === st) return;
    session.doc.transact(() => {
      setFlowField(session.doc, id, 'status', st);
      setFlowField(session.doc, id, 'finalizedAt', st === 'final' ? new Date().toISOString() : null);
    }, LOCAL_ORIGIN);
    shell.toast(st === 'final'
      ? `“${b.name || 'Untitled'}” is Final — locked against edits.`
      : `“${b.name || 'Untitled'}” reopened as a Draft.`, 'suggest');
  }
  /** bizToggleGallery. */
  function toggleGallery(): void {
    const on = !screen.galleryOpen.value;
    screen.setGallery(on);
    // Hiding a pane with an × is a one-way door unless something names the way back.
    if (!on) shell.toast('Gallery hidden — ⊞ Gallery in the toolbar brings it back.', 'suggest');
  }
  /** detachFlow. */
  function detach(id: string): void {
    const b = ws.value.flows[id];
    if (!b || !b.anchor || !canEdit.value) return;
    if (refusedByLock(b)) return;
    setFlowField(session.doc, id, 'anchor', null);
    shell.toast(`"${b.name || 'Untitled'}" detached — now a standalone tabletop case.`);
  }
  /** jumpToChartNode: the chart row, in the chart view. */
  async function jumpToChartNode(chartId: string, nodeId: string): Promise<void> {
    const chart = ws.value.charts[chartId];
    if (!chart || !lint.value.tree(chart).byId.has(nodeId)) { shell.toast('The linked chart task no longer exists.', 'error'); return; }
    activeChartId.value = chartId;
    await navigateTo({ path: `/w/${session.workspaceId}`, query: { node: nodeId } });
  }

  // ---- modes and binds -----------------------------------------------------------------------------
  /** bizSetMode. */
  function setMode(mode: string): void {
    const b = active.value;
    if (!b || !canEdit.value || !(BIZ_MODES as readonly string[]).includes(mode) || b.mode === mode) return;
    if (mode === 'free') {
      // Offer to bake in what the chart is supplying, so the flow reads the same either side.
      const supplied = steps(b).filter((t) => !isSub(t)).filter((t) => {
        const eff = lint.value.stepRaci(b, t);
        return COLS.some((k) => eff[k].from === 'chart' && eff[k].letters);
      });
      const bake = supplied.length > 0 && confirm(
        `Switch "${b.name || 'this flow'}" to Free-Form?\n\n`
        + `${supplied.length} step${supplied.length === 1 ? ' is' : 's are'} currently taking RACI from the chart.\n\n`
        + 'OK — copy that RACI onto the steps, so the flow reads the same and every cell becomes editable.\n'
        + 'Cancel — leave each step with only the letters typed on it (inherited cells go blank).');
      session.doc.transact(() => {
        if (bake) {
          for (const t of supplied) {
            const eff = lint.value.stepRaci(b, t);
            for (const k of COLS) if (eff[k].from === 'chart' && eff[k].letters) setStepRaci(session.doc, t.id, k, eff[k].letters);
          }
        }
        // The binds themselves are KEPT: switching back restores the flow exactly.
        setFlowField(session.doc, b.id, 'mode', 'free');
      }, LOCAL_ORIGIN);
    } else {
      if (!linkable.value.length) {
        shell.toast('Chart-Linked needs an organization chart to draw rows from — this workspace has none (free-form charts have no organizational columns to link).', 'error');
        return;
      }
      const src = sourceChart(b);
      session.doc.transact(() => {
        setFlowField(session.doc, b.id, 'mode', 'linked');
        if (src) setFlowField(session.doc, b.id, 'sourceChartId', src.id);
      }, LOCAL_ORIGIN);
    }
    const unbound = mode === 'linked' ? steps(b).filter((t) => !isSub(t) && !t.bind).length : 0;
    const M = BIZ_MODE_META[mode as BizMode];
    shell.toast(unbound
      ? `Chart-Linked — ${unbound} step${unbound === 1 ? '' : 's'} still need${unbound === 1 ? 's' : ''} a chart row. Click ⛓ on a card to pick one.`
      : `${M.name} — ${M.blurb}`, unbound ? 'suggest' : TOAST_OK);
  }
  /** bizSetSourceChart. */
  function setSourceChart(chartId: string): void {
    const b = active.value, c = ws.value.charts[chartId];
    if (!b || !c || isFreeChart(c) || !canEdit.value) return;
    setFlowField(session.doc, b.id, 'sourceChartId', c.id);
  }
  /** bizBindStep. */
  function bindStep(taskId: string, chartId: string, nodeId: string): void {
    const b = active.value, t = stepOf(taskId);
    if (!b || !t || isSub(t) || !canEdit.value) return;
    const chart = ws.value.charts[chartId];
    if (!chart) { shell.toast('That chart is no longer in this workspace.', 'error'); return; }
    if (isFreeChart(chart)) {
      shell.toast(`"${chart.title || 'That chart'}" is free-form — its party columns are its own, with no organizational meaning to carry onto a flow step. Link to an organization chart instead.`, 'error');
      return;
    }
    if (!lint.value.tree(chart).byId.has(nodeId)) { shell.toast('That chart row is no longer available.', 'error'); return; }
    if (refusedByLock(b)) return;
    // Letters already on the step stay its own — as overrides, one per column, each of which can be
    // handed back to the chart. Linking must never quietly discard work already on the card.
    const own = COLS.filter((k) => normalizeRaci(t.raci[k] ?? ''));
    session.doc.transact(() => {
      setStepField(session.doc, t.id, 'bind', { chartId, nodeId });
      setStepOverrides(session.doc, t.id, [...t.bindOverrides, ...own]);
      if (!b.sourceChartId) setFlowField(session.doc, b.id, 'sourceChartId', chartId);
    }, LOCAL_ORIGIN);
    const info = bindInfo(stepOf(taskId));
    const where = `${info ? info.tierLabel.toLowerCase() : 'chart'} row "${info?.node.name || 'untitled'}"`;
    shell.toast(own.length
      ? `Linked to ${where} — ${own.length} column${own.length === 1 ? '' : 's'} already on this step kept as override${own.length === 1 ? '' : 's'}.`
      : `Linked to ${where} — this step now follows its RACI.`);
  }
  /** bizUnbindStep: bake the row's letters in first, so unlinking loses nothing. */
  function unbindStep(taskId: string): void {
    const b = active.value, t = stepOf(taskId);
    if (!b || !t || !t.bind || !canEdit.value) return;
    if (refusedByLock(b)) return;
    const eff = lint.value.stepRaci(b, t);
    session.doc.transact(() => {
      for (const k of COLS) if (eff[k].from === 'chart') setStepRaci(session.doc, t.id, k, eff[k].letters);
      setStepField(session.doc, t.id, 'bind', null);
      setStepOverrides(session.doc, t.id, []);
    }, LOCAL_ORIGIN);
    shell.toast('Unlinked — the row\'s RACI was copied onto the step, so nothing was lost. It is the step\'s own now.', 'suggest');
  }
  /** bizBindNextUnbound: centre the first step with no row yet, and open its picker. */
  function bindNextUnbound(): void {
    const b = active.value;
    const t = b ? steps(b).find((x) => !isSub(x) && !x.bind) : undefined;
    if (!t) return;
    screen.canvas.centreTask(t.id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-bz-bind="${t.id}"]`);
      if (el) screen.popover.value = { kind: 'bind', taskId: t.id, anchor: el.getBoundingClientRect() };
    });
  }

  // ---- a step's cells ------------------------------------------------------------------------------
  /**
   * bizClaimCol, as a plan: editing a column the chart is supplying CLAIMS it — the letters it was
   * showing are copied onto the step first, so the edit acts on what the person can see.
   */
  function claimPlan(b: Flow, t: FlowStep, col: string): { claimed: boolean; letters: string; overrides: string[] } {
    const overrides = [...t.bindOverrides];
    if (isLinked(b) && t.bind && !overrides.includes(col)) {
      const supplied = lint.value.stepRaci(b, t)[col as ColKey];
      if (supplied?.from === 'chart') return { claimed: true, letters: supplied.letters, overrides: [...overrides, col] };
    }
    return { claimed: false, letters: normalizeRaci(t.raci[col] ?? ''), overrides };
  }
  /** bizToggleRaci. */
  function toggleRaci(taskId: string, col: string, letter: string): void {
    const b = active.value, t = stepOf(taskId);
    if (!b || !t || !canEdit.value) return;
    const F = framework(b.framework);
    const plan = claimPlan(b, t, col);
    const cur = plan.letters;
    const adding = !cur.includes(letter);
    // One owner per task, measured against what the step EFFECTIVELY says.
    if (letter === F.owner && adding) {
      const eff = lint.value.stepRaci(b, t);
      const otherA = COLS.find((k) => k !== col && eff[k].letters.includes(F.owner));
      if (otherA) {
        shell.toast(`Only one ${F.meta[F.owner]?.label} per task — ${colLabel(otherA)} already holds the ${F.owner}${eff[otherA].from === 'chart' ? ' (from the linked chart row)' : ''}. Clear it first.`, 'error');
        return;
      }
    }
    if (refusedByLock(b)) return;
    const next = normalizeRaci(adding ? cur + letter : cur.replace(letter, ''));
    session.doc.transact(() => {
      if (plan.claimed) setStepOverrides(session.doc, t.id, plan.overrides);
      setStepRaci(session.doc, t.id, col, next);
    }, LOCAL_ORIGIN);
  }
  /** bizClearRaci: "no role here" is itself an override when a chart row says otherwise. */
  function clearRaci(taskId: string, col: string): void {
    const b = active.value, t = stepOf(taskId);
    if (!b || !t || !canEdit.value) return;
    if (refusedByLock(b)) return;
    const plan = claimPlan(b, t, col);
    session.doc.transact(() => {
      if (plan.claimed) setStepOverrides(session.doc, t.id, plan.overrides);
      setStepRaci(session.doc, t.id, col, '');
    }, LOCAL_ORIGIN);
  }
  /** bizReleaseCol: give an overridden column back to the chart row. */
  function releaseCol(taskId: string, col: string): void {
    const b = active.value, t = stepOf(taskId);
    if (!b || !t || !canEdit.value) return;
    if (refusedByLock(b)) return;
    session.doc.transact(() => {
      setStepOverrides(session.doc, t.id, t.bindOverrides.filter((k) => k !== col));
      setStepRaci(session.doc, t.id, col, '');
    }, LOCAL_ORIGIN);
  }
  /** bizPartyAssign / bizPartyClear's write. */
  function setParty(taskId: string, col: string, ref: OrgRef | null): void {
    setStepParty(session.doc, taskId, col, ref);
  }
  // ---- handoffs ------------------------------------------------------------------------------------
  /** A handoff's condition — the flow table's input and the edge popover's. */
  function setEdgeLabel(f: Flow, edgeId: string, label: string): void {
    const e = f.edges[edgeId];
    if (!e || !canEdit.value || e.label === label) return;
    if (refusedByLock(f)) return;
    setEdgeField(session.doc, edgeId, 'label', label);
  }
  /** The edge popover's deliverable list: add one (the id, or '__new' to name a new one) or drop one. */
  function addEdgeDeliverable(f: Flow, edgeId: string, artifactId: string): void {
    const e = f.edges[edgeId];
    if (!e || !canEdit.value || e.artifactIds.includes(artifactId)) return;
    if (refusedByLock(f)) return;
    setEdgeField(session.doc, edgeId, 'artifactIds', [...e.artifactIds, artifactId]);
  }
  function dropEdgeDeliverable(f: Flow, edgeId: string, artifactId: string): void {
    const e = f.edges[edgeId];
    if (!e || !canEdit.value) return;
    if (refusedByLock(f)) return;
    setEdgeField(session.doc, edgeId, 'artifactIds', e.artifactIds.filter((x) => x !== artifactId));
  }
  function removeEdge(f: Flow, edgeId: string): void {
    if (!f.edges[edgeId] || !canEdit.value) return;
    if (refusedByLock(f)) return;
    deleteEdge(session.doc, edgeId);
  }
  /** "＋ new deliverable…": the one already called that, or a new one in the registry. */
  function deliverableNamed(name: string): string | null {
    if (!canEdit.value) return null;
    const existing = artifactsInOrder(ws.value).find((a) => a.name.trim().toLowerCase() === name.toLowerCase());
    return existing ? existing.id : addArtifact(session.doc, name);
  }

  return {
    ws, flows, active, lint, canEdit, screen,
    colLabel, colShort, orgLabel, partyLabel,
    steps, edges, isSub, taskLabel, flowName, hostsOf, wouldCycle, stepOf, locate,
    isFreeChart, linkable, isLinked, anchorInfo, sourceChart, bindInfo, defaultParty,
    refusedByLock, closeParty, addCase, renameCase, deleteCase, duplicateCase, setStatus, toggleGallery,
    detach, jumpToChartNode, setMode, setSourceChart, bindStep, unbindStep, bindNextUnbound,
    toggleRaci, clearRaci, releaseCol, setParty,
    setEdgeLabel, addEdgeDeliverable, dropEdgeDeliverable, removeEdge, deliverableNamed,
  };
}
