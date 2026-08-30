/**
 * The domain schema.
 *
 * Zod rather than bare TypeScript types, because every one of these crosses a trust boundary at
 * some point: a workspace loaded from a file someone emailed, a row read back out of Postgres, a
 * value pulled from a Yjs document that another client wrote, a record off an LDAP server. Types
 * alone would be a promise; a schema is a check.
 *
 * THE ONE STRUCTURAL DEPARTURE FROM THE LEGACY MODEL
 * The legacy chart nests: `chart.activities` is a recursive array, each node holding `children[]`.
 * Here a chart holds a FLAT map of nodes, each naming its `parentId` and carrying an `order` key
 * (see fractional.ts). Same tree, different storage — and the reason is concurrency:
 *
 *   - Nested arrays make a move a delete-plus-insert. Run two of those concurrently and you get a
 *     duplicated row or a lost one, with no way for a merge to tell which was meant.
 *   - Nesting also means the whole subtree is one value. Two people editing different rows under
 *     one parent are editing the same array, so they conflict for no reason.
 *   - Flat + parentId + order makes every edit a small, independent, commutative change: rename
 *     touches one field of one node, reparent touches two, and neither can collide with an edit
 *     to a sibling.
 *
 * `legacy.ts` converts between the two shapes in both directions, so saved files keep working and
 * exports stay byte-compatible with what the single-file app writes.
 */

import { z } from 'zod';
import {
  ACTORS,
  ALL_ROLE_LETTERS,
  ARTIFACT_TYPES,
  CHART_FRAMEWORKS,
  COLS,
  ENTITY_KINDS,
  FLOW_MODES,
  META_PRIORITIES,
  STATUSES,
} from './constants.js';
import { isOrderKey } from './fractional.js';

// ---- primitives ---------------------------------------------------------------------------------

export const OrderKey = z.string().refine(isOrderKey, {
  message: 'not a valid order key (base-62 digits, no trailing zero)',
});

/**
 * A cell's letters, normalized: known letters only, de-duplicated, in canonical display order.
 * Letters from OTHER frameworks are deliberately kept — an RASCI chart switched to RACI holds on
 * to its S until a person removes it, rather than losing data to a dropdown.
 */
export const RaciCell = z
  .string()
  .transform((s) => {
    const seen = new Set(s.toUpperCase().split(''));
    return ALL_ROLE_LETTERS.filter((r) => seen.has(r)).join('');
  })
  .pipe(z.string());

export const RaciCellInput = z.union([RaciCell, z.null(), z.undefined()]).transform((v) => v ?? '');

/**
 * Who a party is. Either a position in the roster tree — narrowing left to right, and only as far
 * as the author went — or a flat registry entity (a board, a vendor, a standing team).
 *
 * Containment is enforced: a branch without its division is meaningless, so the narrower ids are
 * dropped rather than kept as orphans.
 */
export const OrgRef = z.union([
  z.object({ entityId: z.string().min(1) }).strict(),
  z
    .object({
      actor: z.enum(ACTORS),
      divisionId: z.string().min(1).optional(),
      branchId: z.string().min(1).optional(),
      teamId: z.string().min(1).optional(),
    })
    .strict()
    .transform((r) => {
      // Silently drop anything hanging below a missing ancestor.
      if (!r.divisionId) return { actor: r.actor };
      if (!r.branchId) return { actor: r.actor, divisionId: r.divisionId };
      if (!r.teamId) return { actor: r.actor, divisionId: r.divisionId, branchId: r.branchId };
      return r;
    }),
]);
export type OrgRef = z.infer<typeof OrgRef>;

export const Meta = z.object({
  description: z.string().default(''),
  customer: z.string().default(''),
  priority: z.enum(META_PRIORITIES).default(''),
  budget: z.string().default(''),
  tags: z.array(z.string().min(1)).default([]),
});
export type Meta = z.infer<typeof Meta>;

/** Zod counterpart of the `Status` union in constants.ts (which owns the exported type name). */
export const StatusSchema = z.enum(STATUSES);

/**
 * File attachment metadata. The bytes never live here — they go to object storage keyed by this
 * id, exactly as the legacy app offloads them to IndexedDB. Keeping a base64 dataUrl in the
 * document would put megabytes into every CRDT update.
 */
