/**
 * How the flow canvas reads the document — index.html's bizcase helpers (isSubflow, subflowPorts,
 * bizGroupBoundary, bizTaskIO, bizBindCtx, bizAnchorCtx, bizStepChips, partyHierarchy…) and the
 * card builders behind bizNodeHtml, bizSubflowHtml and bizGroupHtml, ported one for one.
 *
 * Pure functions over a workspace snapshot, so every card says exactly what the source's template
 * string says: the same words, the same tooltips, the same states. The canvas component
 * (components/flow/canvas/Surface.vue) turns these view models into the source's elements and
 * adds what belongs to one person's screen — selection, the drag in flight, the flash.
 *
 * In a subfolder of composables/ on purpose: Nuxt auto-imports every export of a top-level
 * composables file into the whole app, and names like `isSubflow` would collide.
 */

import {
  ACTOR_LABELS_DEFAULT,
  chartTierLabel,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  COLS,
  columnDirectorate,
  edgesInOrder,
  framework,
  groupsInOrder,
  normalizeRaci,
  stepBindOverrides,
  stepLabel,
  stepsInOrder,
  subflowRefId,
  translateLetters,
  type Actor,
  type Chart,
  type ChartNode,
  type ColKey,
  type Flow,
  type FlowEdge,
  type FlowGroup,
  type FlowStep,
  type FlowViolationRecord,
  type Framework,
  type LintContext,
  type OrgRef,
  type StepRaci,
  type Workspace,
} from '@raci/core';
import { legacyOrgLabel } from '~/composables/useOrgLabel';

// ---- constants (index.html's BZ_*) ------------------------------------------------------------------

/** The fixed card width — keeps socket geometry predictable. */
export const BZ_NODE_W = 220;
export const BZ_ZOOM_MIN = 0.4;
export const BZ_ZOOM_MAX = 2.5;
/** Room a frame leaves around its members. */
export const BZ_GROUP_PAD = 18;
/** The frame colours, in the order ◧ cycles them. */
export const BZ_GROUP_COLORS = ['accent', 'p', 'c', 'a', 'd', 's', 'i'] as const;
/** index.html's ACCENT: the noodle colour when the theme gives none. */
export const ACCENT = '#51cf66';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
/** The key that lets a step leave its frame while it is dragged (BZ_DETACH_KEY / _LONG). */
export const BZ_DETACH_KEY = IS_MAC ? '⌥' : 'Alt';
export const BZ_DETACH_KEY_LONG = IS_MAC ? '⌥ Option' : 'Alt';

/** Flows are RACI, full stop (v0.34). */
export const FLOW_FW: Framework = framework('raci');

// ---- the source's small vocabulary ------------------------------------------------------------------

/** index.html's COL_LABELS / COL_SHORT / ACTOR_LABELS: the workspace's own word, else the default. */
export interface Vocab {
  /** `COL_LABELS[k]` — undefined for anything that is not an org column, as the source's lookup is. */
  colLabel(k: string): string | undefined;
  colShort(k: string): string | undefined;
  actorLabel(a: string): string;
}

const isCol = (k: string): k is ColKey => (COLS as readonly string[]).includes(k);

export function vocabOf(ws: Workspace): Vocab {
  return {
    colLabel: (k) => (isCol(k) ? ws.columnLabels[k] || COL_LABELS_DEFAULT[k] : undefined),
    colShort: (k) => (isCol(k) ? ws.columnShort[k] || COL_SHORT_DEFAULT[k] : undefined),
    actorLabel: (a) => ws.actorLabels[a] || ACTOR_LABELS_DEFAULT[a as Actor] || a,
  };
}

/** index.html's escapeHtml, for the one layer the canvas writes as markup: the handoff SVG. */
export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** index.html's copyName: "Copy of X", "Copy of X (2)", … — never a name already taken. */
export function copyName(base: string, taken: readonly string[]): string {
  const want = /^Copy of /.test(base) ? base : `Copy of ${base || 'Untitled'}`;
  if (!taken.includes(want)) return want;
  for (let i = 2; ; i++) if (!taken.includes(`${want} (${i})`)) return `${want} (${i})`;
}

