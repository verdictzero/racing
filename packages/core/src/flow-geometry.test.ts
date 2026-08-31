import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import {
  STEP_WIDTH,
  edgeGeometry,
  edgePath,
  edgePathVia,
  endpointBox,
  flowBounds,
  socketPoint,
  stepBoxes,
  viaInsertIndex,
  type Point,
  type StepBox,
} from './flow-geometry.js';

const { workspace } = importLegacy(demo);
const flowId = Object.entries(workspace.flows).find(([, f]) => /Tabletop/.test(f.name))![0];
const flow = workspace.flows[flowId]!;

const box = (x: number, y: number, height = 80): StepBox => ({ x, y, width: STEP_WIDTH, height });

/** Every coordinate pair in a path, control points included — for the simple assertions. */
function coords(path: string): Point[] {
  return [...path.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

interface Leg {
  start: Point;
  c1: Point;
  c2: Point;
  end: Point;
}

/**
 * The path parsed into its cubic legs.
 *
 * Needed because `coords` cannot tell a control point from an endpoint, and the two have opposite
 * expectations: endpoints march forward along the route, while a leg's second control point sits
 * deliberately BEFORE its endpoint.
 */
function legsOf(path: string): Leg[] {
  const numbers = coords(path);
  const legs: Leg[] = [];
  let start = numbers[0]!;
  for (let i = 1; i + 2 < numbers.length + 1; i += 3) {
    const c1 = numbers[i];
    const c2 = numbers[i + 1];
    const end = numbers[i + 2];
    if (!c1 || !c2 || !end) break;
    legs.push({ start, c1, c2, end });
    start = end;
  }
  return legs;
}

describe('sockets', () => {
  it('puts the out socket on the right edge and the in socket on the left, both centred', () => {
    const b = box(100, 200, 60);
    expect(socketPoint(b, 'out').x).toBeGreaterThan(b.x + b.width - 1);
    expect(socketPoint(b, 'in').x).toBeLessThan(b.x + 1);
    expect(socketPoint(b, 'out').y).toBe(230);
    expect(socketPoint(b, 'in').y).toBe(230);
  });

  it('follows the card height, because a taller card centres lower', () => {
    expect(socketPoint(box(0, 0, 60), 'out').y).toBe(30);
    expect(socketPoint(box(0, 0, 200), 'out').y).toBe(100);
  });

  it('builds a box per step from the model, with a fallback height until one is measured', () => {
    const boxes = stepBoxes(flow);
    expect(boxes.size).toBe(Object.keys(flow.steps).length);
    const [id, first] = [...boxes.entries()][0]!;
    expect(first.x).toBe(flow.steps[id]!.x);
    expect(first.width).toBe(STEP_WIDTH);
    expect(first.height).toBeGreaterThan(0);
  });

  it('uses a measured height when the renderer has one', () => {
    const id = Object.keys(flow.steps)[0]!;
    expect(stepBoxes(flow, new Map([[id, 137]])).get(id)!.height).toBe(137);
  });
});

describe('the curve between two sockets', () => {
  it('starts at the source and ends at the target', () => {
    const path = edgePath({ x: 10, y: 20 }, { x: 300, y: 90 });
    const points = coords(path);
    expect(points[0]).toEqual({ x: 10, y: 20 });
    expect(points[points.length - 1]).toEqual({ x: 300, y: 90 });
  });

  it('leaves and arrives horizontally, which is how a socket points', () => {
    const path = edgePath({ x: 0, y: 50 }, { x: 400, y: 150 });
    const [start, c1, c2, end] = coords(path);
    expect(c1!.y).toBe(start!.y); // first handle level with the source
    expect(c2!.y).toBe(end!.y); // second level with the target
    expect(c1!.x).toBeGreaterThan(start!.x); // and pointing forward
    expect(c2!.x).toBeLessThan(end!.x);
  });

  it('never collapses its handles, even when the two sockets are on top of each other', () => {
    // At zero the curve degenerates to a straight segment leaving the socket at the wrong angle.
    const [start, c1] = coords(edgePath({ x: 100, y: 0 }, { x: 100, y: 0 }));
    expect(c1!.x - start!.x).toBeGreaterThanOrEqual(40);
  });

  it('bows further apart for a longer run', () => {
    const near = coords(edgePath({ x: 0, y: 0 }, { x: 100, y: 0 }));
    const far = coords(edgePath({ x: 0, y: 0 }, { x: 1000, y: 0 }));
    expect(far[1]!.x - far[0]!.x).toBeGreaterThan(near[1]!.x - near[0]!.x);
  });

  it('draws a backwards handoff without flipping its ends', () => {
    // A rework loop runs right to left. The path still has to START at the source socket — an
    // exporter or renderer that swapped them would draw the arrow the wrong way round.
    const path = edgePath({ x: 500, y: 0 }, { x: 100, y: 0 });
    const points = coords(path);
    expect(points[0]).toEqual({ x: 500, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 100, y: 0 });
  });
});

describe('a line routed through redirectors', () => {
  it('is the plain curve when there are none', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 200, y: 40 };
    expect(edgePathVia(from, to, [])).toBe(edgePath(from, to));
  });

  it('passes through every waypoint, in order', () => {
    const via = [{ x: 100, y: 200 }, { x: 300, y: 200 }];
    const points = coords(edgePathVia({ x: 0, y: 0 }, { x: 400, y: 0 }, via));
    // Each waypoint is the endpoint of its leg: every fourth coordinate after the start.
    expect(points).toContainEqual({ x: 100, y: 200 });
    expect(points).toContainEqual({ x: 300, y: 200 });
    expect(points[points.length - 1]).toEqual({ x: 400, y: 0 });
  });

  it('emits one cubic per leg', () => {
    const via = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 50 }];
    const legs = [...edgePathVia({ x: 0, y: 0 }, { x: 400, y: 0 }, via).matchAll(/ C /g)];
    expect(legs).toHaveLength(via.length + 1);
  });

  it('caps each leg’s handles against that leg’s own length', () => {
    // The failure this prevents: a 10px leg between two 500px ones. With the handle scaled to the
    // line as a whole it comes out longer than the leg itself, the control point lands beyond the
    // far end, and the curve doubles back through the waypoint.
    const via = [{ x: 500, y: 0 }, { x: 510, y: 0 }];
    for (const leg of legsOf(edgePathVia({ x: 0, y: 0 }, { x: 1000, y: 0 }, via))) {
      const length = Math.hypot(leg.end.x - leg.start.x, leg.end.y - leg.start.y);
      expect(Math.hypot(leg.c1.x - leg.start.x, leg.c1.y - leg.start.y)).toBeLessThanOrEqual(length);
      expect(Math.hypot(leg.c2.x - leg.end.x, leg.c2.y - leg.end.y)).toBeLessThanOrEqual(length);
    }
  });

  it('marches forward through the waypoints without backtracking', () => {
    const via = [{ x: 500, y: 0 }, { x: 510, y: 0 }];
    const ends = legsOf(edgePathVia({ x: 0, y: 0 }, { x: 1000, y: 0 }, via)).map((l) => l.end.x);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
  });
});

