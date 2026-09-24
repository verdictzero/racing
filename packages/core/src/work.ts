/**
 * The work lens: what does my unit actually own?
 *
 * The question a RACI chart exists to answer, and the one the chart itself is worst at — the answer
 * is scattered across 800 rows in one document and a dozen flow steps in another. This walks both
 * and returns one list, scoped to a unit.
 *
 * TWO KINDS OF LANDING, and keeping them apart is the whole design. Work assigned to your unit or
 * to a team inside it is DIRECT: someone chose you. Work assigned to a parent org with no deeper
 * unit named is INHERITED: it lands on everyone underneath, including you, because nobody was more
 * specific. Merging them would produce a list that reads as "yours" and is not, which is the exact
 * failure mode that makes people stop trusting the tool.
 *
 * THIS IS index.html's `collectWorkItems`, ported line for line, because the Tasks screen has to
 * print exactly what the source prints — the same items, in the same order, with the same words:
 *
 *   - chart rows come from ORGANIZATION charts only, in tab order, walked in tree order. A row lands
 *     through its own org or the nearest ancestor's; its role chips are the letters the row STATES
 *     (the source does not repeat the cascaded owner on a work card);
 *   - flow steps come after every chart row. A step's letters are what it says after Chart-Linked
 *     binding is applied, and a column that names no party falls to the column's mapped directorate,
 *     narrowed by the org refs above the bound row (linked) or the flow's anchor (free-form) — the
 *     dashed default the flow canvas shows;
 *   - labels are the source's: "(untitled)", "Untitled case", a handoff's far end quoted and followed
 *     by the units named on it.
 *
 * A bound step reads every column from its row except the ones in its `bindOverrides`, which it
 * states itself — as the source's does.
 */

import { ACTOR_LABELS_DEFAULT, ACTORS, COLS, entityKindMeta, framework, type Framework } from './constants.js';
import { inheritedOwnerColumn, normalizeRaci } from './raci.js';
import { chartsInTabOrder, computeArtifactUses, entityDisplayName as entityName } from './registry.js';
import { scopeRelation } from './org.js';
import { ancestorsOf, childIndex, childrenIn } from './tree.js';
import { tierLabel } from './legacy.js';
import type { Chart, ChartNode, FlowStep, OrgRef, Workspace } from './schema.js';

/** One responsibility this unit holds on one item. */
export interface WorkRole {
  readonly column: string;
  readonly letters: string;
  /** A flow step's column that names no party, and so falls to the chart context's default. */
  readonly inherited: boolean;
  /** The unit that holds it. Empty on a chart row, whose unit is the card's own badge. */
  readonly unit: string;
}

/** A deliverable crossing the boundary of this item, and what is on the other side. */
export interface WorkIo {
  readonly artifactId: string;
  readonly name: string;
  /** Who produces an input / who takes an output. Empty when nothing does. */
  readonly counterparts: string[];
}

export interface WorkItem {
  readonly kind: 'chartRow' | 'flowStep';
  /** Whether the unit was named, or picked it up from an ancestor org. */
  readonly relation: 'direct' | 'inherited';
  readonly name: string;
  /** The breadcrumb line: which document and where in it. */
  readonly where: string;
  /** The org badge — the unit this landed on. */
  readonly unit: string;
  readonly roles: WorkRole[];
  readonly description: string;
  readonly entry: string;
  readonly exit: string;
  readonly inputs: WorkIo[];
  readonly outputs: WorkIo[];
  /** Enough to navigate there. */
  readonly chartId?: string;
  readonly nodeId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
}

// ---- labels, as index.html words them -----------------------------------------------------------

/** A party's two display strings: the badge and the tooltip / header line. */
export interface WorkLabel {
  readonly short: string;
  readonly full: string;
}

const actorLabel = (ws: Workspace, actor: string): string =>
  ws.actorLabels[actor] || ACTOR_LABELS_DEFAULT[actor as keyof typeof ACTOR_LABELS_DEFAULT] || actor;

