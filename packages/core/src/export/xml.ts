/**
 * The XML export — index.html's `exportXML`, out of the DOM.
 *
 * One chart, the tab in front of the person, as a `<raciTool>` document: its columns; its activity
 * tree, each row with its roster unit and its resolved responsibility line, and under each row the
 * flows anchored to it (steps in the order the flow runs, then the handoffs); then the chart's
 * metadata, the deliverable and entity registries and the roster. Anyone consuming this has scripts
 * written against what index.html writes, so this writes exactly that: the parity test holds it to
 * the legacy app's own output, byte for byte, for the demo and two variations of it.
 *
 * A pure function of the workspace, which is the point of moving it here: in index.html it reads
 * the active chart out of global state and ends in `download()`, so it only runs in a browser with
 * a chart open. Every word it prints comes from document-text.ts, the vocabulary the PowerPoint and
 * workbook ports share, so the documents cannot drift apart on what a row, a step or a party is
 * called.
 */

import { ACTORS, MAX_TIER } from '../constants.js';
import {
  artifactsInOrder,
  entitiesInOrder,
  entityDisplayName,
  entityDisplayShort,
} from '../registry.js';
import { childIndex, childrenIn } from '../tree.js';
import type { ChartNode, Flow, Workspace } from '../schema.js';
import {
  actorLabel,
  anchorContext,
  chartColumnTexts,
  deliverableName,
  deliverableUses,
  documentChart,
  documentTags,
  entityNamings,
  escapeHtml as esc,
  flowEdges,
  flowStepOrder,
  flowsAnchoredTo,
  freeFormShape,
  hasDocumentMeta,
  hasSignedStamp,
  orgText,
  passDown,
  printedLine,
  rowOrg,
  stepDeliverables,
  stepLinkText,
  stepPartiesText,
  stepRolesText,
} from './document-text.js';

export interface XmlExportOptions {
  /** The chart tab in front of the person — index.html's `ac()`. Absent or unknown: the first tab. */
  readonly chartId?: string;
}

/** An org chart's element per tier. A free-form chart's levels are user-named, so it uses levelN. */
const TIER_TAGS = ['portfolio', 'program', 'project', 'task'];

