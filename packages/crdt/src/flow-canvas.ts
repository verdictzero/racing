/**
 * The flow canvas's writes that mutations.ts does not already have — index.html's group frames
 * (bizGroupSelection, bizToggleGroupCollapse, bizCycleGroupColor, the frame's rename and its drag)
 * and a drag that moves several boxes at once.
 *
 * Same contract as every other mutation: one transaction each, tagged LOCAL_ORIGIN so undo stays
 * per person, and per-field writes so two people touching different fields of one frame or one
 * step never overwrite each other. A caller composing several of these into one gesture wraps them
 * in its own `doc.transact(…, LOCAL_ORIGIN)` — the outermost transaction's origin is what undo sees.
 */

import type * as Y from 'yjs';
import { FlowGroup, newId } from '@raci/core';
import { maps, setField, toYMap } from './doc.js';
import { LOCAL_ORIGIN, MutationError } from './mutations.js';

/** One field of a frame: its title, its colour key, whether it is folded shut, where it sits. */
export function setGroupField(
  doc: Y.Doc,
  groupId: string,
  field: 'name' | 'color' | 'collapsed' | 'x' | 'y',
  value: unknown,
): void {
  doc.transact(() => setField(maps(doc).groups, groupId, field, value), LOCAL_ORIGIN);
}

export interface FrameFields {
  readonly name: string;
  /** One of index.html's BZ_GROUP_COLORS keys — 'accent', 'p', 'c', 'a', 'd', 's', 'i'. */
  readonly color: string;
  /** Where the frame folds up to when it is collapsed; an expanded frame is drawn from its members. */
  readonly x: number;
  readonly y: number;
}

/**
 * index.html's bizGroupSelection: a new frame around `memberIds`, in one transaction. A step joins
 * the new frame and leaves whatever frame it was in — frames do not nest. Returns the frame's id.
 */
export function addGroupFrame(
  doc: Y.Doc,
  flowId: string,
  frame: FrameFields,
  memberIds: readonly string[],
): string {
  const m = maps(doc);
  if (!m.flows.has(flowId)) throw new MutationError(`no such flow: ${flowId}`);
  const id = newId('group');
  const group = FlowGroup.parse({
    id,
    flowId,
    name: frame.name,
    color: frame.color,
    collapsed: false,
    x: Math.round(frame.x),
    y: Math.round(frame.y),
  });
  doc.transact(() => {
    m.groups.set(id, toYMap(group));
    for (const stepId of memberIds) {
      const step = m.steps.get(stepId);
      if (step) step.set('groupId', id);
    }
  }, LOCAL_ORIGIN);
  return id;
}

/**
 * Put several boxes down at once — the end of a drag that carried the whole selection, or a frame
 * and everything in it. x and y stay separate fields (see moveStep), rounded as index.html rounds
 * them, and the whole drop is one step of undo.
 */
export function moveSteps(
  doc: Y.Doc,
  moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
): void {
  doc.transact(() => {
    const m = maps(doc);
    for (const { id, x, y } of moves) {
      if (!m.steps.has(id)) continue;
      setField(m.steps, id, 'x', Math.round(x));
      setField(m.steps, id, 'y', Math.round(y));
    }
  }, LOCAL_ORIGIN);
}
