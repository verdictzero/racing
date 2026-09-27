/**
 * What index.html says after a chart row or a whole chart is deleted — its deleteNode and deleteChart
 * both end with detachFlowsFrom (flows anchored to what went became standalone) and then
 * warnStrandedBinds (Chart-Linked steps left pointing at nothing, which unlike an anchor are never
 * dropped silently). Call it AFTER the delete, with the count the delete's detach returned.
 */
import type * as Y from 'yjs';
import { createLintContext, flowsInOrder, stepsInOrder } from '@raci/core';
import { readWorkspace } from '@raci/crdt';
import type { ToastType } from '~/composables/useShell';

export function announceDeleteFallout(
  doc: Y.Doc,
  detached: number,
  toast: (message: string, type?: ToastType) => void,
): void {
  if (detached) toast(`${detached} attached flow${detached === 1 ? '' : 's'} became standalone (anchored task deleted).`, 'suggest');
  const ws = readWorkspace(doc);
  const lint = createLintContext(ws);
  let n = 0;
  const flows = new Set<string>();
  for (const f of flowsInOrder(ws)) {
    for (const t of stepsInOrder(f)) {
      if (t.kind !== 'subflow' && t.bind && !lint.bind(t)) { n++; flows.add(f.name || 'Untitled'); }
    }
  }
  if (n) {
    toast(`${n} flow step${n === 1 ? '' : 's'} in ${[...flows].join(', ')} ${n === 1 ? 'was' : 'were'} linked to what you just deleted — re-point ${n === 1 ? 'it' : 'them'} (⛓ on the card) or unlink.`, 'error');
  }
}
