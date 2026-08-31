/**
 * Where the lines on a flow canvas actually go.
 *
 * The canvas is the largest surface in the app and almost all of it is arithmetic: which socket an
 * edge attaches to, the curve between two sockets, which leg of a routed line a click landed on.
 * In `index.html` every one of those answers comes out of the DOM — `getBoundingClientRect`, CSS
 * selectors, live element measurement — so none of it can be tested without a browser, and the one
 * bug that mattered (edges drawn backwards) was invisible until someone looked at the screen.
 *
 * Here it is arithmetic over the model, with ONE measurement injected: a step card's height, which
 * is content-driven and genuinely only the renderer knows. Width is fixed at `STEP_WIDTH`. The
 * component measures, core computes, and the curves can be asserted on.
 */

import type { Flow, FlowEdge, FlowStep } from './schema.js';

/** The fixed card width, matching `.bz-node` in the legacy stylesheet. */
export const STEP_WIDTH = 220;

/** A fallback height, for a card that has not been measured yet. */
export const STEP_HEIGHT_FALLBACK = 84;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A step's rectangle on the canvas. Height comes from the renderer; the rest from the model. */
export interface StepBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BoxMap = ReadonlyMap<string, StepBox>;

/** Build boxes for every step, taking heights from whatever the renderer has measured so far. */
export function stepBoxes(
  flow: Flow,
  heights: ReadonlyMap<string, number> = new Map(),
): Map<string, StepBox> {
  const out = new Map<string, StepBox>();
  for (const step of Object.values(flow.steps)) {
    out.set(step.id, {
      x: step.x,
      y: step.y,
      width: STEP_WIDTH,
      height: heights.get(step.id) ?? STEP_HEIGHT_FALLBACK,
    });
  }
  return out;
}

/**
 * Where a line leaves or arrives on a card.
 *
 * Sockets sit at the vertical centre of the card and hang half outside it, which is why the offset
 * is applied rather than using the card edge: a line that stopped at the border would end under the
 * socket rather than at it.
 */
const SOCKET_OVERHANG = 1.5;

export function socketPoint(box: StepBox, side: 'in' | 'out'): Point {
  return {
    x: side === 'out' ? box.x + box.width + SOCKET_OVERHANG : box.x - SOCKET_OVERHANG,
    y: box.y + box.height / 2,
  };
}

/**
 * A cubic between two sockets, with horizontal tangents.
 *
 * The handle length grows with the horizontal gap so a long line bows gently and a short one does
 * not double back, and it never drops below 40 — at zero the curve degenerates into a straight
 * segment that leaves the socket at the wrong angle.
 */
