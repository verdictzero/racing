/**
 * The drill-down cascade — the chart screen's spine.
 *
 * A nested RACI is read by drilling: the Portfolio pane is on screen, you open a row, and a
 * Program pane appears in front of it showing that row's breakdown. `resolveCascade` turns a drill
 * path — a list of row ids from the top down — into the panes that stack.
 *
 * IT IS PURE, AND THAT IS THE POINT. In `index.html` this is tangled with the renderer and mutates
 * the chart's `drillPath` in place as a side effect of drawing. Here it takes a path and returns
 * panes plus the path it could actually honour, so a caller decides what to do about a stale one.
 *
 * THE DRILL PATH IS NOT DOCUMENT DATA. Which row YOU have open is a fact about your screen, not
 * about the org, and putting it in the shared document would mean one person's drilling yanking
 * everyone else's view. `index.html` already keeps it out of its undo signature for the same
 * reason. Keep it in component state.
 *
 * TWO THINGS CASCADE DOWN, and they are separate:
 *   - the OWNER COLUMN. Whoever does the work at one tier owns it at the next, so each drilled row
 *     contributes its primary doer column, and a row that designates none passes the ancestor's
 *     through unchanged rather than breaking the chain.
 *   - the ORG REF. A Program contributes its division, a Project its branch, to everything below —
 *     which is what lets a Task row show the unit it belongs to without restating it.
 */

import { framework } from './constants.js';
import { primaryDoerColumn } from './raci.js';
import { childIndex, childrenIn, type ChildIndex } from './tree.js';
import { chartColumns, chartMaxDepth, type Chart, type ChartNode, type OrgRef } from './schema.js';

/** The org context a pane inherits from the rows drilled through to reach it. */
export interface InheritedOrg {
  readonly division: OrgRef | null;
  readonly branch: OrgRef | null;
}

export interface CascadePane {
  /** Depth: 0 is the top pane. */
  readonly tier: number;
  /** The row this pane breaks down. Null for the top pane. */
  readonly parent: ChartNode | null;
  /** The rows shown, in order. */
  readonly rows: ChartNode[];
  /** Which of `rows` is drilled into, if any. */
  readonly openId: string | null;
  readonly inheritedOrg: InheritedOrg;
  /**
   * The column whose Accountable every row here inherits, from the cascade above.
   * Null in the top pane — nothing is above it to inherit from.
   */
  readonly inheritedOwnerColumn: string | null;
  /** True when rows here cannot be drilled further: the chart's depth limit. */
  readonly isLeafTier: boolean;
}

export interface Cascade {
  readonly panes: CascadePane[];
  /**
   * The drill path actually honoured — the caller's, minus any step that no longer resolves.
   *
   * A row can be deleted by someone else while you have it open, and a path pointing at it would
   * otherwise render an empty pane with a live breadcrumb. Compare it against what you passed in
   * and write it back to your local state when it differs.
   */
  readonly path: string[];
  /** True when a step was dropped — the row was deleted, or the path ran past the depth limit. */
  readonly trimmed: boolean;
}

/**
 * Build the pane stack for a drill path.
 *
 * Always returns at least the top pane, so a chart with no rows at all still renders something to
 * add the first row into.
 */
export function resolveCascade(chart: Chart, drillPath: readonly string[] = []): Cascade {
  const index: ChildIndex = childIndex(chart.nodes);
  const columns = chartColumns(chart);
  const fw = framework(chart.framework);
  const maxDepth = chartMaxDepth(chart);

  const panes: CascadePane[] = [];
  const honoured: string[] = [];

  let inheritedOwnerColumn: string | null = null;
  let parent: ChartNode | null = null;
  let rows = childrenIn(index, null);
  let tier = 0;
  let division: OrgRef | null = null;
  let branch: OrgRef | null = null;

  for (;;) {
    panes.push({
      tier,
      parent,
      rows: [...rows],
      openId: null,
      inheritedOrg: { division, branch },
      inheritedOwnerColumn,
      isLeafTier: tier >= maxDepth,
    });

    const wanted = drillPath[tier];
    if (wanted === undefined) break;
    // The depth limit is a property of the chart, not of the path: an org chart stops at Task and
    // continues into an anchored flow instead, while a free-form chart drills without limit.
    if (tier >= maxDepth) break;

    const node = rows.find((r) => r.id === wanted);
    if (!node) break;

    // Fill in the pane we just pushed, now that we know it is open.
    panes[panes.length - 1] = { ...panes[panes.length - 1]!, openId: node.id };
    honoured.push(node.id);

    // A ref naming a branch is a branch; one naming only a division is a division. Both keep
    // flowing down until something deeper replaces them.
    if (node.org && 'actor' in node.org) {
      if (node.org.branchId) branch = node.org;
      else division = node.org;
    }
    // A row that designates no primary doer passes the ancestor's owner column through unchanged,
    // rather than breaking the chain — the cascade continues from the last unambiguous row.
    inheritedOwnerColumn = primaryDoerColumn(node, columns, fw) ?? inheritedOwnerColumn;

    parent = node;
    rows = childrenIn(index, node.id);
    tier++;
  }

  return {
    panes,
    path: honoured,
    trimmed: honoured.length !== drillPath.length,
  };
}

/** The breadcrumb: the row names drilled through, top down. */
export function cascadeCrumbs(cascade: Cascade): Array<{ id: string; name: string; tier: number }> {
  return cascade.panes
    .filter((pane): pane is CascadePane & { parent: ChartNode } => pane.parent !== null)
    .map((pane) => ({
      id: pane.parent.id,
      name: pane.parent.name || '(untitled)',
      tier: pane.tier - 1,
    }));
}

/**
 * The drill path that opens `nodeId`, from the top down.
 *
 * What a "jump to this row" affordance needs — a violation pin, a search result, a link from the
 * Tasks lens. Returns the ancestors, not the row itself: opening a row means showing the pane its
 * PARENT breaks down, with that row marked open.
 */
export function pathToOpen(chart: Chart, nodeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([nodeId]);
  let current = chart.nodes[nodeId];
  while (current?.parentId) {
    if (seen.has(current.parentId)) break; // a merge can make a cycle; do not loop on one
    seen.add(current.parentId);
    const parent = chart.nodes[current.parentId];
    if (!parent) break;
    out.unshift(parent.id);
    current = parent;
  }
  return out;
}