/** index.html's `orgLabel`: null for a directorate-only ref, and for a unit that no longer exists. */
function sourceOrgLabel(ws: Workspace, ref: OrgRef | null | undefined): WorkLabel | null {
  if (!ref) return null;
  if ('entityId' in ref) {
    const e = ws.entities[ref.entityId];
    if (!e) return { short: '(missing entity)', full: 'This party named an entity that has since been deleted' };
    const lead = e.lead?.name ? ` · Lead: ${e.lead.name}` : '';
    return { short: entityName(e), full: `${entityKindMeta(e.kind).label}: ${entityName(e)}${lead}` };
  }
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
      full: `${actorLabel(ws, ref.actor)} › ${division?.name || '—'} › ${branch?.name || '—'} › ${name}${lead}`,
    };
  }
  if (ref.branchId) {
    if (!branch) return null;
    const chief = branch.chief?.name ? ` · Chief: ${branch.chief.name}` : '';
    return {
      short: branch.name || 'Untitled branch',
      full: `${actorLabel(ws, ref.actor)} › ${division?.name || '—'} › ${branch.name || 'Untitled branch'}${chief}`,
    };
  }
  if (ref.divisionId) {
    if (!division) return null;
    const chief = division.chief?.name ? ` · Chief: ${division.chief.name}` : '';
    return {
      short: division.name || 'Untitled division',
      full: `${actorLabel(ws, ref.actor)} › ${division.name || 'Untitled division'}${chief}`,
    };
  }
  return null;
}

/**
 * index.html's `partyLabel`: `orgLabel`, but a directorate-only ref resolves to the directorate.
 * What the Tasks screen prints for its scope — the header line (`full`) and the hint (`short`).
 */
export function workScopeLabel(ws: Workspace, ref: OrgRef | null | undefined): WorkLabel | null {
  if (!ref) return null;
  if ('entityId' in ref) return sourceOrgLabel(ws, ref);
  if (!(ACTORS as readonly string[]).includes(ref.actor)) return null;
  if (ref.divisionId) return sourceOrgLabel(ws, ref);
  const label = actorLabel(ws, ref.actor);
  return { short: label, full: label };
}

const artifactLabel = (ws: Workspace, id: string): string => {
  const a = ws.artifacts[id];
  return a ? a.name || 'Untitled deliverable' : '(missing deliverable)';
};

// ---- the flow side's chart context ---------------------------------------------------------------

/** The org refs of `node` and every row above it, shallow → deep. */
function orgRefsDownTo(chart: Chart, node: ChartNode): OrgRef[] {
  return [...ancestorsOf(chart.nodes, node.id).reverse(), node]
    .map((n) => n.org)
    .filter((r): r is OrgRef => r !== null);
}

/** What a bound step reads off its chart row — index.html's `bizBindCtx`, the parts this needs. */
interface BindCtx {
  readonly node: ChartNode;
  readonly fw: Framework;
  readonly raci: Record<string, string>;
  readonly tierLabel: string;
  readonly orgRefs: OrgRef[];
}

function bindCtx(ws: Workspace, step: FlowStep): BindCtx | null {
  if (step.kind === 'subflow' || !step.bind) return null;
  const chart = ws.charts[step.bind.chartId];
  // Only organization charts can be bound to: a free-form chart's columns are its own, and have
  // nothing to correspond to on a flow step.
  const node = chart && !chart.custom ? chart.nodes[step.bind.nodeId] : undefined;
  if (!chart || !node) return null;
  const fw = framework(chart.framework);
  const inherited = inheritedOwnerColumn(chart.nodes, node.id, COLS, fw)?.column ?? null;
  const ownCol = COLS.find((k) => normalizeRaci(node.raci[k]).includes(fw.owner)) ?? null;
  const raci: Record<string, string> = {};
  for (const k of COLS) {
    const v = normalizeRaci(node.raci[k]);
    raci[k] = !ownCol && k === inherited ? normalizeRaci(v + fw.owner) : v;
  }
  return {
    node,
    fw,
    raci,
    tierLabel: tierLabel(chart, ancestorsOf(chart.nodes, node.id).length),
    orgRefs: orgRefsDownTo(chart, node),
  };
}

/**
 * A chart row's letters in the flow's framework. Owner maps to owner and doer to doer; any other
 * letter crosses only if the flow's framework has it (an RASCI chart's S drops on a RACI flow).
 */