// ---- structure ----------------------------------------------------------------------------------------

export const isSubflow = (t: FlowStep | null | undefined): t is FlowStep & { kind: 'subflow' } => !!t && t.kind === 'subflow';
/** b.tasks / b.edges / b.groups — in the order they were made, which is the order they paint in. */
export const stepsOf = (f: Flow): FlowStep[] => stepsInOrder(f);
export const edgesOf = (f: Flow): FlowEdge[] => edgesInOrder(f);
export const groupsOf = (f: Flow): FlowGroup[] => groupsInOrder(f);
export const groupMembers = (f: Flow, gid: string): FlowStep[] => stepsOf(f).filter((t) => t.groupId === gid);

/** bizEdgeKey: two handoffs between one pair of boxes are distinct when their mating points are. */
export const edgeKey = (e: Pick<FlowEdge, 'from' | 'to' | 'fromPort' | 'toPort'>): string =>
  `${e.from}:${e.fromPort || ''}>${e.to}:${e.toPort || ''}`;

/** bizTaskLabel: the name a box carries everywhere; a nested box falls back to its flow's name. */
export const taskLabel = (ws: Workspace, f: Flow, t: FlowStep | null | undefined): string =>
  t ? stepLabel(ws, f, t) : '—';

/** bizHiddenTaskIds: the members of collapsed frames, which are not drawn at all. */
export function hiddenTaskIds(f: Flow): Set<string> {
  const hidden = new Set<string>();
  for (const g of groupsOf(f)) if (g.collapsed) for (const t of groupMembers(f, g.id)) hidden.add(t.id);
  return hidden;
}

/** bizGroupBoundary: the members still talking to something outside — a collapsed frame's sockets. */
export function groupBoundary(ws: Workspace, f: Flow, gid: string): { in: PortRef[]; out: PortRef[] } {
  const mem = new Set(groupMembers(f, gid).map((t) => t.id));
  const ins: string[] = [];
  const outs: string[] = [];
  for (const e of edgesOf(f)) {
    if (mem.has(e.to) && !mem.has(e.from) && !ins.includes(e.to)) ins.push(e.to);
    if (mem.has(e.from) && !mem.has(e.to) && !outs.includes(e.from)) outs.push(e.from);
  }
  const lbl = (id: string) => taskLabel(ws, f, f.steps[id]);
  return { in: ins.map((id) => ({ id, name: lbl(id) })), out: outs.map((id) => ({ id, name: lbl(id) })) };
}
export interface PortRef { readonly id: string; readonly name: string }

/** bizTaskIO: what a step consumes and produces, read off its handoffs. */
export function taskIO(f: Flow, taskId: string): { inputs: string[]; outputs: string[] } {
  const inp = new Set<string>();
  const out = new Set<string>();
  for (const e of edgesOf(f)) {
    for (const aid of e.artifactIds) {
      if (e.to === taskId) inp.add(aid);
      if (e.from === taskId) out.add(aid);
    }
  }
  return { inputs: [...inp], outputs: [...out] };
}

/** artifactLabel. */
export function artifactLabel(ws: Workspace, id: string): string {
  const a = ws.artifacts[id];
  return a ? a.name || 'Untitled deliverable' : '(missing deliverable)';
}

// ---- nested flows ----------------------------------------------------------------------------------

/** The flow a nested box points at, or null — a box pointing at its own flow points at nothing. */
export function refFlow(ws: Workspace, host: Flow, t: FlowStep): Flow | null {
  if (!isSubflow(t)) return null;
  const id = subflowRefId(host, t);
  return (id && Object.hasOwn(ws.flows, id) && ws.flows[id]) || null;
}

