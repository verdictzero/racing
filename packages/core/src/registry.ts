/**
 * The reverse indexes: where is this thing used?
 *
 * Two questions the app asks constantly and from three different places — the Object Gallery's
 * detail pane, the delete guard, and the rules engine. In `index.html` each of those computes its
 * own answer, which is three chances to disagree about whether a deliverable is still referenced.
 * Here it is computed once, from the workspace, and everything reads the same index.
 *
 * BOTH ARE DERIVED, NEVER STORED. A reference lives on the thing that makes it — a chart row's
 * `outputs`, a handoff's `artifactIds`, a step's `parties`. Keeping a count alongside would be a
 * second copy of the truth, and the copy is what goes stale.
 */

import { childIndex, childrenIn, walkInOrder } from './tree.js';
import { entityKindMeta } from './constants.js';
import { deriveShort } from './import/xlsx.js';
import type { Artifact, Chart, ChartNode, Entity, OrgRef, Workspace } from './schema.js';

/** Where a use was found, in terms a person recognizes. */
export interface UseSite {
  /** What kind of thing refers to it. */
  readonly kind: 'chartRow' | 'flowStep' | 'handoff' | 'deliverable' | 'roster';
  /** What it is called. */
  readonly name: string;
  /** Which chart or flow it sits in. */
  readonly where: string;
  /** Enough to navigate there. */
  readonly chartId?: string;
  readonly nodeId?: string;
  readonly flowId?: string;
  readonly stepId?: string;
  readonly edgeId?: string;
}

export interface ArtifactUses {
  /** Places that declare this deliverable as an output, or hand it on. */
  readonly producers: UseSite[];
  /** Places that declare it as an input, or receive it. */
  readonly consumers: UseSite[];
}

/** How a place uses the object, in the words the detail pane prints. */
export type UseVerb = 'produced by' | 'consumed by' | 'named by';

/** A use site with the relationship it stands in. What the gallery's "where is this used" lists. */
export interface UseRef extends UseSite {
  readonly verb: UseVerb;
}

// index.html's own fallbacks, because these names are printed: "from (untitled)" on a work card.
const rowName = (name: string) => name || '(untitled)';
const stepName = (name: string) => name || '(untitled step)';

/**
 * Charts in tab order — the order index.html keeps `state.charts` in, so anything listed from a walk
 * over the charts (a use list, a work lens) reads in the same order as the source's.
 */
export function chartsInTabOrder(ws: Workspace): Chart[] {
  return Object.keys(ws.charts)
    .sort((a, b) => {
      const oa = ws.chartOrder[a] ?? '';
      const ob = ws.chartOrder[b] ?? '';
      return oa === ob ? a.localeCompare(b) : oa < ob ? -1 : 1;
    })
    .map((id) => ws.charts[id]!);
}

/**
 * A registry's records in registry order: by `order` key, records without one (written before the
 * key existed) first and in the map's own order. That is the order the source's array held them
 * in — the order they were made — and it is the same on every client after every reload.
 */
function inRegistryOrder<T extends { id: string; order?: string }>(records: Readonly<Record<string, T>>): T[] {
  return Object.values(records)
    .map((record, i) => ({ record, i }))
    .sort((a, b) => {
      const ka = a.record.order, kb = b.record.order;
      if (ka === undefined && kb === undefined) return a.i - b.i;
      if (ka === undefined) return -1;
      if (kb === undefined) return 1;
      if (ka !== kb) return ka < kb ? -1 : 1;
      // Two people adding at the same instant can mint the same key; the id settles it the same
      // way on every client.
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
    })
    .map(({ record }) => record);
}

/** The deliverable registry in registry order (see `Artifact.order`). */
export function artifactsInOrder(ws: Pick<Workspace, 'artifacts'>): Artifact[] {
  return inRegistryOrder(ws.artifacts);
}

