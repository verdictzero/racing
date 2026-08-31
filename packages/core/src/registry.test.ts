import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import {
  artifactRefCount,
  computeArtifactUses,
  computeEntityUses,
  filterObjects,
  objectRegistry,
  objectSearchText,
  orphanArtifacts,
  terminalArtifacts,
  walkChartRows,
} from './registry.js';
import { artifactTypeMeta, entityKindMeta, ARTIFACT_TYPES, ENTITY_KINDS } from './constants.js';

const { workspace } = importLegacy(demo);
const tabletopId = Object.entries(workspace.flows).find(([, f]) => /Tabletop/.test(f.name))![0];

describe('the reverse indexes', () => {
  it('finds where a deliverable comes from and goes', () => {
    const uses = computeArtifactUses(workspace);
    const triage = Object.values(workspace.artifacts).find((a) => a.name === 'Triage Report')!;
    const entry = uses.get(triage.id)!;
    expect(entry.producers.length).toBeGreaterThan(0);
    expect(entry.consumers.length).toBeGreaterThan(0);
    expect(entry.producers[0]!.where).toMatch(/Tabletop/);
  });

  it('counts references for the delete guard', () => {
    const uses = computeArtifactUses(workspace);
    const triage = Object.values(workspace.artifacts).find((a) => a.name === 'Triage Report')!;
    expect(artifactRefCount(uses, triage.id)).toBeGreaterThan(0);
    expect(artifactRefCount(uses, 'a_never_used')).toBe(0);
  });

  it('finds where an entity is named', () => {
    const ws = structuredClone(workspace);
    const entity = Object.values(ws.entities)[0]!;
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.parties = { hq: { entityId: entity.id } };

    const uses = computeEntityUses(ws, entity.id);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.kind).toBe('flowStep');
    expect(uses[0]!.where).toMatch(/Tabletop/);
  });

  it('counts a step naming an entity in two columns once, not twice', () => {
    const ws = structuredClone(workspace);
    const entity = Object.values(ws.entities)[0]!;
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.parties = { hq: { entityId: entity.id }, cos: { entityId: entity.id } };
    expect(computeEntityUses(ws, entity.id)).toHaveLength(1);
  });

  it('reports an entity nothing names', () => {
    expect(computeEntityUses(workspace, 'ent_nobody')).toEqual([]);
  });
});

