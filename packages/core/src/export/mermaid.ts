/**
 * The Mermaid exports — index.html's `exportMermaid` (a chart, top down) and `exportMermaidFlow`
 * (a flow, left to right), out of the DOM.
 *
 * The diagram people actually paste into a wiki, which shaped two of the legacy's decisions, kept
 * here as they are there:
 *
 *   - Mermaid has no document header, so the name and status go in as a `%%` comment. It survives
 *     the copy-paste, which a separate caption would not.
 *   - A chart row's box carries only who is Accountable and who is Responsible. A full RACI matrix
 *     in a box is unreadable at diagram scale, and the reader who needs it is looking at the chart,
 *     not at a picture of it.
 *
 * Byte for byte what index.html writes — the parity test holds both to the legacy app's own output
 * for the demo and two variations of it — so a diagram re-exported from either app does not churn
 * the wiki page it was pasted into.
 */

import { APP_NAME, APP_STAGE, APP_VERSION, MAX_TIER, framework } from '../constants.js';
import { childIndex, childrenIn } from '../tree.js';
import type { ChartNode, Workspace } from '../schema.js';
import {
  FLOW_MODE_NAMES,
  STATUS_TEXT,
  bindContext,
  chartColumnTexts,
  deliverableName,
  documentChart,
  documentColumns,
  documentFlow,
  flowEdges,
  freeFormShape,
  hasSignedStamp,
  passDown,
  printedLine,
  signedOn,
  stepRolesText,
  type DateStyle,
} from './document-text.js';

/** The banner the legacy signs a flow diagram with — `APP_BANNER`. */
const APP_BANNER = `${APP_NAME} (ver ${APP_VERSION} ${APP_STAGE})`;

/**
 * Which chart, and how a signed date is written — index.html prints it in the reader's own locale
 * and zone (see `DateStyle`).
 */
export interface ChartMermaidOptions extends DateStyle {
  /** The chart tab in front of the person — index.html's `ac()`. Absent or unknown: the first tab. */
  readonly chartId?: string;
}

/**
 * A chart as a top-down Mermaid flowchart: a box per row, labelled with who is Accountable and who
 * is Responsible once the cascade is resolved, and an edge from each row to each of its children.
 */
export function exportChartMermaid(ws: Workspace, opts: ChartMermaidOptions = {}): string {
  const chart = documentChart(ws, opts.chartId);
  // A quote would end the label and a line break the statement, so both go; nothing else is touched.
  const esc = (value: string) => value.replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ');
  const columns = chartColumnTexts(ws, chart);
  const keys = columns.map((c) => c.key);
  const short = new Map(columns.map((c) => [c.key, c.short]));
  const index = childIndex(chart.nodes);
  // An org chart ends at its fourth tier, as the legacy loader cuts it.
  const lastTier = freeFormShape(chart) ? Number.POSITIVE_INFINITY : MAX_TIER;

  const lines = [
    `%% ${chart.title || 'RACI chart'} — ${STATUS_TEXT[chart.status].short}` +
      (hasSignedStamp(chart) ? ` (signed ${signedOn(chart, opts)})` : ''),
    'flowchart TD',
  ];
  const tierClass = ['pf', 'pg', 'pj', 'tk'];
  let counter = 0;

  const walk = (
    node: ChartNode,
    depth: number,
    parent: string | null,
    inherited: string | null,
  ) => {
    const id = `n${counter++}`;
    const line = printedLine(node, inherited, keys);
    const owners = keys.filter((k) => line[k]!.includes('A')).map((k) => short.get(k)!);
    const doers = keys.filter((k) => line[k]!.includes('R')).map((k) => short.get(k)!);
    const summary =
      (owners.length ? `<br/>A: ${owners.join(', ')}` : '') +
      (doers.length ? `<br/>R: ${doers.join(', ')}` : '');
    lines.push(
      `  ${id}["${esc(node.name) || '(unnamed)'}${summary}"]:::${tierClass[depth] ?? 'tk'}`,
    );
    if (parent) lines.push(`  ${parent} --> ${id}`);
    const down = passDown(node, inherited, keys);
    if (depth < lastTier) {
      for (const child of childrenIn(index, node.id)) walk(child, depth + 1, id, down);
    }
  };
  for (const root of childrenIn(index, null)) walk(root, 0, null, null);

  lines.push('  classDef pf fill:#1c2b45,stroke:#4dabf7,color:#fff;');
  lines.push('  classDef pg fill:#1d2540,stroke:#748ffc,color:#fff;');
  lines.push('  classDef pj fill:#2a2140,stroke:#b07cff,color:#fff;');
  lines.push('  classDef tk fill:#14271c,stroke:#51cf66,color:#fff;');
  return lines.join('\n') + '\n';
}