export function edgePath(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`;
}

/**
 * The same line routed through its redirectors.
 *
 * Each leg is a curve in its own right, but the handles are aimed along the line THROUGH each
 * waypoint rather than horizontally, so consecutive legs leave and arrive at the same angle and the
 * joins read as one continuous cable instead of a row of separate hops. Handle length is capped
 * against the leg's own length, which is what stops a short leg between two far-apart ones from
 * looping back on itself.
 */
export function edgePathVia(from: Point, to: Point, via: readonly Point[]): string {
  if (via.length === 0) return edgePath(from, to);

  const points: Point[] = [from, ...via, to];
  // Endpoints stay horizontal — that is how a socket leaves a card. Interior points follow the
  // direction from the point before to the point after.
  const tangents = points.map((point, i) => {
    if (i === 0 || i === points.length - 1) return { x: 1, y: 0 };
    const before = points[i - 1]!;
    const after = points[i + 1]!;
    const vx = after.x - before.x;
    const vy = after.y - before.y;
    const length = Math.hypot(vx, vy) || 1;
    return { x: vx / length, y: vy / length };
  });

  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const leg = Math.hypot(q.x - p.x, q.y - p.y);
    // 0.42 of the leg gives the bow, floored at 12 so a tiny leg still curves rather than kinking,
    // capped at 120 so a very long one does not balloon — and then capped AGAIN at half the leg,
    // which is the part that matters and the part index.html gets wrong.
    //
    // Without that last clamp the 12px floor wins on any leg under ~28px: on a 10px leg between two
    // 500px ones the handles come out at 12, the first control point lands PAST the far end and the
    // second BEFORE the near one, and the curve visibly doubles back through the waypoint. The
    // legacy comment says the cap prevents this; its arithmetic does not.
    const handle = Math.min(Math.max(12, Math.min(leg * 0.42, 120)), leg * 0.5);
    const c1 = { x: p.x + tangents[i]!.x * handle, y: p.y + tangents[i]!.y * handle };
    const c2 = { x: q.x - tangents[i + 1]!.x * handle, y: q.y - tangents[i + 1]!.y * handle };
    d += ` C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${q.x} ${q.y}`;
  }
  return d;
}

/**
 * Which leg of a routed line a point is nearest — where a new redirector grabbed there belongs.
 *
 * Measured against the straight polyline through the waypoints rather than the drawn curve: the
 * curve is within a few pixels of it, and solving a cubic for nearest-point would be a great deal
 * of arithmetic to move an insertion index by one in a case nobody can see.
 */
export function viaInsertIndex(
  from: Point,
  to: Point,
  via: readonly Point[],
  at: Point,
): number {
  const points: Point[] = [from, ...via, to];
  let best = 0;
  let bestDistance = Infinity;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const lengthSquared = vx * vx + vy * vy;
    const t = lengthSquared
      ? Math.max(0, Math.min(1, ((at.x - a.x) * vx + (at.y - a.y) * vy) / lengthSquared))
      : 0;
    const distance = Math.hypot(at.x - (a.x + vx * t), at.y - (a.y + vy * t));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Which step an edge endpoint actually lands on.
 *
 * Not always the step the edge names, and each case exists for a reason the model deliberately does
 * NOT store:
 *
 *   - the step sits inside a COLLAPSED group → the group's own box, because the step is not on the
 *     canvas right now. The edge data is untouched; only where it lands moves. This is what gives a
 *     collapsed frame one mating point per boundary crossing instead of none.
 *   - anything else → the step's own box.
 *
 * Returns null when there is nothing to draw — most often both ends inside one collapsed group, an
 * internal handoff that is correctly invisible.
 */
export function endpointBox(
  flow: Flow,
  stepId: string,
  boxes: BoxMap,
  groupBoxes: BoxMap = new Map(),
): { box: StepBox; collapsedIn: string | null } | null {
  const step: FlowStep | undefined = flow.steps[stepId];
  if (!step) return null;

  const group = step.groupId ? flow.groups[step.groupId] : undefined;
  if (group?.collapsed) {
    const box = groupBoxes.get(group.id);
    return box ? { box, collapsedIn: group.id } : null;
  }

  const box = boxes.get(stepId);
  return box ? { box, collapsedIn: null } : null;
}

export interface EdgeGeometry {
  readonly edgeId: string;
  readonly from: Point;
  readonly to: Point;
  readonly via: Point[];
  readonly path: string;
  /** Midpoint of the drawn route, for hanging the label and the deliverable chips. */
  readonly labelAt: Point;
}

/**
 * The drawable geometry for one handoff, or null when it should not be drawn at all.
 *
 * Both ends inside one collapsed group is the null case: the handoff is internal to something the
 * reader has folded shut, and drawing it would put a line from a box to itself.
 */
export function edgeGeometry(
  flow: Flow,
  edge: FlowEdge,
  boxes: BoxMap,
  groupBoxes: BoxMap = new Map(),
): EdgeGeometry | null {
  const source = endpointBox(flow, edge.from, boxes, groupBoxes);
  const target = endpointBox(flow, edge.to, boxes, groupBoxes);
  if (!source || !target) return null;
  if (source.collapsedIn && source.collapsedIn === target.collapsedIn) return null;

  const from = socketPoint(source.box, 'out');
  const to = socketPoint(target.box, 'in');
  const via = edge.via.map((point) => ({ x: point.x, y: point.y }));

  return {
    edgeId: edge.id,
    from,
    to,
    via,
    path: edgePathVia(from, to, via),
    labelAt: midpointOf(from, to, via),
  };
}

/** The middle of the route, measured along the polyline rather than as a straight-line average. */
function midpointOf(from: Point, to: Point, via: readonly Point[]): Point {
  const points: Point[] = [from, ...via, to];
  const legs: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const length = Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
    legs.push(length);
    total += length;
  }
  if (total === 0) return from;

  let travelled = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    if (travelled + leg >= total / 2) {
      const t = leg === 0 ? 0 : (total / 2 - travelled) / leg;
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += leg;
  }
  return to;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

/** The extent of everything on the canvas. What "fit to screen" needs. */
export function flowBounds(boxes: Iterable<StepBox>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;

  for (const box of boxes) {
    seen = true;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!seen) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