function translateLetters(letters: string, from: Framework, to: Framework): string {
  if (from === to) return normalizeRaci(letters);
  const out = new Set<string>();
  for (const l of normalizeRaci(letters)) {
    if (l === from.owner) out.add(to.owner);
    else if (l === from.doer) out.add(to.doer);
    else if (to.roles.includes(l)) out.add(l);
  }
  return normalizeRaci([...out].join(''));
}

/** The columns a bound step has taken back from its row. */
function bindOverrides(step: FlowStep): Set<string> {
  return new Set(step.bindOverrides);
}

/** The column's mapped directorate, narrowed by the deepest ref inside it — `bizDefaultPartyFor`. */
function defaultParty(ws: Workspace, orgRefs: readonly OrgRef[] | null, column: string): OrgRef | null {
  if (!orgRefs) return null;
  const actor = ws.columnActor[column];
  if (!actor || !(ACTORS as readonly string[]).includes(actor)) return null;
  let ref: OrgRef = { actor: actor as (typeof ACTORS)[number] };
  for (const r of orgRefs) if ('actor' in r && r.actor === actor) ref = { ...r };
  return ref;
}

/**
 * Everything that lands on `scope`, across every chart and every flow.
 *
 * Chart rows first (tab order, tree order), then flow steps (flow order, step order) — the source's
 * order, which the screen's two groups each keep.
 */
