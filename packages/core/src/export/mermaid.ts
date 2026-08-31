/**
 * Mermaid export.
 *
 * The diagram people actually paste into a wiki, which shapes two decisions:
 *
 *   - Mermaid has no document header, so the chart's name and status go in as a `%%` comment. It
 *     survives the copy-paste, which a separate caption would not.
 *   - Node labels carry only the Accountable and Responsible columns. A full RACI matrix in a box
 *     is unreadable at diagram scale, and the reader who needs it is looking at the chart, not at
 *     a picture of it.
 *
 * Pure, like the XML exporter, and for the same reason: in `index.html` this reads the active
 * chart from global state and calls `download()`.
 */

import { framework } from '../constants.js';
import { effectiveRaci } from '../raci.js';
import { childrenOf, rootsOf } from '../tree.js';
import { chartColumns, type Chart, type Workspace } from '../schema.js';
import { topologicalOrder } from './order.js';

/**
 * Mermaid labels are quoted strings, and a newline or a stray quote ends the diagram rather than
 * the label — so both are removed rather than escaped. `|` would break an edge label the same way.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/"/g, '&quot;')
    .replace(/[\r\n|]+/g, ' ')
    .trim();
}

/** Short column labels, honouring a free-form chart's own names. */
function shortLabels(ws: Workspace, chart: Chart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of chartColumns(chart)) {
    const custom = chart.custom?.cols.find((c) => c.key === key);
    out[key] = custom?.short || custom?.label || ws.columnShort[key] || key;
  }
  return out;
}

export interface MermaidOptions {
  /** Which chart. Defaults to the first, matching the legacy exporter's "active chart". */
  readonly chartId?: string;
  /** Include the palette classDefs. Off suits a wiki with its own Mermaid theme. */
  readonly includeStyles?: boolean;
}

/** A chart as a top-down Mermaid flowchart. */
export function exportChartMermaid(ws: Workspace, opts: MermaidOptions = {}): string {
  const chart = opts.chartId ? ws.charts[opts.chartId] : Object.values(ws.charts)[0];
  if (!chart) return '%% no chart\nflowchart TD\n';

  const columns = chartColumns(chart);
  const short = shortLabels(ws, chart);
  const fw = framework(chart.framework);

  const lines: string[] = [
    `%% ${esc(chart.title) || 'RACI chart'} — ${chart.status === 'final' ? 'FINAL' : 'DRAFT'}` +
      (chart.finalizedAt ? ` (signed ${chart.finalizedAt.slice(0, 10)})` : ''),
    'flowchart TD',
  ];

  const tierClass = ['pf', 'pg', 'pj', 'tk'];
  let counter = 0;

  const summary = (nodeId: string): string => {
    const eff = effectiveRaci(chart, chart.nodes, nodeId);
    const owners = columns.filter((k) => (eff[k]?.letters ?? '').includes(fw.owner)).map((k) => short[k]!);
    const doers = columns.filter((k) => (eff[k]?.letters ?? '').includes(fw.doer)).map((k) => short[k]!);
    return (
      (owners.length ? `<br/>${fw.owner}: ${esc(owners.join(', '))}` : '') +
      (doers.length ? `<br/>${fw.doer}: ${esc(doers.join(', '))}` : '')
    );
  };

  const walk = (nodeId: string, depth: number, parentMid: string | null) => {
    const node = chart.nodes[nodeId];
    if (!node) return;
    const mid = `n${counter++}`;
    const cls = tierClass[Math.min(depth, tierClass.length - 1)]!;
    lines.push(`  ${mid}["${esc(node.name) || '(unnamed)'}${summary(nodeId)}"]:::${cls}`);
    if (parentMid) lines.push(`  ${parentMid} --> ${mid}`);
    for (const child of childrenOf(chart.nodes, nodeId)) walk(child.id, depth + 1, mid);
  };

  for (const root of rootsOf(chart.nodes)) walk(root.id, 0, null);

  if (opts.includeStyles !== false) {
    lines.push('  classDef pf fill:#1c2b45,stroke:#4dabf7,color:#fff;');
    lines.push('  classDef pg fill:#1d2540,stroke:#748ffc,color:#fff;');
    lines.push('  classDef pj fill:#2a2140,stroke:#b07cff,color:#fff;');
    lines.push('  classDef tk fill:#14271c,stroke:#51cf66,color:#fff;');
  }
  return lines.join('\n') + '\n';
}

