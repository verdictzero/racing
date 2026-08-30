/**
 * The responsibility rules.
 *
 * This is the part of the app that is genuinely hard to get right, and the part most worth having
 * out of the DOM and under test. In the legacy app these rules are spread across the renderer —
 * `effectiveRaci`, `cascadeDown`, `inheritedOwnerCol`, `primaryRColumn` — where they are hard to
 * see and impossible to test without a browser. Here they are pure functions over the node map.
 *
 * THE CASCADE, in one paragraph
 * A row's Accountable column is the one that owns its outcome. Its Responsible column is the one
 * that does the work. The cascade says: whoever DOES the work at one tier OWNS it at the next.
 * So a row with a single R at Portfolio makes that column the A of every Program beneath it,
 * unless a Program states its own A. When a row holds several R's, it has to designate which one
 * cascades (`primaryR`) — otherwise the inheritance is ambiguous and the cascade passes straight
 * through from the nearest ancestor that WAS unambiguous.
 */

import { framework, type Framework } from './constants.js';
import { ancestorsOf, type NodeMap } from './tree.js';
import { chartColumns, type Chart, type ChartNode } from './schema.js';

/** Where a cell's letters came from. */
export type RaciSource = 'explicit' | 'inherited' | 'none';

export interface EffectiveCell {
  readonly letters: string;
  readonly source: RaciSource;
  /** For an inherited cell, the row the letters cascaded down from. */
  readonly fromNodeId: string | null;
}

export type EffectiveRow = Readonly<Record<string, EffectiveCell>>;

const EMPTY: EffectiveCell = { letters: '', source: 'none', fromNodeId: null };

/** Columns where `node` holds the doer letter (R in every current framework). */
export function doerColumns(node: ChartNode, columns: readonly string[], fw: Framework): string[] {
  return columns.filter((k) => (node.raci[k] ?? '').includes(fw.doer));
}

/** Columns where `node` holds the owner letter (A). */
export function ownerColumns(node: ChartNode, columns: readonly string[], fw: Framework): string[] {
  return columns.filter((k) => (node.raci[k] ?? '').includes(fw.owner));
}

/**
 * The single doer column that cascades down to become the children's owner.
 *
 *   no doer      -> null (nothing to pass down; the cascade continues from an ancestor)
 *   exactly one  -> that column, no designation needed
 *   more than one-> `primaryR` if it is still one of them, else null
 *
 * The last case is deliberately null rather than a guess: two teams doing the work is a real
 * situation, and picking one silently would put accountability on a team nobody chose.
 */
export function primaryDoerColumn(
  node: ChartNode,
  columns: readonly string[],
  fw: Framework,
): string | null {
  const doers = doerColumns(node, columns, fw);
  if (doers.length === 0) return null;
  if (doers.length === 1) return doers[0]!;
  return node.primaryR && doers.includes(node.primaryR) ? node.primaryR : null;
}

/** True when a row has several doers and has not said which one carries down. */
export function needsPrimaryDoer(
  node: ChartNode,
  columns: readonly string[],
  fw: Framework,
): boolean {
  return doerColumns(node, columns, fw).length > 1 && primaryDoerColumn(node, columns, fw) === null;
}

/**
 * The owner column a node INHERITS: the primary doer of the nearest ancestor that designated one.
 * Null at the top of the chart, or when no ancestor was unambiguous.
 */
export function inheritedOwnerColumn(
  nodes: NodeMap,
  nodeId: string,
  columns: readonly string[],
  fw: Framework,
): { column: string; fromNodeId: string } | null {
  for (const ancestor of ancestorsOf(nodes, nodeId)) {
    const col = primaryDoerColumn(ancestor, columns, fw);
    if (col) return { column: col, fromNodeId: ancestor.id };
  }
  return null;
}

/**
 * A row's effective responsibility: what it states, plus the owner it inherits where it states
 * none of its own.
 *
 * A row that names its own owner overrides the inheritance completely — that is the point of
 * being able to name one. The override is worth SHOWING differently (the legacy app rings it in
 * amber), which is why the source is carried on every cell rather than flattened away.
 */