/** The chart in front as index.html's XML writes it. */
export function exportXml(ws: Workspace, opts: XmlExportOptions = {}): string {
  const chart = documentChart(ws, opts.chartId);
  const free = freeFormShape(chart) !== null;
  const columns = chartColumnTexts(ws, chart);
  const keys = columns.map((c) => c.key);
  const index = childIndex(chart.nodes);

  // Anchored flows nest under the row they implement — on an organization chart only.
  const anchored = new Map<string, Flow[]>();
  if (!free) {
    for (const flow of flowsAnchoredTo(ws, chart.id)) {
      const list = anchored.get(flow.anchor!.nodeId);
      if (list) list.push(flow);
      else anchored.set(flow.anchor!.nodeId, [flow]);
    }
  }

  const flowXml = (flow: Flow, pad: string): string => {
    const context = anchorContext(ws, flow);
    const nameOf = (id: string) => flow.steps[id]?.name || '?';
    const steps = flowStepOrder(flow)
      .map((step) => {
        const io = stepDeliverables(flow, step.id);
        const inner =
          io.inputs
            .map((id) => `${pad}    <input deliverable="${esc(deliverableName(ws, id))}"/>\n`)
            .join('') +
          io.outputs
            .map((id) => `${pad}    <output deliverable="${esc(deliverableName(ws, id))}"/>\n`)
            .join('');
        const link = stepLinkText(ws, flow, step, keys);
        const roles = stepRolesText(ws, flow, step, keys);
        const parties = stepPartiesText(ws, flow, context, step, keys);
        const open =
          `${pad}  <step name="${esc(step.name)}"` +
          (step.description ? ` description="${esc(step.description)}"` : '') +
          (link ? ` linkedRow="${esc(link)}"` : '') +
          (step.entry ? ` entry="${esc(step.entry)}"` : '') +
          (step.exit ? ` exit="${esc(step.exit)}"` : '') +
          (roles ? ` roles="${esc(roles)}"` : '') +
          (parties ? ` parties="${esc(parties)}"` : '');
        return inner ? `${open}>\n${inner}${pad}  </step>\n` : `${open}/>\n`;
      })
      .join('');
    const handoffs = flowEdges(flow)
      .map(
        (e) =>
          `${pad}  <handoff from="${esc(nameOf(e.from))}" to="${esc(nameOf(e.to))}"` +
          (e.label ? ` condition="${esc(e.label)}"` : '') +
          (e.artifactIds.length
            ? ` deliverables="${esc(e.artifactIds.map((id) => deliverableName(ws, id)).join(', '))}"`
            : '') +
          '/>\n',
      )
      .join('');
    return (
      `${pad}<flow name="${esc(flow.name)}" status="${esc(flow.status)}" mode="${esc(flow.mode)}"` +
      (hasSignedStamp(flow) ? ` finalized="${esc(flow.finalizedAt)}"` : '') +
      `>\n${steps}${handoffs}${pad}</flow>\n`
    );
  };

  // A row, then its children, then the flows anchored to it. An org chart ends at its fourth tier,
  // as the legacy loader cuts it.
  const lastTier = free ? Number.POSITIVE_INFINITY : MAX_TIER;
  const nodeXml = (
    node: ChartNode,
    depth: number,
    inherited: string | null,
    pad: string,
  ): string => {
    const line = printedLine(node, inherited, keys);
    const raci = keys
      .filter((k) => line[k])
      .map((k) => ` ${k}="${line[k]}"`)
      .join('');
    const org = orgText(ws, rowOrg(chart, node));
    const tag = free ? `level${depth + 1}` : (TIER_TAGS[depth] ?? `level${depth}`);
    const open = `${pad}<${tag} name="${esc(node.name)}"${org ? ` org="${esc(org.full)}"` : ''}${raci}`;
    const down = passDown(node, inherited, keys);
    const children = depth < lastTier ? childrenIn(index, node.id) : [];
    const inner =
      children.map((child) => nodeXml(child, depth + 1, down, `${pad}  `)).join('') +
      (anchored.get(node.id) ?? []).map((flow) => flowXml(flow, `${pad}  `)).join('');
    return inner ? `${open}>\n${inner}${pad}</${tag}>\n` : `${open}/>\n`;
  };

  const cols = columns
    .map((c) => `    <column key="${c.key}" label="${esc(c.label)}"/>`)
    .join('\n');
  const acts = childrenIn(index, null)
    .map((root) => nodeXml(root, 0, null, '    '))
    .join('');

  const meta = chart.meta;
  const tags = documentTags(meta);
  const metaSection = hasDocumentMeta(meta)
    ? `  <meta` +
      (meta.customer ? ` customer="${esc(meta.customer)}"` : '') +
      (meta.priority ? ` priority="${esc(meta.priority)}"` : '') +
      (meta.budget ? ` budget="${esc(meta.budget)}"` : '') +
      (tags.length ? ` tags="${esc(tags.join(', '))}"` : '') +
      `>${esc(meta.description)}</meta>\n`
    : '';

  // The two registries are global, so every chart's XML carries them.
  const uses = deliverableUses(ws);
  const artifacts = artifactsInOrder(ws);
  const artifactsSection = artifacts.length
    ? `  <artifacts>\n${artifacts
        .map((a) => {
          const producers = uses.get(a.id)?.producers ?? [];
          const consumers = uses.get(a.id)?.consumers ?? [];
          return (
            `    <artifact name="${esc(a.name || 'Untitled deliverable')}" type="${esc(a.type)}"` +
            (producers.length ? ` producers="${esc(producers.join(', '))}"` : '') +
            (consumers.length ? ` consumers="${esc(consumers.join(', '))}"` : '') +
            '/>'
          );
        })
        .join('\n')}\n  </artifacts>\n`
    : '';

  const entities = entitiesInOrder(ws);
  const namings = entityNamings(ws);
  const entitiesSection = entities.length
    ? `  <entities>\n${entities
        .map((e) => {
          const named = namings.get(e.id) ?? [];
          return (
            `    <entity name="${esc(entityDisplayName(e))}" kind="${esc(e.kind)}" short="${esc(entityDisplayShort(e))}"` +
            (e.lead?.name ? ` lead="${esc(e.lead.name)}"` : '') +
            (e.description ? ` description="${esc(e.description)}"` : '') +
            (named.length
              ? ` namedBy="${esc(named.map((u) => `${u.where} › ${u.name}`).join('; '))}"`
              : '') +
            '/>'
          );
        })
        .join('\n')}\n  </entities>\n`
    : '';

  // The roster is an organization chart's: a free-form chart's parties are not directorates.
  const rosterSection = free ? '' : `  <roster>\n${rosterXml(ws)}\n  </roster>\n`;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<raciTool title="${esc(chart.title || 'RACI')}" status="${esc(chart.status)}"` +
    (hasSignedStamp(chart) ? ` finalized="${esc(chart.finalizedAt)}"` : '') +
    '>\n' +
    `  <columns>\n${cols}\n  </columns>\n` +
    `  <activities>\n${acts}  </activities>\n` +
    metaSection +
    artifactsSection +
    entitiesSection +
    rosterSection +
    '</raciTool>\n'
  );
}

/** Every directorate, down to its people — each unit's lead or chief as an attribute when named. */
function rosterXml(ws: Workspace): string {
  const named = (attr: string, lead: { readonly name: string } | null | undefined) =>
    lead?.name ? ` ${attr}="${esc(lead.name)}"` : '';
  // An element whose children go on their own lines, closed on its own line at its own indent —
  // or, with none, closed straight after it opens.
  const wrap = (children: string, pad: string) => (children ? `\n${children}\n${pad}` : '');
  return ACTORS.map((actor) => {
    const directorate = ws.roster[actor];
    const divisions = (directorate?.divisions ?? [])
      .map((division) => {
        const branches = division.branches
          .map((branch) => {
            const teams = branch.teams
              .map((team) => {
                const people = team.people
                  .map((p) => `            <person name="${esc(p.name)}" title="${esc(p.title)}"/>`)
                  .join('\n');
                return `          <team name="${esc(team.name)}"${named('chief', team.chief)}>${wrap(people, '          ')}</team>`;
              })
              .join('\n');
            return `        <branch name="${esc(branch.name)}"${named('chief', branch.chief)}>${wrap(teams, '        ')}</branch>`;
          })
          .join('\n');
        return `      <division name="${esc(division.name)}"${named('chief', division.chief)}>${wrap(branches, '      ')}</division>`;
      })
      .join('\n');
    return `    <directorate key="${actor}" label="${esc(actorLabel(ws, actor))}"${named('lead', directorate?.lead)}>${wrap(divisions, '    ')}</directorate>`;
  }).join('\n');
}