/** A flow as a left-to-right Mermaid graph. Decision points render as diamonds. */
export function exportFlowMermaid(ws: Workspace, flowId: string, opts: MermaidOptions = {}): string {
  const flow = ws.flows[flowId];
  if (!flow) return '%% no flow\nflowchart LR\n';

  const fw = framework(flow.framework);
  const lines: string[] = [
    `%% ${esc(flow.name) || 'Flow'} — ${flow.status === 'final' ? 'FINAL' : 'DRAFT'}` +
      ` · ${flow.mode === 'linked' ? 'Chart-Linked' : 'Free-Form'}` +
      (flow.finalizedAt ? ` (signed ${flow.finalizedAt.slice(0, 10)})` : ''),
    'flowchart LR',
  ];

  const outCount = new Map<string, number>();
  for (const edge of Object.values(flow.edges)) {
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
  }

  // Declared in dependency order, so the .mmd source reads the way the flow runs. Mermaid lays the
  // graph out itself, but a person reading or diffing the text should not have to trace edges to
  // work out where it starts. Topological order is deterministic, so a wiki page's diff still does
  // not churn between exports.
  const stepIds = topologicalOrder(flow);
  const mid = new Map(stepIds.map((id, i) => [id, `s${i}`]));

  for (const id of stepIds) {
    const step = flow.steps[id]!;
    const roles = fw.roles
      .map((letter) => {
        const cols = Object.entries(step.raci)
          .filter(([, letters]) => letters.includes(letter))
          .map(([col]) => ws.columnShort[col] || col)
          .sort();
        return cols.length ? `${letter}: ${cols.join(', ')}` : '';
      })
      .filter(Boolean)
      .join(' · ');

    const label = `${esc(step.name) || '(unnamed)'}${roles ? `<br/>${esc(roles)}` : ''}`;

    if (step.kind === 'subflow') {
      // A nested flow is a subroutine, not a decision — even though it has several exits, which
      // is what the plain out-degree rule would otherwise call it. Mermaid's subroutine shape says
      // "this stands in for another whole flow", which is exactly what the box means on the canvas.
      lines.push(`  ${mid.get(id)}[["${label}"]]:::sub`);
    } else if ((outCount.get(id) ?? 0) >= 2) {
      lines.push(`  ${mid.get(id)}{"${label}"}:::dec`);
    } else {
      lines.push(`  ${mid.get(id)}["${label}"]:::step`);
    }
  }

  for (const edge of Object.values(flow.edges).sort((a, b) => a.id.localeCompare(b.id))) {
    const from = mid.get(edge.from);
    const to = mid.get(edge.to);
    if (!from || !to) continue;
    const carried = edge.artifactIds
      .map((a) => ws.artifacts[a]?.name)
      .filter(Boolean)
      .join(', ');
    const label = [edge.label, carried].filter(Boolean).join(' — ');
    lines.push(label ? `  ${from} -->|"${esc(label)}"| ${to}` : `  ${from} --> ${to}`);
  }

  if (opts.includeStyles !== false) {
    lines.push('  classDef step fill:#1b1e24,stroke:#4dabf7,color:#fff;');
    lines.push('  classDef dec fill:#2a2140,stroke:#b07cff,color:#fff;');
    lines.push('  classDef sub fill:#1d2b26,stroke:#51cf66,color:#fff;');
  }
  return lines.join('\n') + '\n';
}