export const DocRef = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  type: z.string().default(''),
  size: z.number().int().nonnegative().default(0),
});
export type DocRef = z.infer<typeof DocRef>;

// ---- registries ---------------------------------------------------------------------------------

export const Artifact = z.object({
  id: z.string().min(1),
  name: z.string().default('Untitled deliverable'),
  type: z.enum(ARTIFACT_TYPES).default('other'),
  ownerRef: OrgRef.nullable().default(null),
  description: z.string().default(''),
  doc: DocRef.nullable().default(null),
});
export type Artifact = z.infer<typeof Artifact>;

export const Lead = z.object({ id: z.string().min(1), name: z.string().default('') });

export const Entity = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  kind: z.enum(ENTITY_KINDS).default('other'),
  short: z.string().default(''),
  description: z.string().default(''),
  lead: Lead.nullable().default(null),
});
export type Entity = z.infer<typeof Entity>;

// ---- roster (what a directory sync writes into) --------------------------------------------------
// Four levels, fixed: directorate → division → branch → team → people. The shape is the org's, not
// ours, so the directory adapters map into it rather than the other way round.

export const Person = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  title: z.string().default(''),
  /** Stable id in the source directory (AD objectGUID, Entra id). Null for hand-entered people. */
  externalId: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
});
export type Person = z.infer<typeof Person>;

export const Team = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  chief: Lead.nullable().default(null),
  externalId: z.string().nullable().default(null),
  people: z.array(Person).default([]),
});

export const Branch = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  chief: Lead.nullable().default(null),
  externalId: z.string().nullable().default(null),
  teams: z.array(Team).default([]),
});

export const Division = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  chief: Lead.nullable().default(null),
  externalId: z.string().nullable().default(null),
  branches: z.array(Branch).default([]),
});

export const Directorate = z.object({
  lead: Lead.nullable().default(null),
  externalId: z.string().nullable().default(null),
  divisions: z.array(Division).default([]),
});

export const Roster = z.record(z.enum(ACTORS), Directorate);
export type Roster = z.infer<typeof Roster>;

// ---- charts ---------------------------------------------------------------------------------------

/** A free-form chart's own party column. Org charts use the global COLS instead. */
export const CustomCol = z.object({
  key: z.string().min(1),
  label: z.string().default('Party'),
  short: z.string().default(''),
});

export const ChartCustom = z.object({
  cols: z.array(CustomCol).default([]),
  /** Sparse level names by depth; a missing entry auto-names as "Level N". */
  tiers: z.array(z.string()).default([]),
});

export const ChartNode = z.object({
  id: z.string().min(1),
  chartId: z.string().min(1),
  /** null = a root row of the chart. */
  parentId: z.string().nullable(),
  order: OrderKey,
  name: z.string().default(''),
  /** Letters per column key. Column keys are the chart's, org or custom. */
  raci: z.record(z.string(), z.string()).default({}),
  /** Which R column cascades down when a row holds more than one. */
  primaryR: z.string().nullable().default(null),
  /** Roster position this row is assigned to. */
  org: OrgRef.nullable().default(null),
  description: z.string().default(''),
  documents: z.array(DocRef).default([]),
  /** Deliverable ids. Chart rows store boundary IO; flow steps derive theirs from edges. */
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
});
export type ChartNode = z.infer<typeof ChartNode>;

export const Chart = z.object({
  id: z.string().min(1),
  title: z.string().default('Untitled chart'),
  framework: z.enum(CHART_FRAMEWORKS).default('raci'),
  status: StatusSchema.default('draft'),
  finalizedAt: z.string().nullable().default(null),
  meta: Meta,
  /** null = organization chart (global columns, four fixed tiers). */
  custom: ChartCustom.nullable().default(null),
  /** Flat node map. See the header note for why this is not a nested tree. */
  nodes: z.record(z.string(), ChartNode).default({}),
});
export type Chart = z.infer<typeof Chart>;

// ---- flows -----------------------------------------------------------------------------------------

export const FlowBind = z.object({
  chartId: z.string().min(1),
  nodeId: z.string().min(1),
});

