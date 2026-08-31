/**
 * XML export.
 *
 * A pure function of the workspace, which is the point of moving it here: in `index.html` this
 * reads the DOM's idea of the active chart and calls `download()` at the end, so it can only run
 * in a browser with a chart open. Here it takes a workspace and returns a string, so the app, the
 * API and a batch job all produce byte-identical output, and it can be tested without a browser.
 *
 * THE SHAPE IS THE LEGACY SHAPE, deliberately. Anyone consuming this has scripts written against
 * what v0.39 emits; a tidier schema would break them for no benefit they asked for. Where the new
 * model differs (flat rows, sparse cells) the difference is absorbed here, exactly as `legacy.ts`
 * absorbs it for the JSON format.
 */

import { framework, TIER_LABELS } from '../constants.js';
import { displayRaci } from '../raci.js';
import { childrenOf, rootsOf } from '../tree.js';
import { chartColumns, type Chart, type ChartNode, type Flow, type Workspace } from '../schema.js';
import { topologicalOrder } from './order.js';

/** XML text escaping. Attribute values and text nodes take the same treatment. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Element name per tier, matching the legacy exporter. Deeper free-form levels reuse "task". */
const TIER_TAGS = ['portfolio', 'program', 'project', 'task'] as const;

function tagFor(depth: number): string {
  return TIER_TAGS[Math.min(depth, TIER_TAGS.length - 1)]!;
}

export interface XmlExportOptions {
  /** Limit to one chart. Omit to export every chart in the workspace. */
  readonly chartId?: string;
  /** Include anchored flows nested under the row they implement. Default true. */
  readonly includeFlows?: boolean;
  readonly generatedBy?: string;
  /** Injectable so a snapshot test is not a clock test. */
  readonly now?: Date;
}

function artifactName(ws: Workspace, id: string): string {
  return ws.artifacts[id]?.name ?? '(missing deliverable)';
}

/** Deliverables a step consumes and produces, derived from its edges rather than stored. */
export function stepIo(flow: Flow, stepId: string): { inputs: string[]; outputs: string[] } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const edge of Object.values(flow.edges)) {
    if (edge.to === stepId) for (const id of edge.artifactIds) inputs.add(id);
    if (edge.from === stepId) for (const id of edge.artifactIds) outputs.add(id);
  }
  return { inputs: [...inputs].sort(), outputs: [...outputs].sort() };
}

/** "R: Cyber · A: HQ" — the roles a step assigns, for an attribute. */
function stepRoles(flow: Flow, step: Flow['steps'][string]): string {
  const fw = framework(flow.framework);
  const byLetter = new Map<string, string[]>();
  for (const [col, letters] of Object.entries(step.raci)) {
    for (const letter of letters) {
      const list = byLetter.get(letter);
      if (list) list.push(col);
      else byLetter.set(letter, [col]);
    }
  }
  return fw.roles
    .filter((letter) => byLetter.has(letter))
    .map((letter) => `${letter}: ${byLetter.get(letter)!.sort().join(', ')}`)
    .join(' · ');
}

function flowXml(ws: Workspace, flow: Flow, pad: string): string {
  const nameOf = (id: string) => flow.steps[id]?.name || '?';

  const steps = topologicalOrder(flow)
    .map((id) => {
      const step = flow.steps[id]!;
      const io = stepIo(flow, id);
      const inner =
        io.inputs.map((a) => `${pad}    <input deliverable="${esc(artifactName(ws, a))}"/>\n`).join('') +
        io.outputs.map((a) => `${pad}    <output deliverable="${esc(artifactName(ws, a))}"/>\n`).join('');

      const roles = stepRoles(flow, step);
      const attrs =
        `${pad}  <step name="${esc(step.name)}"` +
        (step.description ? ` description="${esc(step.description)}"` : '') +
        (step.entry ? ` entry="${esc(step.entry)}"` : '') +
        (step.exit ? ` exit="${esc(step.exit)}"` : '') +
        (roles ? ` roles="${esc(roles)}"` : '');
      return inner ? `${attrs}>\n${inner}${pad}  </step>\n` : `${attrs}/>\n`;
    })
    .join('');

  const handoffs = Object.values(flow.edges)
    .map(
      (e) =>
        `${pad}  <handoff from="${esc(nameOf(e.from))}" to="${esc(nameOf(e.to))}"` +
        (e.label ? ` condition="${esc(e.label)}"` : '') +
        (e.artifactIds.length
          ? ` deliverables="${esc(e.artifactIds.map((a) => artifactName(ws, a)).join(', '))}"`
          : '') +
        '/>\n',
    )
    .join('');

  return (
    `${pad}<flow name="${esc(flow.name)}" status="${esc(flow.status)}" mode="${esc(flow.mode)}"` +
    (flow.finalizedAt ? ` finalized="${esc(flow.finalizedAt)}"` : '') +
    `>\n${steps}${handoffs}${pad}</flow>\n`
  );
}