describe('grabbing a line to add a redirector', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };

  it('inserts into the only leg when there are no waypoints yet', () => {
    expect(viaInsertIndex(from, to, [], { x: 200, y: 20 })).toBe(0);
  });

  it('picks the leg the point is actually nearest', () => {
    const via = [{ x: 200, y: 300 }];
    expect(viaInsertIndex(from, to, via, { x: 90, y: 140 })).toBe(0);
    expect(viaInsertIndex(from, to, via, { x: 310, y: 140 })).toBe(1);
  });

  it('measures to the segment, not to its endpoints', () => {
    // A point beside the middle of a long leg belongs to that leg, however far it sits from either
    // end of it.
    const via = [{ x: 200, y: 0 }];
    expect(viaInsertIndex(from, to, via, { x: 100, y: 400 })).toBe(0);
  });

  it('does not divide by zero on a leg of no length', () => {
    expect(() => viaInsertIndex(from, from, [], { x: 5, y: 5 })).not.toThrow();
  });
});

describe('where an endpoint lands', () => {
  const boxes = stepBoxes(flow);

  it('lands on the step itself in the ordinary case', () => {
    const id = Object.keys(flow.steps)[0]!;
    expect(endpointBox(flow, id, boxes)!.box.x).toBe(flow.steps[id]!.x);
    expect(endpointBox(flow, id, boxes)!.collapsedIn).toBeNull();
  });

  it('lands on the frame when the step is inside a collapsed one', () => {
    // The step is not on the canvas right now, so the line has to mate with the frame instead —
    // that is what gives a folded group one mating point per boundary crossing rather than none.
    const ws = structuredClone(workspace);
    const f = ws.flows[flowId]!;
    const [stepId] = Object.keys(f.steps);
    f.groups['g1'] = { id: 'g1', flowId: f.id, name: 'Folded', color: 'p', collapsed: true, x: 900, y: 900 };
    f.steps[stepId!]!.groupId = 'g1';

    const groupBoxes = new Map([['g1', box(900, 900, 40)]]);
    const landed = endpointBox(f, stepId!, stepBoxes(f), groupBoxes)!;
    expect(landed.box.x).toBe(900);
    expect(landed.collapsedIn).toBe('g1');
  });

  it('is null for a step that is not there', () => {
    expect(endpointBox(flow, 's_nope', boxes)).toBeNull();
  });
});

