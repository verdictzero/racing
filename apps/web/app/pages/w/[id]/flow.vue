<template>
  <!-- index.html's renderBizcase, element for element. The chrome around the canvas is its own
       components (components/flow/*); the canvas is this page. The two share their view state
       through composables/useFlowScreen.ts. -->
  <div class="ws-page">
    <div class="bz-wrap">
      <FlowToolbar :flow="flow" :can-edit="canEdit" />
      <FlowStatusStrip :flow="flow" :can-edit="canEdit" />
      <FlowModeStrip :flow="flow" :can-edit="canEdit" />
      <FlowCharter :flow="flow" :can-edit="canEdit" />
      <div class="bz-body">
        <FlowGallery v-if="galleryOpen" :flow="flow" :can-edit="canEdit" />
        <div id="bz-canvas" class="bz-canvas">
          <!-- The canvas: .bz-empty, #bz-world (svg.bz-edges, the frames, the steps, svg.bz-redirs),
               #bz-zoom-ctl and canvas#bz-minimap — not built yet. -->
        </div>
        <FlowTable v-if="flow && isTableOpen(flow.id)" :flow="flow" :can-edit="canEdit" />
      </div>
    </div>
    <FlowPartyPanel :flow="flow" :can-edit="canEdit" />
    <FlowPopovers :flow="flow" :can-edit="canEdit" />
  </div>
</template>

<script setup lang="ts">
/**
 * The Business Case Task Flow screen — index.html's renderBizcase and everything it drives.
 */
import { flowsInOrder, type Flow } from '@raci/core';

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
</script>