/** bizEntryPoints / bizExitPoints: steps nothing hands to / that hand to nothing — else every step. */
export function entryPoints(ref: Flow): FlowStep[] {
  const hasIn = new Set(edgesOf(ref).map((e) => e.to));
  const ends = stepsOf(ref).filter((t) => !hasIn.has(t.id));
  return ends.length ? ends : stepsOf(ref);
}
export function exitPoints(ref: Flow): FlowStep[] {
  const hasOut = new Set(edgesOf(ref).map((e) => e.from));
  const ends = stepsOf(ref).filter((t) => !hasOut.has(t.id));
  return ends.length ? ends : stepsOf(ref);
}

export interface Port { readonly id: string; readonly name: string; readonly on: boolean }

/** subflowPorts: every entry/exit of the referenced flow, flagged with whether this box exposes it. */
export function subflowPorts(ws: Workspace, host: Flow, t: FlowStep): { ref: Flow | null; in: Port[]; out: Port[] } {
  const ref = refFlow(ws, host, t);
  if (!ref) return { ref: null, in: [], out: [] };
  const side = (list: FlowStep[], sel: readonly string[]): Port[] => {
    const chosen = new Set(sel);
    const live = list.filter((x) => chosen.has(x.id));
    const on = live.length ? new Set(live.map((x) => x.id)) : new Set(list.map((x) => x.id));
    return list.map((x) => ({ id: x.id, name: x.name || '(untitled step)', on: on.has(x.id) }));
  };
  return { ref, in: side(entryPoints(ref), t.ports.in), out: side(exitPoints(ref), t.ports.out) };
}
export function subflowOpenPorts(ws: Workspace, host: Flow, t: FlowStep, side: 'in' | 'out'): Port[] {
  return subflowPorts(ws, host, t)[side].filter((p) => p.on);
}

// ---- the chart behind a flow (bizAnchorCtx, bizBindCtx) --------------------------------------------

function ancestorsOf(lc: LintContext, chart: Chart, nodeId: string): ChartNode[] {
  const out: ChartNode[] = [];
  for (let row = lc.tree(chart).byId.get(nodeId)?.parent ?? null; row; row = row.parent) out.unshift(row.node);
  return out;
}

/** bizAnchorCtx: the cascade an anchored flow's steps sit under. */
export interface AnchorInfo {
  readonly chart: Chart;
  readonly node: ChartNode;
  readonly ownerCol: string | null;
  /** The anchor row's and its ancestors' roster refs, shallow → deep. */
  readonly orgRefs: readonly OrgRef[];
}
export function anchorInfo(lc: LintContext, f: Flow): AnchorInfo | null {
  const a = lc.anchor(f);
  if (!a) return null;
  const chain = [...ancestorsOf(lc, a.chart, a.node.id), a.node];
  return { chart: a.chart, node: a.node, ownerCol: a.ownerColumn, orgRefs: chain.map((n) => n.org).filter((r): r is OrgRef => !!r) };
}

/** bizBindCtx: everything a Chart-Linked step takes from the row it implements. */
export interface BindInfo {
  readonly chart: Chart;
  readonly node: ChartNode;
  readonly F: Framework;
  readonly raci: Readonly<Record<ColKey, string>>;
  readonly tierLabel: string;
  readonly crumb: readonly string[];
  readonly orgRefs: readonly OrgRef[];
}
export function bindInfo(lc: LintContext, t: FlowStep): BindInfo | null {
  const b = lc.bind(t);
  if (!b) return null;
  const anc = ancestorsOf(lc, b.chart, b.node.id);
  return {
    chart: b.chart,
    node: b.node,
    F: b.framework,
    raci: b.raci,
    tierLabel: chartTierLabel(b.chart, anc.length),
    crumb: [b.chart.title || 'Untitled chart', ...anc.map((n) => n.name || '(untitled)'), b.node.name || '(untitled)'],
    orgRefs: [...anc, b.node].map((n) => n.org).filter((r): r is OrgRef => !!r),
  };
}

