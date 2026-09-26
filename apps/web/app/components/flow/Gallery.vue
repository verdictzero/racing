<template>
  <!-- FlowGallery: not built yet — see the flow screen's contract in composables/useFlowScreen.ts. -->
  <template v-if="false"><span /></template>
</template>

<script setup lang="ts">
import type { Flow } from '@raci/core';

defineProps<{ flow: Flow | null; canEdit: boolean }>();
</script>
