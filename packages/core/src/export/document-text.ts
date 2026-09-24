/**
 * What index.html's document exports PRINT: the labels, the resolved responsibility lines and the
 * flow-step cells its PowerPoint deck is built from, ported so the rebuild prints the same words.
 *
 * WHY THIS DOES NOT REUSE THE REBUILD'S OWN SELECTORS
 * `orgLabel`, `displayRaci`, `stepIo` and `topologicalOrder` answer the same questions and are
 * right for the screens they serve, but each phrases the answer slightly differently from the
 * legacy exporter: `orgLabel` calls a deleted unit "(missing unit)" where the legacy prints nothing,
 * and leaves off the " · Chief: …" the legacy appends; `stepIo` sorts where the legacy keeps
 * handoff order; `topologicalOrder` breaks ties by id where the legacy keeps the order the steps
 * were drawn in. Each of those is a changed cell in a deck someone lays beside the one index.html
 * produced from the same file, so the document path uses these and the screens keep theirs.
 *
 * WHY SOME CHECKS HERE LOOK REDUNDANT
 * index.html only ever prints a workspace that has been through its loader, `migrateState`, which
 * normalizes things `importLegacy` deliberately keeps as the file had them: role letters are put in
 * canonical order, an org-chart row's roster ref has to reach at least a division, a flow anchor
 * that does not resolve is dropped, a free-form chart with no usable column is an org chart, a
 * duplicate or self-looping handoff is discarded, blank labels fall back to the defaults. The same
 * file has to print the same document in both apps, so those rules are applied here, where the
 * words are chosen, rather than assumed of whatever the document happens to hold.
 */

import {
  ACTOR_LABELS_DEFAULT,
  ACTORS,
  COLS,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  TIER_LABELS,
  entityKindMeta,
  framework,
  type Actor,
  type FlowMode,
  type Framework,
  type Status,
} from '../constants.js';
import { normalizeRaci } from '../raci.js';
import { ancestorsOf } from '../tree.js';
import type { Chart, ChartNode, Flow, FlowEdge, FlowStep, OrgRef, Workspace } from '../schema.js';

// ---- lifecycle and mode words ---------------------------------------------------------------------

/** index.html's `STATUS_META`, the two words it prints for a status. */
export const STATUS_TEXT: Readonly<
  Record<Status, { readonly name: string; readonly short: string }>
> = {
  draft: { name: 'Draft', short: 'DRAFT' },
  final: { name: 'Final', short: 'FINAL' },
};

/** index.html's `BIZ_MODE_META[mode].name`. */
export const FLOW_MODE_NAMES: Readonly<Record<FlowMode, string>> = {
  free: 'Free-Form',
  linked: 'Chart-Linked',
};

/**
 * How a signed date is written.
 *
 * index.html prints it with `toLocaleDateString()` — the reader's own browser locale and timezone.
 * Code running anywhere else has to be told which, or it prints its own: a server in UTC would put
 * a document signed on a Tuesday evening in New York on the Wednesday.
 */
export interface DateStyle {
  /** BCP 47 locale, e.g. `en-US`. Omitted: the runtime's default, exactly as the browser does. */
  readonly locale?: string;
  /** IANA zone, e.g. `America/New_York`. Omitted: the runtime's own. */
  readonly timeZone?: string;
}

/**
 * index.html's `finalizedOn`: the date a Final document was signed, or '' when there is none.
 *
 * Only a Final document has one. The legacy loader clears the stamp on anything that is not Final,
 * and the rebuild keeps whatever the file carried, so the status is checked here rather than the
 * stamp trusted. An unparseable stamp prints nothing rather than "Invalid Date".
 */