/** bizDefaultPartyFor: a column's directorate, narrowed by the deepest ref inside it. */
export function defaultPartyFor(ws: Workspace, ctx: { orgRefs: readonly OrgRef[] } | null, col: string): OrgRef | null {
  if (!ctx) return null;
  const a = columnDirectorate(ws, col);
  if (!a) return null;
  let ref: OrgRef = { actor: a };
  for (const r of ctx.orgRefs) if ('actor' in r && r.actor === a) ref = { ...r };
  return ref;
}

/** The per-render context the source keeps in _bizAnchorCtx and friends. */
export interface FlowCtx {
  readonly ws: Workspace;
  readonly flow: Flow;
  readonly lc: LintContext;
  readonly vocab: Vocab;
  readonly linked: boolean;
  readonly anchor: AnchorInfo | null;
  /** bizBindCtx per step, resolved once per render. */
  bind(t: FlowStep): BindInfo | null;
  /** The flow's source chart when it is one a step can be bound to (bizSourceChart's first answer). */
  readonly sourceChartId: string | null;
}

export function flowCtx(ws: Workspace, flow: Flow, lc: LintContext): FlowCtx {
  const binds = new Map<string, BindInfo | null>();
  const src = flow.sourceChartId ? ws.charts[flow.sourceChartId] : undefined;
  return {
    ws,
    flow,
    lc,
    vocab: vocabOf(ws),
    linked: flow.mode === 'linked',
    anchor: anchorInfo(lc, flow),
    bind(t) {
      if (!binds.has(t.id)) binds.set(t.id, bindInfo(lc, t));
      return binds.get(t.id)!;
    },
    sourceChartId: src && !src.custom ? src.id : null,
  };
}

/** bizDefaultPartyForTask: a bound step resolves against its row, anything else against the anchor. */
export function defaultPartyForTask(ctx: FlowCtx, t: FlowStep, col: string): OrgRef | null {
  const bind = ctx.linked ? ctx.bind(t) : null;
  return defaultPartyFor(ctx.ws, bind ?? ctx.anchor, col);
}

// ---- parties ----------------------------------------------------------------------------------------

/** partyLabel: like orgLabel, but a directorate-only ref resolves to the directorate's name. */
export function partyLabel(ctx: FlowCtx, ref: OrgRef | null | undefined): { short: string; full: string } | null {
  if (!ref) return null;
  if ('entityId' in ref) return legacyOrgLabel(ctx.ws, ctx.vocab.actorLabel, ref);
  if (!(ref.actor in ACTOR_LABELS_DEFAULT)) return null;
  if (ref.divisionId) return legacyOrgLabel(ctx.ws, ctx.vocab.actorLabel, ref);
  const name = ctx.vocab.actorLabel(ref.actor);
  return { short: name, full: name };
}

export interface PartyLevel { readonly kind: 'dir' | 'div' | 'branch' | 'team' | 'entity'; readonly name: string }

/** partyHierarchy: a valid ref broken into its levels, as deep as it goes; null when it dangles. */
export function partyHierarchy(ctx: FlowCtx, ref: OrgRef | null | undefined): PartyLevel[] | null {
  if (!ref || !partyLabel(ctx, ref)) return null;
  if ('entityId' in ref) {
    const e = ctx.ws.entities[ref.entityId];
    return [{ kind: 'entity', name: e ? (e.name && e.name.trim()) || 'Untitled entity' : '(missing entity)' }];
  }
  const out: PartyLevel[] = [{ kind: 'dir', name: ctx.vocab.actorLabel(ref.actor) }];
  if (ref.divisionId) {
    const d = ctx.ws.roster[ref.actor]?.divisions.find((x) => x.id === ref.divisionId);
    out.push({ kind: 'div', name: d?.name || 'Untitled division' });
    if (ref.branchId) {
      const b = d?.branches.find((x) => x.id === ref.branchId);
      out.push({ kind: 'branch', name: b?.name || 'Untitled branch' });
      if (ref.teamId) {
        const tm = b?.teams.find((x) => x.id === ref.teamId);
        out.push({ kind: 'team', name: tm?.name || 'Unnamed team' });
      }
    }
  }
  return out;
}

