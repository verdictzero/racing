<template>
  <!-- index.html's renderBizcase, element for element. The chrome around the canvas is its own
       components (components/flow/*); the canvas — #bz-canvas and everything in it — is
       components/flow/canvas/Surface.vue. The two share their view state through
       composables/useFlowScreen.ts. -->
  <div class="ws-page">
    <div class="bz-wrap">
      <FlowToolbar :flow="flow" :can-edit="canEdit" />
      <FlowStatusStrip :flow="flow" :can-edit="canEdit" />
      <FlowModeStrip :flow="flow" :can-edit="canEdit" />
      <FlowCharter :flow="flow" :can-edit="canEdit" />
      <div class="bz-body">
        <FlowGallery v-if="galleryOpen" :flow="flow" :can-edit="canEdit" />
        <FlowCanvasSurface :flow="flow" :can-edit="canEdit" />
        <FlowTable v-if="flow && isTableOpen(flow.id)" :flow="flow" :can-edit="canEdit" />
      </div>
    </div>
    <FlowPartyPanel :flow="flow" :can-edit="canEdit" />
    <FlowPopovers :flow="flow" :can-edit="canEdit" />
    <FlowCanvasRepoint :flow="flow" :can-edit="canEdit" />
  </div>
</template>

<script setup lang="ts">
/**
 * The Business Case Task Flow screen — index.html's renderBizcase and everything it drives.
 */
import { flowsInOrder, type Flow } from '@raci/core';
import { addFlow } from '@raci/crdt';

const session = useWorkspaceSession();
const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));
const activeFlowId = useActiveFlowId();
const { galleryOpen, isTableOpen } = useFlowScreen();

/** index.html's abc(): the open flow, or the first when the open one is gone. */
const flow = computed<Flow | null>(() => {
  const ws = session.workspace.value;
  const id = activeFlowId.value;
  return (id && ws.flows[id]) || flowsInOrder(ws)[0] || null;
});
watch(flow, (f) => { if (f && f.id !== activeFlowId.value) activeFlowId.value = f.id; }, { immediate: true });

/**
 * abc()'s other half: a workspace with no flow at all gets an "Untitled business case", so the screen
 * always has one to show. Only once the document has arrived (an empty doc before the first sync is
 * not an empty workspace), and only for someone who may write. Outside undo, as there: it is the
 * screen repairing itself, not an edit anyone made.
 */
let healed = false;
watch(() => [session.ready.value, Object.keys(session.workspace.value.flows).length, canEdit.value] as const, ([ready, n, can]) => {
  if (n > 0) { healed = false; return; }
  if (!import.meta.client || healed || !ready || !can) return;
  healed = true;
  session.doc.transact(() => { addFlow(session.doc, 'Untitled business case'); }, 'self-heal');
}, { immediate: true });
</script>