/** How a flow's signed date is written, and which chart is in front of the person exporting it. */
export interface FlowMermaidOptions extends DateStyle {
  /**
   * The chart tab in front — index.html's `ac()`. A Chart-Linked step's inherited owner is resolved
   * through that chart's columns, as the legacy resolves it (see `bindContext`). Absent: the first tab.
   */
  readonly chartId?: string;
}

/**
 * A flow as a left-to-right Mermaid graph: a box per step, in the order they were drawn, each
 * labelled with the chart row it implements (a Chart-Linked step) and the roles it assigns; a step
 * with two or more ways out is a decision diamond; each handoff labelled with its condition and the
 * deliverables it carries.
 *
 * An unknown `flowId` draws the first flow, as index.html's `abc()` falls back to it.
 */
export function exportFlowMermaid(
  ws: Workspace,
  flowId: string,
  opts: FlowMermaidOptions = {},
): string {
  const flow = documentFlow(ws, flowId);
  // The legacy strips `|` here as well: it would end an edge label early.
  const esc = (value: string) => value.replace(/"/g, '&quot;').replace(/[\r\n|]+/g, ' ');
  const columns = documentColumns(documentChart(ws, opts.chartId));
  const edges = flowEdges(flow);

  const lines = [
    `%% ${flow.name || 'Flow'} — ${STATUS_TEXT[flow.status].short} · ${FLOW_MODE_NAMES[flow.mode]}` +
      (hasSignedStamp(flow) ? ` (signed ${signedOn(flow, opts)})` : ''),
    'flowchart LR',
  ];

  const outgoing = new Map<string, number>();
  for (const e of edges) outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
  const steps = Object.values(flow.steps);
  const ids = new Map(steps.map((step, i) => [step.id, `s${i}`]));

  for (const step of steps) {
    const roles = stepRolesText(ws, flow, step, columns);
    const row = flow.mode === 'linked' ? bindContext(ws, step, columns)?.node : undefined;
    const label =
      (esc(step.name) || '(unnamed)') +
      (row ? `<br/>⛓ ${esc(row.name || 'untitled row')}` : '') +
      (roles ? `<br/>${esc(roles)}` : '');
    const id = ids.get(step.id)!;
    lines.push(
      (outgoing.get(step.id) ?? 0) >= 2
        ? `  ${id}{"${label}"}:::dec`
        : `  ${id}["${label}"]:::step`,
    );
  }

  for (const e of edges) {
    const parts: string[] = [];
    if (e.label) parts.push(esc(e.label));
    if (e.artifactIds.length) {
      parts.push(esc(e.artifactIds.map((id) => deliverableName(ws, id)).join(', ')));
    }
    lines.push(
      `  ${ids.get(e.from)} ${parts.length ? `-->|${parts.join(' · ')}|` : '-->'} ${ids.get(e.to)}`,
    );
  }

  lines.push('  classDef step fill:#14271c,stroke:#51cf66,color:#fff;');
  lines.push('  classDef dec fill:#2a2140,stroke:#b07cff,color:#fff;');
  lines.push(`  %% ${framework(flow.framework).name} flow — exported from ${APP_BANNER}`);
  return lines.join('\n') + '\n';
}
