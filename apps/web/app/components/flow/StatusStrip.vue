<template>
  <!-- index.html's statusStripHtml('flow', b): stated in BOTH states, with the way in and the way out. -->
  <div v-if="flow" class="art-status-strip" :class="`is-${status}`" data-art-kind="flow">
    <span class="ast-badge">{{ M.icon }} {{ M.short }}</span>
    <span class="ast-txt">{{ M.blurb }}<template v-if="signedOn">{{ ' ' }}<span class="ast-when">Signed {{ signedOn }}.</span></template></span>
    <button type="button" class="ast-set" data-status-set="flow" :data-status-id="flow.id" :data-status="status === 'final' ? 'draft' : 'final'"
      :title="status === 'final'
        ? `Reopen “${flow.name || 'Untitled'}” for editing. Nothing is lost — the status is just a field, and you can mark it Final again whenever you like.`
        : `Mark “${flow.name || 'Untitled'}” Final. It keeps working everywhere; its cells, names and layout simply lock against accidental edits until you reopen it.`"
      @click="chrome.setStatus(flow.id, status === 'final' ? 'draft' : 'final')">{{ status === 'final' ? '↺ Reopen as draft' : '✓ Mark final' }}</button>
  </div>
</template>

<script setup lang="ts">
/**
 * The Draft / Final strip over the canvas — index.html's statusStripHtml('flow', b) and
 * setCaseStatus, as the chart screen draws the chart's.
 */
import type { Flow } from '@raci/core';
import { ART_STATUS_META } from '~/composables/useFlowChrome';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();

const status = computed(() => (props.flow?.status === 'final' ? 'final' : 'draft'));
const M = computed(() => ART_STATUS_META[status.value]);
/** finalizedOn: the reader's own locale, and nothing for a stamp that does not parse. */
const signedOn = computed(() => {
  const at = props.flow?.finalizedAt;
  if (!at) return '';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
});
</script>