/** The entity registry in registry order (see `Artifact.order`). */
export function entitiesInOrder(ws: Pick<Workspace, 'entities'>): Entity[] {
  return inRegistryOrder(ws.entities);
}

/** Every chart's rows in the order the tree shows them, charts in tab order. */
function chartRowsInOrder(ws: Workspace): Array<{ chart: Chart; rows: ChartNode[] }> {
  return chartsInTabOrder(ws).map((chart) => ({ chart, rows: walkInOrder(chart.nodes, childIndex(chart.nodes)) }));
}

/**
 * Every producer and consumer of every deliverable, across all charts and flows.
 *
 * Computed in one pass and keyed by artifact id, because the callers want it for many artifacts at
 * once — the gallery lists ref-counts for the whole registry, and the rules engine checks every
 * input in the workspace. Each list is in the source's order: charts in tab order and rows in tree
 * order, then flows.
 */
export function computeArtifactUses(ws: Workspace): Map<string, ArtifactUses> {
  const index = new Map<string, ArtifactUses>();
  const bucket = (id: string): { producers: UseSite[]; consumers: UseSite[] } => {
    let entry = index.get(id) as { producers: UseSite[]; consumers: UseSite[] } | undefined;
    if (!entry) {
      entry = { producers: [], consumers: [] };
      index.set(id, entry);
    }
    return entry;
  };

  for (const { chart, rows } of chartRowsInOrder(ws)) {
    for (const node of rows) {
      const site = {
        kind: 'chartRow' as const,
        name: rowName(node.name),
        where: chart.title,
        chartId: chart.id,
        nodeId: node.id,
      };
      for (const id of node.outputs) bucket(id).producers.push(site);
      for (const id of node.inputs) bucket(id).consumers.push(site);
    }
  }

  for (const flow of Object.values(ws.flows)) {
    for (const edge of Object.values(flow.edges)) {
      if (edge.artifactIds.length === 0) continue;
      const from = flow.steps[edge.from];
      const to = flow.steps[edge.to];
      for (const id of edge.artifactIds) {
        // A handoff both produces (at its source) and consumes (at its target). Recording it as
        // one site at each end is what makes the gallery able to say "produced here, consumed
        // there" rather than just "referenced twice".
        if (from) {
          bucket(id).producers.push({
            kind: 'flowStep',
            name: stepName(from.name),
            where: flow.name,
            flowId: flow.id,
            stepId: from.id,
            edgeId: edge.id,
          });
        }
        if (to) {
          bucket(id).consumers.push({
            kind: 'flowStep',
            name: stepName(to.name),
            where: flow.name,
            flowId: flow.id,
            stepId: to.id,
            edgeId: edge.id,
          });
        }
      }
    }
  }

  return index;
}

/** How many places reference a deliverable at all. The number the delete guard needs. */
export function artifactRefCount(uses: Map<string, ArtifactUses>, artifactId: string): number {
  const entry = uses.get(artifactId);
  if (!entry) return 0;
  return entry.producers.length + entry.consumers.length;
}

function refersToEntity(ref: OrgRef | null | undefined, entityId: string): boolean {
  return !!ref && 'entityId' in ref && ref.entityId === entityId;
}

/**
 * Everywhere an entity is named as a party — index.html's `entityUses`.
 *
 * Unlike a deliverable, an entity CAN be deleted while in use — the legacy app's behaviour, kept
 * deliberately: an entity that no longer exists is a fact about the org, and refusing the delete
 * would not change it. Anything still naming it reads "(missing entity)" until re-pointed. So this
 * index feeds a warning on the delete rather than a block.
 *
 * One entry per NAMING, as the source counts them: a step that names the entity on two columns is
 * two entries, because it gave the entity two responsibilities. That is the number the gallery's
 * "3 uses" pill and the delete confirmation print.
 */