describe('the object registry', () => {
  const objects = objectRegistry(workspace);

  it('flattens both registries into one shape', () => {
    expect(objects.filter((o) => o.kind === 'deliverable')).toHaveLength(4);
    expect(objects.filter((o) => o.kind === 'entity')).toHaveLength(2);
  });

  it('is sorted by name, so the gallery is stable', () => {
    const names = objects.map((o) => o.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('resolves each object’s uses', () => {
    const triage = objects.find((o) => o.name === 'Triage Report')!;
    expect(triage.uses.length).toBeGreaterThan(0);
  });

  it('filters by kind and by text across every indexed field', () => {
    expect(filterObjects(objects, { kind: 'entity' })).toHaveLength(2);
    // Two hits, and both are right: the deliverable named "Triage Report", and the vendor whose
    // description says it triages. Matching the description is the point.
    expect(filterObjects(objects, { query: 'triage' }).map((o) => o.name).sort()).toEqual([
      'Managed SOC Vendor',
      'Triage Report',
    ]);
    // Matches the description, not just the name.
    expect(filterObjects(objects, { query: 'blast radius' })[0]!.name).toBe('Containment Scope');
    expect(filterObjects(objects, { query: 'nothing matches this' })).toHaveLength(0);
  });

  it('lists deliverables nothing points at as an annotation, not a violation', () => {
    const ws = structuredClone(workspace);
    ws.artifacts['a_lonely'] = {
      id: 'a_lonely', name: 'Unused Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    expect(orphanArtifacts(ws).map((a) => a.name)).toContain('Unused Report');
  });
});

describe('the use list the detail pane prints', () => {
  const objects = objectRegistry(workspace);

  it('says HOW each place uses it, not just that it does', () => {
    const triage = objects.find((o) => o.name === 'Triage Report')!;
    const verbs = new Set(triage.uses.map((u) => u.verb));
    expect(verbs.has('produced by')).toBe(true);
    expect(verbs.has('consumed by')).toBe(true);
  });

  it('leads with producers — "where does this come from" is asked first', () => {
    const triage = objects.find((o) => o.name === 'Triage Report')!;
    expect(triage.uses[0]!.verb).toBe('produced by');
    const firstConsumer = triage.uses.findIndex((u) => u.verb === 'consumed by');
    const lastProducer = triage.uses.map((u) => u.verb).lastIndexOf('produced by');
    expect(lastProducer).toBeLessThan(firstConsumer);
  });

  it('counts a step that carries it away on two handoffs as one producer', () => {
    // "Detect & Triage" puts the Triage Report on both of its outgoing branches. It produces the
    // report ONCE, however many lines carry it away — listing the step twice would read as two
    // producers, which is exactly the question this pane exists to answer correctly.
    const flow = workspace.flows[tabletopId]!;
    const detect = Object.values(flow.steps).find((s) => s.name === 'Detect & Triage')!;
    const carrying = Object.values(flow.edges).filter(
      (e) => e.from === detect.id && e.artifactIds.some((a) => workspace.artifacts[a]?.name === 'Triage Report'),
    );
    expect(carrying.length).toBeGreaterThan(1); // the fixture really does have the case

    const triage = objects.find((o) => o.name === 'Triage Report')!;
    const fromDetect = triage.uses.filter((u) => u.verb === 'produced by' && u.stepId === detect.id);
    expect(fromDetect).toHaveLength(1);
  });

  it('keeps both sites in the raw index — the collapse is presentation, not truth', () => {
    // Each site names a real, distinct handoff. Something that asks "which lines carry this?" needs
    // them, so the de-duplication happens in the registry and not in the index underneath it.
    const flow = workspace.flows[tabletopId]!;
    const detect = Object.values(flow.steps).find((s) => s.name === 'Detect & Triage')!;
    const triage = Object.values(workspace.artifacts).find((a) => a.name === 'Triage Report')!;
    const raw = computeArtifactUses(workspace).get(triage.id)!.producers.filter((p) => p.stepId === detect.id);
    expect(raw.length).toBeGreaterThan(1);
    expect(new Set(raw.map((p) => p.edgeId)).size).toBe(raw.length);
  });

  it('names an entity’s uses "named by" — an entity is not produced', () => {
    const ws = structuredClone(workspace);
    const entity = Object.values(ws.entities)[0]!;
    const step = Object.values(ws.flows[tabletopId]!.steps).find((s) => s.kind === 'step')!;
    step.parties = { hq: { entityId: entity.id } };
    const found = objectRegistry(ws).find((o) => o.id === entity.id)!;
    expect(found.uses.map((u) => u.verb)).toEqual(['named by']);
  });
});

describe('the shared kind vocabulary', () => {
  it('humanizes a deliverable’s type rather than printing the enum', () => {
    const objects = objectRegistry(workspace);
    const triage = objects.find((o) => o.name === 'Triage Report')!;
    expect(triage.typeLabel).toBe(artifactTypeMeta(triage.ref.type as string).label);
    expect(triage.typeLabel[0]).toBe(triage.typeLabel[0]!.toUpperCase());
  });

  it('covers every kind in both enums, so nothing renders as a raw key', () => {
    for (const t of ARTIFACT_TYPES) expect(artifactTypeMeta(t).label).toBeTruthy();
    for (const k of ENTITY_KINDS) expect(entityKindMeta(k).label).toBeTruthy();
  });

  it('falls back to Other for a value from a newer document', () => {
    expect(artifactTypeMeta('spreadsheet').label).toBe('Other');
    expect(entityKindMeta(null).label).toBe('Other');
  });

  it('gives each kind a distinct icon, so the cards are scannable', () => {
    const icons = ENTITY_KINDS.map((k) => entityKindMeta(k).icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('search and navigation helpers', () => {
  it('indexes name, type, short name and description together', () => {
    const objects = objectRegistry(workspace);
    const vendor = objects.find((o) => o.name === 'Managed SOC Vendor')!;
    const text = objectSearchText(vendor);
    expect(text).toBe(text.toLowerCase());
    expect(text).toContain('managed soc vendor');
    expect(text).toContain(vendor.typeLabel.toLowerCase());
  });

  it('walks chart rows in the order the tree shows them', () => {
    const rows = walkChartRows(workspace);
    expect(rows).toHaveLength(810);
    const chart = Object.values(workspace.charts)[0]!;
    // A parent is always listed before its children — that is what "the order the tree shows them"
    // means, and anything paging through rows depends on it.
    const at = new Map(rows.map((r, i) => [r.nodeId, i]));
    for (const node of Object.values(chart.nodes)) {
      if (!node.parentId) continue;
      expect(at.get(node.parentId)!).toBeLessThan(at.get(node.id)!);
    }
  });
});

describe('the two registry annotations', () => {
  const base = importLegacy(demo).workspace;

  const withArtifact = (id: string, wire: (ws: typeof base) => void) => {
    const ws = structuredClone(base);
    ws.artifacts[id] = {
      id, name: 'Post-Incident Report', type: 'document',
      ownerRef: null, description: '', doc: null,
    };
    wire(ws);
    return ws;
  };

  it('calls a deliverable nothing points at an orphan', () => {
    const ws = withArtifact('a_lonely', () => {});
    expect(orphanArtifacts(ws).map((a) => a.id)).toContain('a_lonely');
    expect(terminalArtifacts(ws).map((a) => a.id)).not.toContain('a_lonely');
  });

  it('calls a declared output that nothing takes terminal, not an orphan', () => {
    // The end of a process. A row says it produces this; nothing downstream declares it as an
    // input and no handoff carries it onward. Legitimate, and the commonest shape of all.
    const ws = withArtifact('a_final', (w) => {
      const chart = Object.values(w.charts)[0]!;
      const row = Object.keys(chart.nodes)[0]!;
      chart.nodes[row]!.outputs = ['a_final'];
    });
    expect(terminalArtifacts(ws).map((a) => a.id)).toContain('a_final');
    expect(orphanArtifacts(ws).map((a) => a.id)).not.toContain('a_final');
  });

  it('calls a deliverable something downstream takes neither', () => {
    const ws = withArtifact('a_passed', (w) => {
      const chart = Object.values(w.charts)[0]!;
      const [producer, consumer] = Object.keys(chart.nodes);
      chart.nodes[producer!]!.outputs = ['a_passed'];
      chart.nodes[consumer!]!.inputs = ['a_passed'];
    });
    expect(terminalArtifacts(ws).map((a) => a.id)).not.toContain('a_passed');
    expect(orphanArtifacts(ws).map((a) => a.id)).not.toContain('a_passed');
  });

  it('does not call a flow deliverable terminal — a handoff always has a receiver', () => {
    // Structural, and worth pinning: an artifact riding a handoff is consumed by that edge's
    // target step, so "terminal" is a question about DECLARED outputs, not about handoffs.
    const ws = withArtifact('a_carried', (w) => {
      const flow = Object.values(w.flows)[0]!;
      const edge = Object.values(flow.edges)[0]!;
      edge.artifactIds = [...edge.artifactIds, 'a_carried'];
    });
    expect(terminalArtifacts(ws).map((a) => a.id)).not.toContain('a_carried');
  });
});
