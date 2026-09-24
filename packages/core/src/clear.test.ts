import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { anchoredVariant } from './__fixtures__/parity-variants.js';
import { ACTORS, ACTOR_LABELS_DEFAULT, COL_LABELS_DEFAULT } from './constants.js';
import { importLegacy } from './legacy.js';
import { clearedWorkspace } from './clear.js';

describe('Clear', () => {
  const { workspace } = importLegacy(demo);

  it('leaves exactly one blank chart, in a tab of its own', () => {
    const cleared = clearedWorkspace(workspace);
    const charts = Object.values(cleared.charts);
    expect(charts).toHaveLength(1);
    const [chart] = charts;
    expect(chart!.title).toBe('Untitled chart');
    expect(chart!.custom).toBeNull();
    expect(chart!.status).toBe('draft');
    expect(chart!.nodes).toEqual({});
    // A new chart, not the old one emptied: nothing that pointed at the old id can reach it.
    expect(workspace.charts[chart!.id]).toBeUndefined();
    expect(Object.keys(cleared.chartOrder)).toEqual([chart!.id]);
  });

  it('empties the roster down to the six directorates, and every entity with it', () => {
    const cleared = clearedWorkspace(workspace);
    expect(Object.keys(cleared.roster).sort()).toEqual([...ACTORS].sort());
    for (const actor of ACTORS) {
      expect(cleared.roster[actor]).toEqual({ lead: null, externalId: null, divisions: [] });
    }
    expect(cleared.entities).toEqual({});
  });

  it('keeps the task flows and the deliverables registry they point into', () => {
    const cleared = clearedWorkspace(workspace);
    expect(Object.keys(cleared.flows)).toEqual(Object.keys(workspace.flows));
    expect(cleared.artifacts).toEqual(workspace.artifacts);
    // The reason the registry stays: every surviving handoff still names a deliverable that exists.
    for (const flow of Object.values(cleared.flows)) {
      expect(flow.steps).toEqual(workspace.flows[flow.id]!.steps);
      for (const edge of Object.values(flow.edges)) {
        for (const id of edge.artifactIds) expect(cleared.artifacts[id]).toBeDefined();
      }
    }
  });

  it('turns an anchored flow standalone, and keeps a Chart-Linked step bind to re-point', () => {
    const { workspace: anchored } = importLegacy(anchoredVariant(demo));
    const cleared = clearedWorkspace(anchored);
    for (const flow of Object.values(cleared.flows)) {
      expect(flow.anchor).toBeNull();
      expect(flow.sourceChartId).toBeNull();
    }
    const bound = Object.values(cleared.flows)
      .flatMap((f) => Object.values(f.steps))
      .filter((s) => s.bind);
    expect(bound.length).toBeGreaterThan(0);
  });

  it('puts the labels and the column map back to their defaults', () => {
    const renamed = {
      ...workspace,
      actorLabels: { ...workspace.actorLabels, ocio: 'MY DIRECTORATE' },
      columnLabels: { ...workspace.columnLabels, hq: 'The Boss' },
      columnActor: { hq: 'ocio' },
    };
    const cleared = clearedWorkspace(renamed);
    expect(cleared.actorLabels).toEqual(ACTOR_LABELS_DEFAULT);
    expect(cleared.columnLabels).toEqual(COL_LABELS_DEFAULT);
    expect(cleared.columnActor).toEqual({
      mission: 'mission',
      infra: 'infra',
      cyber: 'cyber',
      sw: 'sw',
    });
  });

  it('does not touch the workspace it was given', () => {
    const before = JSON.stringify(workspace);
    clearedWorkspace(workspace);
    expect(JSON.stringify(workspace)).toBe(before);
  });
});