export function collectWork(ws: Workspace, scope: OrgRef | null | undefined): WorkItem[] {
  if (!scope) return [];
  const items: WorkItem[] = [];
  const uses = computeArtifactUses(ws);
  const unitShort = (ref: OrgRef | null) => workScopeLabel(ws, ref)?.short ?? '';

  // ---- chart rows ------------------------------------------------------------------------------
  for (const chart of chartsInTabOrder(ws)) {
    if (chart.custom) continue;
    const index = childIndex(chart.nodes);
    const seen = new Set<string>();

    const walk = (parentId: string | null, depth: number, ancestors: string[], inheritedRef: OrgRef | null) => {
      for (const node of childrenIn(index, parentId)) {
        if (seen.has(node.id)) continue; // a merge can leave a cycle; never walk it twice
        seen.add(node.id);
        const ref = node.org ?? inheritedRef;
        const relation = scopeRelation(scope, ref);
        if (relation) {
          items.push({
            kind: 'chartRow',
            relation,
            name: node.name || '(untitled)',
            where: `${tierLabel(chart, depth)} · ${chart.title || 'Untitled chart'}${
              ancestors.length ? ` › ${ancestors.join(' › ')}` : ''
            }`,
            unit: unitShort(ref),
            roles: COLS.filter((k) => normalizeRaci(node.raci[k])).map((k) => ({
              column: k,
              letters: normalizeRaci(node.raci[k]),
              inherited: false,
              unit: '',
            })),
            description: node.description,
            entry: '',
            exit: '',
            // A row is never its own supplier: "takes the register, returns the register" is a row
            // restating what it works on.
            inputs: node.inputs.map((id) => ({
              artifactId: id,
              name: artifactLabel(ws, id),
              counterparts: (uses.get(id)?.producers ?? []).filter((u) => u.nodeId !== node.id).map((u) => u.name),
            })),
            outputs: node.outputs.map((id) => ({
              artifactId: id,
              name: artifactLabel(ws, id),
              counterparts: (uses.get(id)?.consumers ?? []).filter((u) => u.nodeId !== node.id).map((u) => u.name),
            })),
            chartId: chart.id,
            nodeId: node.id,
          });
        }
        walk(node.id, depth + 1, [...ancestors, node.name || '(untitled)'], node.org ?? inheritedRef);
      }
    };
    walk(null, 0, [], null);
  }

  // ---- flow steps ------------------------------------------------------------------------------
  const TO = framework('raci'); // flows are RACI, full stop (v0.34)
  for (const flow of Object.values(ws.flows)) {
    const anchorChart = flow.anchor ? ws.charts[flow.anchor.chartId] : undefined;
    const anchorNode = flow.anchor && anchorChart ? anchorChart.nodes[flow.anchor.nodeId] : undefined;
    const anchorRefs = anchorChart && anchorNode ? orgRefsDownTo(anchorChart, anchorNode) : null;
    const crumbBase =
      anchorChart && anchorNode
        ? `${anchorChart.title || 'Untitled chart'} › … › ${anchorNode.name || '(untitled)'}`
        : null;
    const linked = flow.mode === 'linked';
    const steps = Object.values(flow.steps);
    const edges = Object.values(flow.edges);

    // "Recover" (Division C1, Branch C1.2) — the far end of a handoff, as the card names it: the
    // step, quoted, and the units its own parties name.
    const endLabel = (step: FlowStep | undefined): string[] => {
      if (!step) return [];
      const units = new Set<string>();
      for (const r of Object.values(step.parties)) {
        const label = workScopeLabel(ws, r);
        if (label) units.add(label.short);
      }
      return [`"${step.name || 'untitled step'}"${units.size ? ` (${[...units].join(', ')})` : ''}`];
    };

    for (const step of steps) {
      // A nested-flow box holds no responsibility of its own — the roles live in the flow it
      // references and are collected when THAT flow is walked.
      if (step.kind === 'subflow') continue;
      const bind = linked ? bindCtx(ws, step) : null;
      const overrides = bind ? bindOverrides(step) : null;

      const roles: WorkRole[] = [];
      let best: 'direct' | 'inherited' | null = null;
      for (const column of COLS) {
        const letters =
          bind && !overrides!.has(column)
            ? translateLetters(bind.raci[column] ?? '', bind.fw, TO)
            : normalizeRaci(step.raci[column]);
        if (!letters) continue;
        const explicit = step.parties[column] ?? null;
        const ref = explicit ?? defaultParty(ws, bind ? bind.orgRefs : anchorRefs, column);
        const relation = scopeRelation(scope, ref);
        if (!relation) continue;
        roles.push({ column, letters, inherited: !explicit, unit: unitShort(ref) });
        if (relation === 'direct') best = 'direct';
        else best ??= relation;
      }
      if (!best) continue;

      const inputs: WorkIo[] = [];
      const outputs: WorkIo[] = [];
      for (const edge of edges) {
        if (edge.artifactIds.length === 0) continue;
        if (edge.to === step.id) {
          const counterparts = endLabel(flow.steps[edge.from]);
          for (const id of edge.artifactIds) inputs.push({ artifactId: id, name: artifactLabel(ws, id), counterparts });
        }
        if (edge.from === step.id) {
          const counterparts = endLabel(flow.steps[edge.to]);
          for (const id of edge.artifactIds) outputs.push({ artifactId: id, name: artifactLabel(ws, id), counterparts });
        }
      }

      // A linked step's chart row is more useful provenance to a branch reader than the flow's
      // anchor, so it wins the line when both exist.
      const provenance = bind
        ? ` ⛓ ${bind.tierLabel}: ${bind.node.name || '(untitled)'}`
        : crumbBase
          ? ` ⚓ ${crumbBase}`
          : '';
      items.push({
        kind: 'flowStep',
        relation: best,
        name: step.name || '(untitled step)',
        where: `Flow step · ${flow.name || 'Untitled case'}${provenance}`,
        unit: '',
        roles,
        description: step.description,
        entry: step.entry,
        exit: step.exit,
        inputs,
        outputs,
        flowId: flow.id,
        stepId: step.id,
      });
    }
  }

  return items;
}

export interface WorkSummary {
  readonly total: number;
  readonly direct: number;
  readonly inherited: number;
  /** How many items carry each role letter — "you are Accountable for 12 things". */
  readonly byLetter: Record<string, number>;
}

/** The counts a unit's run book leads with. */
export function summarizeWork(items: readonly WorkItem[]): WorkSummary {
  const byLetter: Record<string, number> = {};
  for (const item of items) {
    // Per ITEM, not per cell: holding A in two columns of one row is still one thing you own.
    const letters = new Set<string>();
    for (const role of item.roles) for (const letter of role.letters) letters.add(letter);
    for (const letter of letters) byLetter[letter] = (byLetter[letter] ?? 0) + 1;
  }
  return {
    total: items.length,
    direct: items.filter((i) => i.relation === 'direct').length,
    inherited: items.filter((i) => i.relation === 'inherited').length,
    byLetter,
  };
}