export function computeEntityUses(ws: Workspace, entityId: string): UseSite[] {
  const out: UseSite[] = [];

  for (const { chart, rows } of chartRowsInOrder(ws)) {
    for (const node of rows) {
      if (refersToEntity(node.org, entityId)) {
        out.push({
          kind: 'chartRow',
          name: rowName(node.name),
          where: chart.title || 'Untitled chart',
          chartId: chart.id,
          nodeId: node.id,
        });
      }
    }
  }

  for (const flow of Object.values(ws.flows)) {
    for (const step of Object.values(flow.steps)) {
      for (const ref of Object.values(step.parties)) {
        if (refersToEntity(ref, entityId)) {
          out.push({
            kind: 'flowStep',
            name: stepName(step.name),
            where: flow.name || 'Untitled flow',
            flowId: flow.id,
            stepId: step.id,
          });
        }
      }
    }
  }

  for (const artifact of artifactsInOrder(ws)) {
    if (refersToEntity(artifact.ownerRef, entityId)) {
      out.push({ kind: 'deliverable', name: artifact.name, where: 'Deliverables' });
    }
  }

  return out;
}

// ---- the unified registry, for the Object Gallery ------------------------------------------------

export type ObjectKind = 'deliverable' | 'entity';

/**
 * One shape for both registries.
 *
 * Deliverables and entities are the same kind of thing — a named noun with a stable id that charts
 * and flows reference rather than contain — so the gallery's cards, filter, facets and detail pane
 * are written once instead of twice.
 */
export interface RegistryObject {
  readonly id: string;
  readonly kind: ObjectKind;
  /** The display name, with the source's fallback ("Untitled deliverable", "Untitled entity"). */
  readonly name: string;
  /** A deliverable's type key (the card uppercases it), or an entity's kind label. */
  readonly typeLabel: string;
  /** Secondary line: an entity's short name, derived from its name when none is set. */
  readonly sub: string;
  readonly description: string;
  /** Every place that names it. A deliverable's are de-duplicated by (verb, place). */
  readonly uses: UseRef[];
  readonly ref: Artifact | Entity;
}

/**
 * One entry per (verb, place), in the order given.
 *
 * A deliverable riding two handoffs OUT of the same step is produced there ONCE, however many lines
 * carry it away. Listing the step twice would read as two producers — precisely the question this
 * pane exists to answer correctly. The raw index keeps both sites, because each names a real edge;
 * collapsing is a presentation decision and belongs here.
 */
