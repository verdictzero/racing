<template>
  <Teleport to="body">
    <!-- index.html's openSubflowPickerPopover: point a nested-flow box at a different flow — also the
         repair for a box whose flow is gone. -->
    <div v-if="target" ref="el" class="org-popover flow-popover" :style="pos" @click="onClick">
      <div class="op-group">Point this box at…</div>
      <template v-if="cands.length">
        <button v-for="b in cands" :key="b.id" class="op-item" :data-sub-ref="b.id">⧉ {{ b.name || 'Untitled' }} <span
          class="fp-meta">{{ steps(b) }} step{{ steps(b) === 1 ? '' : 's' }}</span></button>
      </template>
      <div v-else class="op-empty">No other flow can be nested here without closing a loop.</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * The nested-flow box's "point it at…" popover. It shares index.html's single open-popover slot
 * (useFlowScreen().popover, kind 'repoint') with the three the chrome draws, so opening any one of
 * them closes the others, as there. Placed by the source's placePopover: under the anchor, centred,
 * kept on screen, flipped above when it would run off the bottom.
 */
import { embedWouldCycle, flowsInOrder, type Flow } from '@raci/core';
import { LOCAL_ORIGIN, deleteEdge, setStepField } from '@raci/crdt';
import { edgesOf } from '~/composables/flow-canvas/model';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const session = useWorkspaceSession();
const { popover } = useFlowScreen();
const { refuseLockedEdit } = useLock();

const target = computed(() => {
  const p = popover.value;
  return p?.kind === 'repoint' && props.flow?.steps[p.taskId] ? p : null;
});
/** Every flow but this one that could be nested here without closing a loop, in the flows' order. */
const cands = computed(() => {
  const host = props.flow;
  if (!host || !target.value) return [];
  const ws = session.workspace.value;
  return flowsInOrder(ws).filter((b) => b.id !== host.id && !embedWouldCycle(ws, host.id, b.id));
});
const steps = (b: Flow) => Object.keys(b.steps).length;

// ---- placement (placePopover) ----
const el = ref<HTMLElement | null>(null);
const at = ref<{ top: number; left: number } | null>(null);
watch(target, async (p) => {
  at.value = null;
  if (!p) return;
  await nextTick();
  const pr = el.value?.getBoundingClientRect();
  if (!pr) return;
  const r = p.anchor;
  let top = r.bottom + 4 + window.scrollY;
  let left = r.left + r.width / 2 - pr.width / 2 + window.scrollX;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  if (top + pr.height > window.scrollY + window.innerHeight - 8) top = Math.max(8 + window.scrollY, r.top - pr.height - 4 + window.scrollY);
  at.value = { top, left };
}, { immediate: true });
const pos = computed((): Record<string, string> => (at.value
  ? { top: `${at.value.top}px`, left: `${at.value.left}px` }
  : { top: '0px', left: '0px', visibility: 'hidden' }));

/** A flow picked: the box points there, all ports exposed, and handoffs that used the old ports go. */
function onClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLElement>('[data-sub-ref]');
  if (!btn) return;
  e.stopPropagation();
  const p = target.value, host = props.flow;
  popover.value = null;
  if (!p || !host || !props.canEdit) return;
  const taskId = p.taskId;
  if (!host.steps[taskId]) return;
  if (host.status === 'final') {
    refuseLockedEdit('flow', `“${host.name || 'Untitled'}” is Final — that change was rolled back. Reopen it as a draft to edit it.`);
    return;
  }
  const doc = session.doc;
  doc.transact(() => {
    setStepField(doc, taskId, 'refId', btn.dataset.subRef!);
    setStepField(doc, taskId, 'ports', { in: [], out: [] });
    for (const ed of edgesOf(host)) {
      if ((ed.from === taskId && ed.fromPort) || (ed.to === taskId && ed.toPort)) deleteEdge(doc, ed.id);
    }
  }, LOCAL_ORIGIN);
}

// Dismissal is the chrome's (components/flow/Popovers.vue): it closes whichever popover holds the one
// slot — this one included — by index.html's rules for Escape and for the clicks that leave it open.
</script>