// ---- the card view models --------------------------------------------------------------------------

/** One chip: `raci-chip <cls>`, its text, and its tooltip when it has one. */
export interface ChipVM { readonly cls: string; readonly text: string; readonly title?: string }

/** bizStepChips: explicit letters, what the linked row supplies, and the dashed inherited owner. */
export function stepChips(ctx: FlowCtx, t: FlowStep, col: ColKey, eff: StepRaci): ChipVM[] {
  const F = FLOW_FW;
  const cell = eff[col];
  const bind = ctx.linked ? ctx.bind(t) : null;
  const an = ctx.anchor;
  const label = (l: string) => (F.meta[l] ? F.meta[l]!.label : l);
  const chips: ChipVM[] = [];
  if (cell.from === 'chart') {
    for (const l of cell.letters.split('').filter(Boolean)) {
      chips.push({ cls: `${l} from-chart`, text: l,
        title: `${label(l)} — from the linked ${bind!.tierLabel.toLowerCase()} row “${bind!.node.name || 'untitled'}” (${ctx.vocab.colLabel(col)})` });
    }
  } else {
    const overridden = !!bind && stepBindOverrides(t).includes(col);
    const chartSays = overridden ? translateLetters(bind!.raci[col], bind!.F, F) : '';
    const says = chartSays ? `the row says ${chartSays}` : 'the row assigns nothing here';
    for (const l of cell.letters.split('').filter(Boolean)) {
      const cascadeOver = !overridden && !!(an && an.ownerCol && l === F.owner && col !== an.ownerCol);
      const tip = overridden
        ? `${label(l)} — set on this step, overriding the linked chart row (${says})`
        : cascadeOver
          ? `${F.meta[F.owner]!.label} set here, but the chart cascade puts ownership on ${ctx.vocab.colLabel(an!.ownerCol!)} — branch override`
          : '';
      chips.push({ cls: `${l}${overridden || cascadeOver ? ' override' : ''}`, text: l, ...(tip ? { title: tip } : {}) });
    }
    // A column deliberately overridden to nothing still has to SAY so.
    if (overridden && !cell.letters && chartSays) {
      chips.push({ cls: 'none override', text: '⊘', title: `No role here on this step — overriding the linked chart row, where ${says}` });
    }
  }
  if (an && an.ownerCol === col && !COLS.some((k) => eff[k].letters.includes(F.owner))) {
    chips.push({ cls: `${F.owner} inherited`, text: F.owner,
      title: `${F.meta[F.owner]!.label} — inherited from the chart cascade (${ctx.vocab.colLabel(col)})` });
  }
  return chips;
}

export interface PinVM { readonly warn: boolean; readonly title: string }
export function pinOf(vio: FlowViolationRecord | undefined): PinVM | null {
  return vio ? { warn: vio.severity !== 'err', title: vio.issues.map((i) => i.message).join('\n') } : null;
}

export interface CellVM {
  readonly col: ColKey;
  readonly linked: boolean;
  readonly title: string;
  readonly short: string;
  readonly chips: ChipVM[];
}

export type BindBarVM =
  | { readonly state: 'unset' }
  | { readonly state: 'broken' }
  | { readonly state: 'linked'; readonly foreign: boolean; readonly title: string; readonly tier: string; readonly name: string; readonly over: number };

export interface PartyRowVM {
  readonly col: ColKey;
  readonly unset: boolean;
  readonly inherited: boolean;
  readonly title: string;
  readonly short: string;
  readonly letters: string[];
  readonly hier: PartyLevel[] | null;
}

export interface StepCardVM {
  readonly kind: 'step';
  readonly id: string;
  readonly decision: boolean;
  readonly outCount: number;
  readonly pin: PinVM | null;
  readonly name: string;
  readonly bind: BindBarVM | null;
  readonly description: string;
  readonly entry: string;
  readonly exit: string;
  readonly cells: CellVM[];
  readonly inputs: string | null;
  readonly outputs: string | null;
  readonly parties: PartyRowVM[];
}