export function effectiveRaci(
  chart: Pick<Chart, 'custom' | 'framework'>,
  nodes: NodeMap,
  nodeId: string,
): EffectiveRow {
  const node = nodes[nodeId];
  const columns = chartColumns(chart);
  const fw = framework(chart.framework);
  const out: Record<string, EffectiveCell> = {};
  for (const col of columns) out[col] = EMPTY;
  if (!node) return out;

  for (const col of columns) {
    const letters = node.raci[col] ?? '';
    if (letters) out[col] = { letters, source: 'explicit', fromNodeId: nodeId };
  }

  // Inherit an owner only when this row names none anywhere.
  const statesOwner = ownerColumns(node, columns, fw).length > 0;
  if (!statesOwner) {
    const inherited = inheritedOwnerColumn(nodes, nodeId, columns, fw);
    if (inherited) {
      const existing = out[inherited.column] ?? EMPTY;
      const merged = existing.letters.includes(fw.owner)
        ? existing.letters
        : mergeLetters(existing.letters, fw.owner);
      out[inherited.column] = {
        letters: merged,
        // The cell is inherited only if the row said nothing here at all; a row that named a C
        // and inherits the A on the same column is still showing its own letter plus a dashed one.
        source: existing.letters ? 'explicit' : 'inherited',
        fromNodeId: existing.letters ? nodeId : inherited.fromNodeId,
      };
    }
  }

  return out;
}

/** Add a letter to a cell, keeping canonical order. */
function mergeLetters(letters: string, add: string): string {
  const order = ['R', 'D', 'A', 'S', 'P', 'C', 'I'];
  const set = new Set([...letters.split(''), add]);
  return order.filter((l) => set.has(l)).join('');
}

/** True when the row names an owner that differs from the one it would have inherited. */
export function isOwnerOverride(
  chart: Pick<Chart, 'custom' | 'framework'>,
  nodes: NodeMap,
  nodeId: string,
): boolean {
  const node = nodes[nodeId];
  if (!node) return false;
  const columns = chartColumns(chart);
  const fw = framework(chart.framework);
  const own = ownerColumns(node, columns, fw);
  if (own.length === 0) return false;
  const inherited = inheritedOwnerColumn(nodes, nodeId, columns, fw);
  return inherited !== null && !own.includes(inherited.column);
}

// ---- the rule engine -----------------------------------------------------------------------------

export type Severity = 'err' | 'warn';

export interface Violation {
  readonly nodeId: string;
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

/**
 * The chart rules, as they exist in the legacy app.
 *
 * Advisory by design: this is a reading list, never a blocker. A chart mid-edit is allowed to be
 * wrong, and a tool that refused to save one would just be worked around.
 */
export function chartViolations(chart: Chart): Violation[] {
  const columns = chartColumns(chart);
  const fw = framework(chart.framework);
  const out: Violation[] = [];
  const nodes = chart.nodes;

  for (const node of Object.values(nodes)) {
    const label = node.name || 'Untitled row';
    const owners = ownerColumns(node, columns, fw);
    const doers = doerColumns(node, columns, fw);
    const eff = effectiveRaci(chart, nodes, node.id);
    const effOwners = columns.filter((c) => (eff[c]?.letters ?? '').includes(fw.owner));

    // Exactly one accountable party. Two is the classic RACI failure — nobody owns it, because
    // both assume the other does.
    if (owners.length > 1) {
      out.push({
        nodeId: node.id,
        rule: 'multipleOwners',
        severity: 'err',
        message: `"${label}" names ${owners.length} ${fw.meta[fw.owner]?.label ?? fw.owner} parties. Exactly one party owns an outcome.`,
      });
    }
    if (effOwners.length === 0) {
      out.push({
        nodeId: node.id,
        rule: 'noOwner',
        severity: 'err',
        message: `"${label}" has no ${fw.meta[fw.owner]?.label ?? fw.owner} party, and none cascades down to it.`,
      });
    }
    if (doers.length === 0) {
      out.push({
        nodeId: node.id,
        rule: 'noDoer',
        severity: 'warn',
        message: `"${label}" has no ${fw.meta[fw.doer]?.label ?? fw.doer} party — nobody is named to do the work.`,
      });
    }
    if (needsPrimaryDoer(node, columns, fw)) {
      out.push({
        nodeId: node.id,
        rule: 'noPrimaryDoer',
        severity: 'warn',
        message: `"${label}" has ${doers.length} ${fw.meta[fw.doer]?.label ?? fw.doer} parties and has not said which one carries down to its children.`,
      });
    }
    if (isOwnerOverride(chart, nodes, node.id)) {
      out.push({
        nodeId: node.id,
        rule: 'ownerOverride',
        severity: 'warn',
        message: `"${label}" names an owner different from the one it inherits. Allowed, but deliberate — check it is meant.`,
      });
    }
  }

  return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.rule.localeCompare(b.rule));
}

/** Violations keyed by node, for the per-row pins. */
export function violationsByNode(violations: Violation[]): Map<string, Violation[]> {
  const map = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = map.get(v.nodeId);
    if (list) list.push(v);
    else map.set(v.nodeId, [v]);
  }
  return map;
}