describe('a handoff’s drawable geometry', () => {
  const boxes = stepBoxes(flow);

  it('runs from the source’s out socket to the target’s in socket', () => {
    const edge = Object.values(flow.edges)[0]!;
    const geometry = edgeGeometry(flow, edge, boxes)!;
    expect(geometry.from).toEqual(socketPoint(boxes.get(edge.from)!, 'out'));
    expect(geometry.to).toEqual(socketPoint(boxes.get(edge.to)!, 'in'));
    expect(geometry.path.startsWith(`M ${geometry.from.x} ${geometry.from.y}`)).toBe(true);
  });

  it('resolves every handoff in the real demo flow', () => {
    for (const edge of Object.values(flow.edges)) {
      expect(edgeGeometry(flow, edge, boxes)).not.toBeNull();
    }
  });

  it('is not drawn at all when both ends are inside one collapsed frame', () => {
    // An internal handoff in a folded group is correctly invisible; drawing it would put a line
    // from a box to itself.
    const ws = structuredClone(workspace);
    const f = ws.flows[flowId]!;
    const edge = Object.values(f.edges)[0]!;
    f.groups['g1'] = { id: 'g1', flowId: f.id, name: 'Folded', color: 'p', collapsed: true, x: 0, y: 0 };
    f.steps[edge.from]!.groupId = 'g1';
    f.steps[edge.to]!.groupId = 'g1';

    const groupBoxes = new Map([['g1', box(0, 0, 40)]]);
    expect(edgeGeometry(f, edge, stepBoxes(f), groupBoxes)).toBeNull();
  });

  it('IS drawn when only one end is folded away', () => {
    const ws = structuredClone(workspace);
    const f = ws.flows[flowId]!;
    const edge = Object.values(f.edges)[0]!;
    f.groups['g1'] = { id: 'g1', flowId: f.id, name: 'Folded', color: 'p', collapsed: true, x: 0, y: 0 };
    f.steps[edge.from]!.groupId = 'g1';

    const groupBoxes = new Map([['g1', box(0, 0, 40)]]);
    expect(edgeGeometry(f, edge, stepBoxes(f), groupBoxes)).not.toBeNull();
  });

  it('hangs the label at the middle of the route, not the middle of the straight line', () => {
    // With a waypoint pulling the line far off-axis, the straight-line average sits nowhere near
    // the cable — the label would float in empty space.
    const ws = structuredClone(workspace);
    const f = ws.flows[flowId]!;
    const edge = Object.values(f.edges)[0]!;
    edge.via = [{ x: 0, y: 4000 }];
    const geometry = edgeGeometry(f, edge, stepBoxes(f))!;
    expect(geometry.labelAt.y).toBeGreaterThan(1000);
  });
});

describe('canvas bounds', () => {
  it('covers every card, including its width and height', () => {
    const bounds = flowBounds([box(100, 100, 50), box(400, 300, 90)])!;
    expect(bounds.minX).toBe(100);
    expect(bounds.minY).toBe(100);
    expect(bounds.maxX).toBe(400 + STEP_WIDTH);
    expect(bounds.maxY).toBe(390);
    expect(bounds.width).toBe(bounds.maxX - bounds.minX);
  });

  it('is null for an empty canvas, so "fit to screen" has something to refuse', () => {
    expect(flowBounds([])).toBeNull();
  });

  it('handles the real demo flow', () => {
    const bounds = flowBounds(stepBoxes(flow).values())!;
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });
});