function nodeXml(
  ws: Workspace,
  chart: Chart,
  node: ChartNode,
  depth: number,
  pad: string,
  flowsByNode: Map<string, Flow[]>,
  includeFlows: boolean,
): string {
  const columns = chartColumns(chart);
  const eff = displayRaci(chart, chart.nodes, node.id);
  const raci = columns
    .filter((k) => eff[k]?.letters)
    .map((k) => ` ${k}="${esc(eff[k]!.letters)}"`)
    .join('');

  const org = node.org
    ? ' org="' +
      esc(
        'entityId' in node.org
          ? node.org.entityId
          : [node.org.actor, node.org.divisionId, node.org.branchId, node.org.teamId]
              .filter(Boolean)
              .join('/'),
      ) +
      '"'
    : '';

  const tag = tagFor(depth);
  const open = `${pad}<${tag} name="${esc(node.name)}"${raci}${org}`;

  const inner =
    (node.description ? `${pad}  <definition>${esc(node.description)}</definition>\n` : '') +
    node.inputs.map((a) => `${pad}  <input deliverable="${esc(artifactName(ws, a))}"/>\n`).join('') +
    node.outputs.map((a) => `${pad}  <output deliverable="${esc(artifactName(ws, a))}"/>\n`).join('') +
    (includeFlows
      ? (flowsByNode.get(node.id) ?? []).map((f) => flowXml(ws, f, `${pad}  `)).join('')
      : '') +
    childrenOf(chart.nodes, node.id)
      .map((child) => nodeXml(ws, chart, child, depth + 1, `${pad}  `, flowsByNode, includeFlows))
      .join('');

  return inner ? `${open}>\n${inner}${pad}</${tag}>\n` : `${open}/>\n`;
}

/** The workspace (or one chart of it) as XML. */
export function exportXml(ws: Workspace, opts: XmlExportOptions = {}): string {
  const includeFlows = opts.includeFlows !== false;
  const charts = opts.chartId
    ? [ws.charts[opts.chartId]].filter((c): c is Chart => !!c)
    : Object.values(ws.charts);

  const flowsByNode = new Map<string, Flow[]>();
  for (const flow of Object.values(ws.flows)) {
    if (!flow.anchor) continue;
    const list = flowsByNode.get(flow.anchor.nodeId);
    if (list) list.push(flow);
    else flowsByNode.set(flow.anchor.nodeId, [flow]);
  }

  const generated = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const body = charts
    .map((chart) => {
      const fw = framework(chart.framework);
      const tiers = chart.custom
        ? chart.custom.tiers.join(', ') || 'custom'
        : TIER_LABELS.join(', ');
      const rows = rootsOf(chart.nodes)
        .map((node) => nodeXml(ws, chart, node, 0, '    ', flowsByNode, includeFlows))
        .join('');
      return (
        `  <chart title="${esc(chart.title)}" framework="${esc(fw.name)}" status="${esc(chart.status)}"` +
        (chart.finalizedAt ? ` finalized="${esc(chart.finalizedAt)}"` : '') +
        ` tiers="${esc(tiers)}">\n` +
        (chart.meta.description || chart.meta.customer || chart.meta.tags.length
          ? `    <meta` +
            (chart.meta.customer ? ` customer="${esc(chart.meta.customer)}"` : '') +
            (chart.meta.priority ? ` priority="${esc(chart.meta.priority)}"` : '') +
            (chart.meta.budget ? ` budget="${esc(chart.meta.budget)}"` : '') +
            (chart.meta.tags.length ? ` tags="${esc(chart.meta.tags.join(', '))}"` : '') +
            (chart.meta.description ? `>${esc(chart.meta.description)}</meta>\n` : '/>\n')
          : '') +
        rows +
        '  </chart>\n'
      );
    })
    .join('');

  const artifacts = Object.values(ws.artifacts)
    .map(
      (a) =>
        `    <deliverable name="${esc(a.name)}" type="${esc(a.type)}"` +
        (a.description ? `>${esc(a.description)}</deliverable>\n` : '/>\n'),
    )
    .join('');

  const entities = Object.values(ws.entities)
    .map(
      (e) =>
        `    <entity name="${esc(e.name)}" kind="${esc(e.kind)}"` +
        (e.short ? ` short="${esc(e.short)}"` : '') +
        '/>\n',
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<raci generated="${esc(generated)}"` +
    (opts.generatedBy ? ` generatedBy="${esc(opts.generatedBy)}"` : '') +
    '>\n' +
    body +
    (artifacts ? `  <deliverables>\n${artifacts}  </deliverables>\n` : '') +
    (entities ? `  <entities>\n${entities}  </entities>\n` : '') +
    '</raci>\n'
  );
}