export function signedOn(
  o: { readonly status: Status; readonly finalizedAt: string | null },
  style: DateStyle = {},
): string {
  if (o.status !== 'final' || !o.finalizedAt) return '';
  const date = new Date(o.finalizedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(
    style.locale,
    style.timeZone ? { timeZone: style.timeZone } : undefined,
  );
}

/** True when a Final document carries a stamp at all — the legacy's `ac().finalizedAt` test. */
export function hasSignedStamp(o: {
  readonly status: Status;
  readonly finalizedAt: string | null;
}): boolean {
  return o.status === 'final' && !!o.finalizedAt;
}

// ---- charts -------------------------------------------------------------------------------------

/** Chart tabs in the order the tab strip shows them — one definition, in registry.ts. */
export { chartsInTabOrder } from '../registry.js';

export interface DocumentColumn {
  readonly key: string;
  readonly label: string;
  readonly short: string;
}

/**
 * A free-form chart's own columns and level names, as the legacy loader keeps them — or null for
 * an organization chart.
 *
 * `normalizeChartCustom` in index.html drops a column with no key or a repeated key, trims labels
 * and names a blank one "Party", caps the level names at 64, and treats a chart left with no
 * column at all as an ORG chart. All four change what a document prints.
 */
export function freeFormShape(
  chart: Pick<Chart, 'custom'>,
): { readonly cols: DocumentColumn[]; readonly tiers: string[] } | null {
  if (!chart.custom) return null;
  const seen = new Set<string>();
  const cols: DocumentColumn[] = [];
  for (const col of chart.custom.cols) {
    if (!col.key || seen.has(col.key)) continue;
    seen.add(col.key);
    cols.push({ key: col.key, label: col.label.trim() || 'Party', short: col.short.trim() });
  }
  if (cols.length === 0) return null;
  return { cols, tiers: chart.custom.tiers.slice(0, 64) };
}

/** The column keys a chart prints — `chartCols()`. */
export function documentColumns(chart: Pick<Chart, 'custom'>): readonly string[] {
  return freeFormShape(chart)?.cols.map((c) => c.key) ?? COLS;
}

/** A directorate's display name: the workspace's own, unless it is blank. */
export function actorLabel(ws: Workspace, actor: Actor): string {
  const own = ws.actorLabels[actor];
  return own && own.trim() ? own : ACTOR_LABELS_DEFAULT[actor];
}

/** An org column's header — `COL_LABELS[k]`: the workspace's own label unless it is blank. */
export function columnLabel(ws: Workspace, key: string): string {
  const own = ws.columnLabels[key];
  if (own && own.trim()) return own;
  return COL_LABELS_DEFAULT[key as keyof typeof COL_LABELS_DEFAULT] ?? key;
}

/** An org column's abbreviation — `COL_SHORT[k]`. */
export function columnShort(ws: Workspace, key: string): string {
  const own = ws.columnShort[key];
  if (own && own.trim()) return own;
  return COL_SHORT_DEFAULT[key as keyof typeof COL_SHORT_DEFAULT] ?? key;
}

/**
 * A level's name — `chartTierLabel`. Note the org fallback is "Level <depth>", not depth + 1: the
 * legacy's own arithmetic, unreachable for an org chart (it stops at Task) and kept for that reason.
 */
export function documentTierLabel(chart: Pick<Chart, 'custom'>, depth: number): string {
  const free = freeFormShape(chart);
  if (free) {
    const name = free.tiers[depth];
    return name && name.trim() ? name.trim() : `Level ${depth + 1}`;
  }
  return TIER_LABELS[depth] ?? `Level ${depth}`;
}

/**
 * A row's roster assignment as the legacy keeps it: only on an org chart, and only when it reaches
 * a division (or names an entity). An actor-only ref on a chart row is discarded by its loader.
 */
export function rowOrg(chart: Pick<Chart, 'custom'>, node: ChartNode): OrgRef | null {
  if (freeFormShape(chart) || !node.org) return null;
  if ('entityId' in node.org || node.org.divisionId) return node.org;
  return null;
}

// ---- org references -----------------------------------------------------------------------------

export interface OrgText {
  readonly short: string;
  readonly full: string;
}

const entityName = (name: string) => name.trim() || 'Untitled entity';

/**
 * index.html's `orgLabel`: a roster ref at division depth or deeper, or an entity.
 *
 * Returns null — prints nothing — for a directorate-only ref and for a unit that no longer exists;
 * a missing ENTITY still prints, as a sentence saying so.
 */
export function orgText(ws: Workspace, ref: OrgRef | null | undefined): OrgText | null {
  if (!ref) return null;
  if ('entityId' in ref) {
    const entity = ws.entities[ref.entityId];
    if (!entity) {
      return {
        short: '(missing entity)',
        full: 'This party named an entity that has since been deleted',
      };
    }
    const lead = entity.lead?.name ? ` · Lead: ${entity.lead.name}` : '';
    const name = entityName(entity.name);
    return { short: name, full: `${entityKindMeta(entity.kind).label}: ${name}${lead}` };
  }
  const actor = actorLabel(ws, ref.actor);
  const division = ref.divisionId
    ? ws.roster[ref.actor]?.divisions.find((d) => d.id === ref.divisionId)
    : undefined;
  const branch = ref.branchId ? division?.branches.find((b) => b.id === ref.branchId) : undefined;
  if (ref.teamId) {
    const team = branch?.teams.find((t) => t.id === ref.teamId);
    if (!team) return null;
    const lead = team.chief?.name ? ` · Lead: ${team.chief.name}` : '';
    const name = team.name || 'Unnamed team';
    return {
      short: name,
      full: `${actor} › ${division?.name || '—'} › ${branch?.name || '—'} › ${name}${lead}`,
    };
  }
  if (ref.branchId) {
    if (!branch) return null;
    const chief = branch.chief?.name ? ` · Chief: ${branch.chief.name}` : '';
    const name = branch.name || 'Untitled branch';
    return { short: name, full: `${actor} › ${division?.name || '—'} › ${name}${chief}` };
  }
  if (ref.divisionId) {
    if (!division) return null;
    const chief = division.chief?.name ? ` · Chief: ${division.chief.name}` : '';
    const name = division.name || 'Untitled division';
    return { short: name, full: `${actor} › ${name}${chief}` };
  }
  return null;
}

/** index.html's `partyLabel`: `orgText`, plus a directorate-only ref resolving to the directorate. */
export function partyText(ws: Workspace, ref: OrgRef | null | undefined): OrgText | null {
  if (!ref) return null;
  if ('entityId' in ref || ref.divisionId) return orgText(ws, ref);
  if (!(ACTORS as readonly string[]).includes(ref.actor)) return null;
  const label = actorLabel(ws, ref.actor);
  return { short: label, full: label };
}

/**
 * The directorate behind a responsibility column — `columnActorKey`.
 *
 * The rebuild's schema cannot hold the legacy's explicit `null` ("deliberately unmapped"), so a key
 * the workspace does not mention reads as the legacy's own default for it: a column that shares a
 * directorate's key maps to that directorate. That is exactly what index.html shows after opening
 * this workspace's own JSON export, whose missing keys its loader fills with those defaults.
 */
export function columnDirectorate(ws: Workspace, column: string): Actor | null {
  const mapped = Object.hasOwn(ws.columnActor, column) ? ws.columnActor[column] : column;
  return mapped && (ACTORS as readonly string[]).includes(mapped) ? (mapped as Actor) : null;
}

// ---- the chart's cascade, as the exports print it ----------------------------------------------

/**
 * The single doer column a row passes down as its children's owner — `primaryRColumn`.
 *
 * Reads the letters normalized, as the legacy's loader leaves every cell, and hard-codes R, as the
 * legacy does: both chart frameworks agree on it, and the export has to agree with them.
 */
export function cascadeColumn(node: ChartNode, columns: readonly string[]): string | null {
  const doers = columns.filter((k) => normalizeRaci(node.raci[k]).includes('R'));
  if (doers.length === 0) return null;
  if (doers.length === 1) return doers[0]!;
  return node.primaryR && doers.includes(node.primaryR) ? node.primaryR : null;
}

/** What a row hands its children — `cascadeDown`. */
export function passDown(
  node: ChartNode,
  inherited: string | null,
  columns: readonly string[],
): string | null {
  return cascadeColumn(node, columns) ?? inherited;
}

/**
 * A row's printed responsibility line — the legacy `effectiveRaci`: its own letters, the owner it
 * inherits on the column the cascade lands on when it names none of its own, and "I" in every
 * cell left empty, because a blank cell means Informed by convention.
 */
export function printedLine(
  node: ChartNode,
  inherited: string | null,
  columns: readonly string[],
): Record<string, string> {
  const ownsOne = columns.some((k) => normalizeRaci(node.raci[k]).includes('A'));
  const out: Record<string, string> = {};
  for (const k of columns) {
    let letters = normalizeRaci(node.raci[k]);
    if (!ownsOne && k === inherited && !letters.includes('A')) {
      letters = normalizeRaci(`${letters}A`);
    }
    out[k] = letters || 'I';
  }
  return out;
}

/** The owner column a row inherits from the rows above it — `inheritedOwnerColIn`. */
export function inheritedOwner(
  chart: Chart,
  nodeId: string,
  columns: readonly string[],
): string | null {
  let inherited: string | null = null;
  for (const ancestor of ancestorsOf(chart.nodes, nodeId).reverse()) {
    inherited = passDown(ancestor, inherited, columns);
  }
  return inherited;
}

// ---- flows --------------------------------------------------------------------------------------

/** A flow's handoffs as the legacy keeps them: no self-loops, no second copy of one connection. */
export function flowEdges(flow: Flow): FlowEdge[] {
  const seen = new Set<string>();
  return Object.values(flow.edges).filter((edge) => {
    if (edge.from === edge.to || !flow.steps[edge.from] || !flow.steps[edge.to]) return false;
    const key = `${edge.from}:${edge.fromPort ?? ''}>${edge.to}:${edge.toPort ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Steps in the order the flow runs — `bizTopoOrder`.
 *
 * Kahn's algorithm with the legacy's tie-break: ready steps are taken in the order they were drawn,
 * and anything a cycle keeps from ever becoming ready is appended in that same order.
 */
export function flowStepOrder(flow: Flow): FlowStep[] {
  const steps = Object.values(flow.steps);
  const edges = flowEdges(flow);
  const indegree = new Map<string, number>(steps.map((s) => [s.id, 0]));
  for (const e of edges) {
    if (indegree.has(e.from) && indegree.has(e.to)) indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const e of edges) {
      if (e.from !== id || !indegree.has(e.to)) continue;
      const left = indegree.get(e.to)! - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  for (const s of steps) if (!seen.has(s.id)) order.push(s.id);
  return order.map((id) => flow.steps[id]!);
}

/** A step's deliverables, derived from its handoffs in handoff order — `bizTaskIO`. */
export function stepDeliverables(
  flow: Flow,
  stepId: string,
): { inputs: string[]; outputs: string[] } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const e of flowEdges(flow)) {
    for (const id of e.artifactIds) {
      if (e.to === stepId) inputs.add(id);
      if (e.from === stepId) outputs.add(id);
    }
  }
  return { inputs: [...inputs], outputs: [...outputs] };
}

/** `artifactLabel`. */
export function deliverableName(ws: Workspace, id: string): string {
  const artifact = ws.artifacts[id];
  return artifact ? artifact.name || 'Untitled deliverable' : '(missing deliverable)';
}

/** The chart row a flow hangs under, when it still exists — `resolveAnchor`. */
export function resolvedAnchor(
  ws: Workspace,
  flow: Flow,
): { chart: Chart; node: ChartNode } | null {
  if (!flow.anchor) return null;
  const chart = ws.charts[flow.anchor.chartId];
  const node = chart?.nodes[flow.anchor.nodeId];
  return chart && node ? { chart, node } : null;
}

/**
 * The flows a chart's documents carry: anchored to one of its rows — `flowsForChart`.
 *
 * An anchor whose row is gone does not count. The legacy loader turns such a flow standalone before
 * anything can print it, so counting it here would put a flow in the rebuild's deck that the same
 * file leaves out of index.html's.
 */
export function flowsAnchoredTo(ws: Workspace, chartId: string): Flow[] {
  return Object.values(ws.flows).filter(
    (f) => f.anchor?.chartId === chartId && resolvedAnchor(ws, f),
  );
}

/** What an anchored flow's steps inherit — `bizAnchorCtx`, the part the documents use. */
export interface AnchorContext {
  readonly chart: Chart;
  readonly node: ChartNode;
  /** The anchor row's and its ancestors' roster refs, shallowest first. */
  readonly orgRefs: readonly OrgRef[];
}

export function anchorContext(ws: Workspace, flow: Flow): AnchorContext | null {
  const anchor = resolvedAnchor(ws, flow);
  if (!anchor) return null;
  const path = [...ancestorsOf(anchor.chart.nodes, anchor.node.id).reverse(), anchor.node];
  const orgRefs = path.map((n) => rowOrg(anchor.chart, n)).filter((r): r is OrgRef => r !== null);
  return { chart: anchor.chart, node: anchor.node, orgRefs };
}

/** Everything a Chart-Linked step reads off the row it is bound to — `bizBindCtx`. */
export interface BindContext {
  readonly chart: Chart;
  readonly node: ChartNode;
  readonly fw: Framework;
  /** The row's line over the org columns, with the owner it inherits folded in. */
  readonly raci: Readonly<Record<string, string>>;
  readonly tierLabel: string;
  /** Chart title, then every row from the top down to this one. */
  readonly crumb: readonly string[];
  readonly orgRefs: readonly OrgRef[];
}

/**
 * Resolve a step's bind, or null when it has none, it is a nested-flow box, or the row is gone.
 *
 * `columns` is the chart IN FRONT's column set, not the bound chart's. The legacy works out the
 * inherited owner through `chartCols()`, which reads the active tab, and a document is always
 * printed from the active tab — so a flow bound to one chart and exported from another resolves
 * its cascade against the exporting chart's columns. Faithfully odd; only observable when a
 * free-form chart exports a flow bound to an org chart.
 */
export function bindContext(
  ws: Workspace,
  step: FlowStep,
  columns: readonly string[],
): BindContext | null {
  if (step.kind === 'subflow' || !step.bind) return null;
  const chart = ws.charts[step.bind.chartId];
  // Only an ORGANIZATION chart can be bound to: a free-form chart's columns are not the seven a
  // flow step is keyed by.
  const node = chart && !freeFormShape(chart) ? chart.nodes[step.bind.nodeId] : undefined;
  if (!chart || !node) return null;
  const fw = framework(chart.framework);
  const inherited = inheritedOwner(chart, node.id, columns);
  const ownerColumn = COLS.find((k) => normalizeRaci(node.raci[k]).includes(fw.owner)) ?? null;
  const raci: Record<string, string> = {};
  for (const k of COLS) {
    const letters = normalizeRaci(node.raci[k]);
    raci[k] = !ownerColumn && k === inherited ? normalizeRaci(letters + fw.owner) : letters;
  }
  const ancestors = ancestorsOf(chart.nodes, node.id).reverse();
  return {
    chart,
    node,
    fw,
    raci,
    tierLabel: documentTierLabel(chart, ancestors.length),
    crumb: [
      chart.title || 'Untitled chart',
      ...ancestors.map((n) => n.name || '(untitled)'),
      node.name || '(untitled)',
    ],
    orgRefs: [...ancestors, node]
      .map((n) => rowOrg(chart, n))
      .filter((r): r is OrgRef => r !== null),
  };
}

/**
 * Carry a chart row's letters into the flow's framework — `translateLetters`. Owner maps to owner
 * and doer to doer; any other letter crosses only if the target framework has it.
 */
export function translateLetters(letters: string, from: Framework, to: Framework): string {
  if (from.key === to.key) return normalizeRaci(letters);
  const out = new Set<string>();
  for (const letter of normalizeRaci(letters)) {
    if (letter === from.owner) out.add(to.owner);
    else if (letter === from.doer) out.add(to.doer);
    else if (to.roles.includes(letter)) out.add(letter);
  }
  return normalizeRaci([...out].join(''));
}

/**
 * What a step says, per org column — `bizStepRaci`, the one place mode and binding are applied.
 *
 * A bound step in a Chart-Linked flow reads every column off its row. The legacy also lets a step
 * take individual columns back (`bindOverrides`); the rebuild's schema does not carry that list, so
 * here a bound step never overrides — which is what the legacy prints for any step that has not.
 */
export function stepLine(
  ws: Workspace,
  flow: Flow,
  step: FlowStep,
  columns: readonly string[],
): Record<string, string> {
  const bound = flow.mode === 'linked' ? bindContext(ws, step, columns) : null;
  const to = framework(flow.framework);
  const out: Record<string, string> = {};
  for (const k of COLS) {
    out[k] = bound
      ? translateLetters(bound.raci[k] ?? '', bound.fw, to)
      : normalizeRaci(step.raci[k]);
  }
  return out;
}

/** The columns a step holds any role in — `bizActiveCols`. */
function activeColumns(line: Readonly<Record<string, string>>): string[] {
  return COLS.filter((k) => line[k]);
}

/** `flowRolesText`: "HQ: A | C&EW: R". */
export function stepRolesText(
  ws: Workspace,
  flow: Flow,
  step: FlowStep,
  columns: readonly string[],
): string {
  const line = stepLine(ws, flow, step, columns);
  return activeColumns(line)
    .map((k) => `${columnShort(ws, k)}: ${line[k]}`)
    .join(' | ');
}

/**
 * The executing party a step's column falls to when it names none — `bizDefaultPartyForTask`: the
 * column's directorate, narrowed by the deepest ref on the bound row's path (a Chart-Linked step)
 * or the anchor row's path (anything else) that sits in that same directorate.
 */
export function defaultParty(
  ws: Workspace,
  flow: Flow,
  step: FlowStep,
  column: string,
  anchor: AnchorContext | null,
  columns: readonly string[],
): OrgRef | null {
  const context = (flow.mode === 'linked' ? bindContext(ws, step, columns) : null) ?? anchor;
  if (!context) return null;
  const actor = columnDirectorate(ws, column);
  if (!actor) return null;
  let ref: OrgRef = { actor };
  for (const r of context.orgRefs) if (!('entityId' in r) && r.actor === actor) ref = { ...r };
  return ref;
}

/** `flowPartiesText`: "C&EW → Cyber › SOC · Chief: … | HQ → DIRECTORATE A (default)". */
export function stepPartiesText(
  ws: Workspace,
  flow: Flow,
  anchor: AnchorContext | null,
  step: FlowStep,
  columns: readonly string[],
): string {
  const line = stepLine(ws, flow, step, columns);
  return activeColumns(line)
    .map((k) => {
      const explicit = step.parties[k];
      const ref = explicit ?? defaultParty(ws, flow, step, k, anchor, columns);
      const label = partyText(ws, ref)?.full;
      return label ? `${columnShort(ws, k)} → ${label}${explicit ? '' : ' (default)'}` : '';
    })
    .filter(Boolean)
    .join(' | ');
}

/** `flowLinkText`: which chart row a Chart-Linked step implements, as tier + full path. */
export function stepLinkText(
  ws: Workspace,
  flow: Flow,
  step: FlowStep,
  columns: readonly string[],
): string {
  if (flow.mode !== 'linked' || step.kind === 'subflow') return '';
  if (!step.bind) return '(not linked)';
  const bound = bindContext(ws, step, columns);
  return bound ? `${bound.tierLabel}: ${bound.crumb.join(' › ')}` : '(linked row is missing)';
}

/** `flowNextText`: "→ Contain [Incident Declaration]; → Review (No) [Triage Report]". */
export function stepNextText(ws: Workspace, flow: Flow, step: FlowStep): string {
  return flowEdges(flow)
    .filter((e) => e.from === step.id)
    .map((e) => {
      const to = flow.steps[e.to];
      const carried = e.artifactIds.map((id) => deliverableName(ws, id)).join(', ');
      return `→ ${to?.name || '?'}${e.label ? ` (${e.label})` : ''}${carried ? ` [${carried}]` : ''}`;
    })
    .join('; ');
}