export const FlowStep = z.object({
  id: z.string().min(1),
  flowId: z.string().min(1),
  /** 'step' is an ordinary step; 'subflow' stands in for another whole flow. */
  kind: z.enum(['step', 'subflow']).default('step'),
  /** For kind==='subflow': the flow this box references. A reference, never a copy. */
  refId: z.string().nullable().default(null),
  name: z.string().default(''),
  description: z.string().default(''),
  entry: z.string().default(''),
  exit: z.string().default(''),
  x: z.number().default(0),
  y: z.number().default(0),
  groupId: z.string().nullable().default(null),
  raci: z.record(z.string(), z.string()).default({}),
  parties: z.record(z.string(), OrgRef).default({}),
  /** Chart row this step implements, in a Chart-Linked flow. */
  bind: FlowBind.nullable().default(null),
  /** For a subflow box: which of the referenced flow's entry/exit points are exposed as sockets. */
  ports: z.object({ in: z.array(z.string()), out: z.array(z.string()) }).default({ in: [], out: [] }),
});
export type FlowStep = z.infer<typeof FlowStep>;

export const Waypoint = z.object({ x: z.number(), y: z.number() });

export const FlowEdge = z.object({
  id: z.string().min(1),
  flowId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  fromPort: z.string().nullable().default(null),
  toPort: z.string().nullable().default(null),
  label: z.string().default(''),
  /** Deliverables carried on this handoff. */
  artifactIds: z.array(z.string()).default([]),
  /** Redirector waypoints — the route a person dragged this line along. */
  via: z.array(Waypoint).max(24).default([]),
});
export type FlowEdge = z.infer<typeof FlowEdge>;

export const FlowGroup = z.object({
  id: z.string().min(1),
  flowId: z.string().min(1),
  name: z.string().default(''),
  color: z.string().default('p'),
  collapsed: z.boolean().default(false),
  x: z.number().default(0),
  y: z.number().default(0),
});
export type FlowGroup = z.infer<typeof FlowGroup>;

export const Flow = z.object({
  id: z.string().min(1),
  name: z.string().default('Untitled business case'),
  meta: Meta,
  framework: z.literal('raci').default('raci'),
  mode: z.enum(FLOW_MODES).default('free'),
  sourceChartId: z.string().nullable().default(null),
  status: StatusSchema.default('draft'),
  finalizedAt: z.string().nullable().default(null),
  /** The chart task this whole flow hangs under, if any. */
  anchor: FlowBind.nullable().default(null),
  steps: z.record(z.string(), FlowStep).default({}),
  edges: z.record(z.string(), FlowEdge).default({}),
  groups: z.record(z.string(), FlowGroup).default({}),
});
export type Flow = z.infer<typeof Flow>;

// ---- the workspace ------------------------------------------------------------------------------------

export const Workspace = z.object({
  /** Schema version of this document. Bumped only by a migration that changes shape. */
  schemaVersion: z.literal(1).default(1),
  charts: z.record(z.string(), Chart).default({}),
  chartOrder: z.record(z.string(), OrderKey).default({}),
  flows: z.record(z.string(), Flow).default({}),
  artifacts: z.record(z.string(), Artifact).default({}),
  entities: z.record(z.string(), Entity).default({}),
  roster: Roster.default({}),
  /** Display overrides — a source workbook's own vocabulary survives the trip. */
  actorLabels: z.record(z.string(), z.string()).default({}),
  columnLabels: z.record(z.string(), z.string()).default({}),
  columnShort: z.record(z.string(), z.string()).default({}),
  /** Which roster unit stands behind each responsibility column. */
  columnActor: z.record(z.string(), z.string()).default({}),
});
export type Workspace = z.infer<typeof Workspace>;

/** The column keys a chart uses: its own if free-form, the global set otherwise. */
export function chartColumns(chart: Pick<Chart, 'custom'>): readonly string[] {
  return chart.custom ? chart.custom.cols.map((c) => c.key) : COLS;
}

/** Org charts stop at Task; free-form charts nest without limit. */
export function chartMaxDepth(chart: Pick<Chart, 'custom'>): number {
  return chart.custom ? Number.POSITIVE_INFINITY : 3;
}

export function emptyWorkspace(): Workspace {
  return Workspace.parse({});
}