/** bizBindBarHtml: which chart row a Chart-Linked step implements — only ever in that mode. */
function bindBar(ctx: FlowCtx, t: FlowStep): BindBarVM | null {
  if (!ctx.linked || isSubflow(t)) return null;
  if (!t.bind) return { state: 'unset' };
  const b = ctx.bind(t);
  if (!b) return { state: 'broken' };
  const foreign = !!ctx.sourceChartId && b.chart.id !== ctx.sourceChartId;
  const nOver = stepBindOverrides(t).length;
  const title = `${b.crumb.join(' › ')}\n${b.tierLabel} row — this step takes its RACI from here.`
    + (nOver ? `\n${nOver} column${nOver === 1 ? '' : 's'} overridden on this step.` : '')
    + (foreign ? '\nFrom a different chart than this flow’s source.' : '')
    + '\nClick to re-point.';
  return { state: 'linked', foreign, title, tier: b.tierLabel, name: b.node.name || '(untitled row)', over: nOver };
}

/** bizNodeHtml, for a plain step. */
export function stepCard(ctx: FlowCtx, t: FlowStep, vio: FlowViolationRecord | undefined): StepCardVM {
  const { vocab } = ctx;
  const eff = ctx.lc.stepRaci(ctx.flow, t);
  const cells = COLS.map((k) => ({
    col: k,
    linked: eff[k].from === 'chart',
    title: vocab.colLabel(k)!,
    short: vocab.colShort(k)!,
    chips: stepChips(ctx, t, k, eff),
  }));
  const io = taskIO(ctx.flow, t.id);
  const names = (ids: string[]) => ids.map((aid) => artifactLabel(ctx.ws, aid)).join(', ');
  const outCount = edgesOf(ctx.flow).reduce((n, e) => n + (e.from === t.id ? 1 : 0), 0);
  const parties: PartyRowVM[] = COLS.filter((k) => eff[k].letters).map((k) => {
    const letters = eff[k].letters;
    const ref = Object.hasOwn(t.parties, k) ? t.parties[k] : undefined;
    let hier = ref ? partyHierarchy(ctx, ref) : null;
    let lbl = ref ? partyLabel(ctx, ref) : null;
    let inherited = false;
    if (!hier) {
      const def = defaultPartyForTask(ctx, t, k);
      const defHier = def ? partyHierarchy(ctx, def) : null;
      if (defHier) { hier = defHier; lbl = partyLabel(ctx, def); inherited = true; }
    }
    const tip = !hier ? `${vocab.colLabel(k)} (${letters}) — set responsible party`
      : inherited ? `${vocab.colLabel(k)} (${letters}) — ${lbl!.full} (default from the chart context — click to assign explicitly)`
      : `${vocab.colLabel(k)} (${letters}) — ${lbl!.full}`;
    return {
      col: k,
      unset: !hier,
      inherited,
      title: `${tip} (click to change)`,
      short: vocab.colShort(k)!,
      letters: normalizeRaci(letters).split('').filter(Boolean),
      hier,
    };
  });
  return {
    kind: 'step',
    id: t.id,
    decision: outCount >= 2,
    outCount,
    pin: pinOf(vio),
    name: t.name,
    bind: bindBar(ctx, t),
    description: t.description || '',
    entry: t.entry || '',
    exit: t.exit || '',
    cells,
    inputs: io.inputs.length ? `⇥ ${names(io.inputs)}` : null,
    outputs: io.outputs.length ? `↦ ${names(io.outputs)}` : null,
    parties,
  };
}

export interface PortRowVM {
  readonly id: string;
  readonly name: string;
  readonly on: boolean;
  readonly sockTitle: string;
  readonly tglTitle: string;
}
export interface RollupVM { readonly col: ColKey; readonly title: string; readonly short: string; readonly letters: string[] }

