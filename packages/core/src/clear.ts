/**
 * What Clear leaves behind.
 *
 * index.html's Clear wipes every chart tab and every roster entry and leaves a single blank chart
 * ("Clear everything? This wipes every chart tab AND every roster entry — leaving a single blank
 * chart."). Two things survive it on purpose, and the reason for the second is the reason for the
 * first:
 *
 *   - the TASK FLOWS are kept — Clear is aimed at the chart and the org, not at the flows;
 *   - so the DELIVERABLES REGISTRY is kept too. Every handoff in a surviving flow names what it
 *     carries by deliverable id; emptying the registry would leave those flows with untyped
 *     handoffs pointing at nothing, which is the one state the registry exists to prevent.
 *
 * Entities go: they are roster entries in all but storage, and the prompt promises every roster
 * entry goes. The directorate names, the column labels and the column-to-directorate map return to
 * their defaults, as they do in index.html, whose Clear starts over from its default state.
 *
 * WHERE THIS DEPARTS FROM THE SOURCE'S CODE, deliberately: index.html builds its cleared state from
 * `defaultState()`, so the flows and deliverables it "keeps" are in fact the built-in demo's,
 * minted afresh — a person who built their own flows and pressed Clear gets the demo's back
 * instead. That contradicts both the prompt, which says nothing about flows, and the comment beside
 * the code, which says Clear keeps them. This keeps the workspace's OWN flows and deliverables.
 * For a workspace still holding the demo, as in the walkthrough, the two are indistinguishable.
 */

import {
  ACTORS,
  ACTOR_LABELS_DEFAULT,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  COLS,
} from './constants.js';
import { keyBetween } from './fractional.js';
import { newId } from './ids.js';
import { Chart, Workspace, type Flow } from './schema.js';

/**
 * Detach a flow from the charts that are going: its anchor and its preferred source chart would
 * name charts that no longer exist. index.html's loader drops exactly those two on the next load.
 *
 * Step binds are kept even though they now dangle. A bind is where a Chart-Linked step's line comes
 * FROM, so dropping it would quietly empty the step; the legacy keeps it and shows a broken link
 * the person can re-point, and so does this.
 */
function detached(flow: Flow): Flow {
  return { ...flow, anchor: null, sourceChartId: null };
}

/** The workspace Clear leaves: one blank chart, no roster, no entities, the flows and registry kept. */
export function clearedWorkspace(ws: Workspace): Workspace {
  const chart = Chart.parse({ id: newId('chart'), title: 'Untitled chart', meta: {} });

  const roster: Record<string, unknown> = {};
  for (const actor of ACTORS) roster[actor] = { lead: null, externalId: null, divisions: [] };

  const columnActor: Record<string, string> = {};
  for (const col of COLS) if ((ACTORS as readonly string[]).includes(col)) columnActor[col] = col;

  return Workspace.parse({
    schemaVersion: ws.schemaVersion,
    charts: { [chart.id]: chart },
    chartOrder: { [chart.id]: keyBetween(null, null) },
    flows: Object.fromEntries(Object.entries(ws.flows).map(([id, flow]) => [id, detached(flow)])),
    artifacts: ws.artifacts,
    entities: {},
    roster,
    actorLabels: { ...ACTOR_LABELS_DEFAULT },
    columnLabels: { ...COL_LABELS_DEFAULT },
    columnShort: { ...COL_SHORT_DEFAULT },
    columnActor,
  });
}
