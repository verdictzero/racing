/**
 * The responsibility rules.
 *
 * This is the part of the app that is genuinely hard to get right, and the part most worth having
 * out of the DOM and under test. In the legacy app these rules are spread across the renderer —
 * `effectiveRaci`, `cascadeDown`, `inheritedOwnerCol`, `primaryRColumn` — where they are hard to
 * see and impossible to test without a browser. Here they are pure functions over the node map.
 *
 * These are the helpers the CHART SCREEN draws with. The violation rules do not use them: they are a
 * line-for-line port of index.html's own rule pass and read the document the way it does (see
 * lint-context.ts) — which differs in details a renderer can ignore and a rule cannot.
 *
 * THE CASCADE, in one paragraph
 * A row's Accountable column is the one that owns its outcome. Its Responsible column is the one
 * that does the work. The cascade says: whoever DOES the work at one tier OWNS it at the next.
 * So a row with a single R at Portfolio makes that column the A of every Program beneath it,
 * unless a Program states its own A. When a row holds several R's, it has to designate which one
 * cascades (`primaryR`) — otherwise the inheritance is ambiguous and the cascade passes straight
 * through from the nearest ancestor that WAS unambiguous.
 */

import { ALL_ROLE_LETTERS, framework, type Framework } from './constants.js';
import { ancestorsOf, type NodeMap } from './tree.js';
import { chartColumns, type Chart, type ChartNode } from './schema.js';

/**
 * Where a cell's letters came from.
 *
 *   explicit   the row states them
 *   inherited  they cascaded down from an ancestor
 *   default    the row states nothing, and a blank cell means Informed by convention
 *   none       genuinely empty — only `effectiveRaci` returns this; `displayRaci` never does
 */
export type RaciSource = 'explicit' | 'inherited' | 'default' | 'none';

export interface EffectiveCell {
  readonly letters: string;
  readonly source: RaciSource;
  /** For an inherited cell, the row the letters cascaded down from. */
  readonly fromNodeId: string | null;
}

export type EffectiveRow = Readonly<Record<string, EffectiveCell>>;

const EMPTY: EffectiveCell = { letters: '', source: 'none', fromNodeId: null };

/**
 * Clean up a cell of role letters typed by a person.
 *
 * Keeps only real role letters, drops duplicates, and puts them in a canonical order so that "ar",
 * "AR" and "RRA" all become the same cell. Anything else in the cell — a stray note, a tick, a
 * space — is discarded rather than rejected, because the source is a spreadsheet a human edited and
 * refusing the cell would lose the letters that WERE right.
 *
 * The canonical order is `ALL_ROLE_LETTERS`, so "AR" normalizes to "RA". That is the legacy app's
 * behaviour and the two must agree: the same workbook has to import identically in both.
 */
export function normalizeRaci(cell: string | null | undefined): string {
  if (!cell) return '';
  const present = new Set(String(cell).toUpperCase().split(''));
  return ALL_ROLE_LETTERS.filter((letter) => present.has(letter)).join('');
}

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

/**
 * True when the row names an owner that differs from the one it would have inherited.
 *
 * A MARKER, not a rule: index.html draws it as an amber ring on the owner chip (`.raci-chip.override`)
 * and raises no chart violation for it. Only a flow STEP overriding its cascade is a rule
 * (`flowOwnerOverride`, flow-rules.ts).
 */
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

// ---- the rule engine's vocabulary ----------------------------------------------------------------
// The rules themselves are in chart-rules.ts and flow-rules.ts, ported from index.html's
// `recomputeViolations` and `lintFlow`, and violations.ts runs them the way the legacy app does.
// The shapes they report in live here, below all of them, so the module graph stays one-way.

export type Severity = 'err' | 'warn';

/** One finding, flat: one rule broken on one row. */
export interface Violation {
  readonly nodeId: string;
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

/** One rule broken, as the legacy popover lists it under its row. */
export interface ViolationIssue {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

/**
 * One step of the crumb a record prints under its name. A chart row's crumb is the rows above it; a
 * flow step's is its flow, with a null id — exactly as index.html writes it.
 */
export interface ViolationCrumb {
  readonly id: string | null;
  readonly name: string;
}

/**
 * Everything wrong with ONE chart row: an entry of index.html's `_violations`.
 *
 * The legacy app counts, pins and lists these rather than individual issues. A row breaking three
 * rules is one line in the popover and one toward the pill, and its severity is the worst of them.
 */
export interface ChartViolationRecord {
  readonly kind: 'chart';
  readonly chartId: string;
  readonly nodeId: string;
  readonly flowId?: never;
  readonly stepId?: never;
  /** The row's name, or "(untitled)". */
  readonly name: string;
  /** Depth in the chart; 0 is the top tier. */
  readonly tier: number;
  readonly tierLabel: string;
  /** The rows above it, top down. */
  readonly ancestors: readonly ViolationCrumb[];
  readonly severity: Severity;
  readonly issues: readonly ViolationIssue[];
}

/** Everything wrong with ONE flow step or nested-flow box. */
export interface FlowViolationRecord {
  readonly kind: 'flow';
  readonly flowId: string;
  readonly stepId: string;
  readonly nodeId?: never;
  readonly tier?: never;
  readonly name: string;
  readonly tierLabel: 'Nested flow' | 'Flow step';
  /** Just the flow, under a null id. */
  readonly ancestors: readonly ViolationCrumb[];
  readonly severity: Severity;
  readonly issues: readonly ViolationIssue[];
}

export type ViolationRecord = ChartViolationRecord | FlowViolationRecord;

/** A record's severity: an error when any one of its issues is. */
export function worstSeverity(issues: readonly ViolationIssue[]): Severity {
  return issues.some((i) => i.severity === 'err') ? 'err' : 'warn';
}

/**
 * What the chart PRINTS, which is not quite what the chart assigns.
 *
 * `effectiveRaci` answers "what is actually assigned here", and a blank cell is genuinely blank.
 * The chart and the document exports answer a different question, and apply one more convention on
 * top: a cell with nothing in it means Informed. Kept apart because conflating them is wrong in a
 * way that matters — the work lens asks the first question, and a unit does not OWN work because a
 * blank cell defaulted to Informed. It would report every unit as Informed on everything.
 *
 * The default is marked `source: 'default'` so a renderer can dim it, exactly as `index.html` does.
 * Both its XML and Excel exports write the letter out, so this is the function they need if the two
 * apps are to produce the same document.
 */
export function displayRaci(
  chart: Pick<Chart, 'custom' | 'framework'>,
  nodes: NodeMap,
  nodeId: string,
): EffectiveRow {
  const resolved = effectiveRaci(chart, nodes, nodeId);
  const fw = framework(chart.framework);
  const out: Record<string, EffectiveCell> = {};
  for (const [col, cell] of Object.entries(resolved)) {
    out[col] = cell.letters
      ? cell
      : { letters: fw.informed, source: 'default', fromNodeId: null };
  }
  return out;
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