export interface NestedCardVM {
  readonly kind: 'subflow';
  readonly id: string;
  readonly broken: boolean;
  readonly pin: PinVM | null;
  readonly name: string;
  /** What an unnamed box shows in its name slot: the referenced flow's name. */
  readonly placeholder: string;
  readonly refName: string;
  readonly openTitle: string;
  readonly refMeta: string;
  readonly description: string;
  readonly ins: PortRowVM[];
  readonly outs: PortRowVM[];
  readonly openIn: number;
  readonly openOut: number;
  readonly rollup: RollupVM[];
}

/** bizSubflowHtml: a box standing in for a whole other flow, with one mating point per entry/exit. */
export function nestedCard(ctx: FlowCtx, t: FlowStep, vio: FlowViolationRecord | undefined): NestedCardVM {
  const P = subflowPorts(ctx.ws, ctx.flow, t);
  const base = { kind: 'subflow' as const, id: t.id, pin: pinOf(vio), name: t.name, description: t.description || '' };
  if (!P.ref) {
    return { ...base, broken: true, placeholder: 'Nested flow', refName: '', openTitle: '', refMeta: '',
      ins: [], outs: [], openIn: 0, openOut: 0, rollup: [] };
  }
  const ref = P.ref;
  const row = (p: Port, side: 'in' | 'out'): PortRowVM => ({
    id: p.id,
    name: p.name,
    on: p.on,
    sockTitle: `${side === 'in' ? 'Entry' : 'Exit'} — ${p.name}${side === 'out' ? ' · drag onto another box to connect' : ''}`,
    tglTitle: p.on
      ? `Hide this ${side === 'in' ? 'entry' : 'exit'} point — it stops being a mating point on this box`
      : `Expose "${p.name}" as a mating point on this box`,
  });
  const refSteps = stepsOf(ref);
  const rollup = COLS.map((k) => ({
    col: k,
    title: ctx.vocab.colLabel(k)!,
    short: ctx.vocab.colShort(k)!,
    letters: [...new Set(refSteps.flatMap((x) => normalizeRaci(Object.hasOwn(x.raci, k) ? x.raci[k] : '').split('')))].filter(Boolean),
  })).filter((r) => r.letters.length);
  const nSteps = refSteps.filter((x) => !isSubflow(x)).length;
  const nNest = refSteps.filter(isSubflow).length;
  const nEdges = Object.keys(ref.edges).length;
  return {
    ...base,
    broken: false,
    placeholder: ref.name || 'Nested flow',
    refName: ref.name || 'Untitled',
    openTitle: `Open "${ref.name || 'Untitled'}" to edit it — every box that nests it follows the change`,
    refMeta: `${nSteps} step${nSteps === 1 ? '' : 's'}${nNest ? ` · ${nNest} nested` : ''} · ${nEdges} handoff${nEdges === 1 ? '' : 's'}`,
    ins: P.in.map((p) => row(p, 'in')),
    outs: P.out.map((p) => row(p, 'out')),
    openIn: P.in.filter((p) => p.on).length,
    openOut: P.out.filter((p) => p.on).length,
    rollup,
  };
}

export interface FrameVM {
  readonly id: string;
  readonly color: string;
  readonly collapsed: boolean;
  readonly name: string;
  readonly count: number;
  readonly ins: PortRef[];
  readonly outs: PortRef[];
}

/** bizGroupHtml's content: the frame, its member count and — collapsed — its boundary crossings. */
export function frameVM(ctx: FlowCtx, g: FlowGroup): FrameVM {
  const bd = g.collapsed ? groupBoundary(ctx.ws, ctx.flow, g.id) : { in: [], out: [] };
  return {
    id: g.id,
    color: g.color,
    collapsed: g.collapsed,
    name: g.name,
    count: groupMembers(ctx.flow, g.id).length,
    ins: bd.in,
    outs: bd.out,
  };
}