function dedupe(verb: UseVerb, sites: readonly UseSite[], seen: Set<string>, into: UseRef[]): void {
  for (const site of sites) {
    const key = `${verb}\u0001${site.name}\u0001${site.chartId ?? site.flowId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push({ ...site, verb });
  }
}

/** An entity's display name — index.html's `entityName`. */
export function entityDisplayName(entity: Pick<Entity, 'name'>): string {
  return entity.name.trim() || 'Untitled entity';
}

/** An entity's short name, derived from its name when none was typed — `entityShort`. */
export function entityDisplayShort(entity: Pick<Entity, 'name' | 'short'>): string {
  return entity.short.trim() || deriveShort(entityDisplayName(entity));
}

/**
 * Both registries, flattened, with each object's uses resolved — index.html's `objRegistry`.
 *
 * In REGISTRY order, deliverables first and then entities, each in the order they were added: that
 * is the order the gallery shows, and the order a person who just made something expects to find
 * it in (at the end), rather than wherever its name happens to sort.
 */
export function objectRegistry(ws: Workspace): RegistryObject[] {
  const artifactUses = computeArtifactUses(ws);
  const out: RegistryObject[] = [];

  for (const artifact of artifactsInOrder(ws)) {
    const entry = artifactUses.get(artifact.id);
    const uses: UseRef[] = [];
    const seen = new Set<string>();
    // Producers first: "where does this come from" is the question people ask first.
    dedupe('produced by', entry?.producers ?? [], seen, uses);
    dedupe('consumed by', entry?.consumers ?? [], seen, uses);
    out.push({
      id: artifact.id,
      kind: 'deliverable',
      name: artifact.name || 'Untitled deliverable',
      typeLabel: artifact.type || 'other',
      sub: '',
      description: artifact.description,
      uses,
      ref: artifact,
    });
  }

  for (const entity of entitiesInOrder(ws)) {
    out.push({
      id: entity.id,
      kind: 'entity',
      name: entityDisplayName(entity),
      typeLabel: entityKindMeta(entity.kind).label,
      sub: entityDisplayShort(entity),
      description: entity.description,
      // Not de-duplicated: each naming is a responsibility given to it (see computeEntityUses).
      uses: computeEntityUses(ws, entity.id).map((site) => ({ ...site, verb: 'named by' as const })),
      ref: entity,
    });
  }

  return out;
}

/** Everything the gallery's filter box matches on. */
export function objectSearchText(object: RegistryObject): string {
  return [object.name, object.typeLabel, object.sub, object.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Filter the registry the way the gallery does. */
export function filterObjects(
  objects: RegistryObject[],
  opts: { kind?: ObjectKind | 'all'; query?: string } = {},
): RegistryObject[] {
  const query = (opts.query ?? '').trim().toLowerCase();
  return objects.filter((object) => {
    if (opts.kind && opts.kind !== 'all' && object.kind !== opts.kind) return false;
    if (query && !objectSearchText(object).includes(query)) return false;
    return true;
  });
}

/**
 * Deliverables nothing points at, in either direction.
 *
 * A registry entry that was created and then never wired up. Almost always a leftover, so the
 * gallery calls it out — but as an annotation and never a violation, because the moment before you
 * attach a new deliverable to a handoff is a legitimate state to be in.
 */
export function orphanArtifacts(ws: Workspace): Artifact[] {
  const uses = computeArtifactUses(ws);
  return artifactsInOrder(ws).filter((a) => artifactRefCount(uses, a.id) === 0);
}

/**
 * Deliverables something produces but nothing consumes.
 *
 * Distinct from an orphan, and the distinction is the whole point: an orphan is probably a mistake,
 * whereas a TERMINAL deliverable — the report at the end of the process that nothing downstream
 * takes — is what a process is usually FOR. So this is an annotation, never a violation. Flagging
 * these is the single easiest way to produce the warn-storm that makes people stop reading
 * warnings, which is why the rule engine deliberately does not.
 *
 * Worth surfacing anyway, because the reader can tell in one glance which of theirs are genuinely
 * final and which are a handoff someone forgot to draw.
 */
export function terminalArtifacts(ws: Workspace): Artifact[] {
  const uses = computeArtifactUses(ws);
  return artifactsInOrder(ws).filter((a) => {
    const entry = uses.get(a.id);
    return (entry?.producers.length ?? 0) > 0 && (entry?.consumers.length ?? 0) === 0;
  });
}

/** Chart rows in the order the tree shows them — for anything that lists rows across charts. */
export function walkChartRows(ws: Workspace): Array<{ chartId: string; nodeId: string; name: string }> {
  const out: Array<{ chartId: string; nodeId: string; name: string }> = [];
  for (const chart of Object.values(ws.charts)) {
    // One index per chart, not one scan per row: the flat model makes finding a parent's children
    // a pass over every node, so doing it inside the recursion is quadratic. See tree.ts.
    const index = childIndex(chart.nodes);
    const seen = new Set<string>();
    const visit = (nodeId: string) => {
      const node = chart.nodes[nodeId];
      if (!node || seen.has(nodeId)) return;
      seen.add(nodeId);
      out.push({ chartId: chart.id, nodeId, name: rowName(node.name) });
      for (const child of childrenIn(index, nodeId)) visit(child.id);
    };
    for (const root of childrenIn(index, null)) visit(root.id);
  }
  return out;
}
