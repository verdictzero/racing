<template>
  <!-- index.html's renderOrgRow: Programs assign a Division, Projects a Branch (with the inherited
       Division shown read-only), Tasks show what they inherit. Free-form charts carry none. -->
  <span v-if="!chart.custom && tier === 1" class="org-row">
    <span v-if="own" class="org-badge editable" :title="own.full" :data-org-edit="node.id" data-org-kind="division"><span class="ob-ico">🏢</span>{{ own.short }}</span>
    <span v-else class="org-badge editable empty" title="Assign a roster Division to this Program" :data-org-edit="node.id" data-org-kind="division"><span class="ob-ico">🏢</span>Assign division</span>
  </span>
  <span v-else-if="!chart.custom && tier === 2" class="org-row">
    <span v-if="div" class="org-badge inherited" :title="`Inherited Division — ${div.full}`"><span class="ob-ico">🏢</span>{{ div.short }}</span>
    <span v-if="own" class="org-badge editable" :title="own.full" :data-org-edit="node.id" data-org-kind="branch"><span class="ob-ico">🌿</span>{{ own.short }}</span>
    <span v-else class="org-badge editable empty" title="Assign a roster Branch to this Project" :data-org-edit="node.id" data-org-kind="branch"><span class="ob-ico">🌿</span>Assign branch</span>
  </span>
  <span v-else-if="!chart.custom && tier === 3 && (div || br)" class="org-row">
    <span v-if="div" class="org-badge inherited" :title="`Inherited Division — ${div.full}`"><span class="ob-ico">🏢</span>{{ div.short }}</span>
    <span v-if="br" class="org-badge inherited" :title="`Inherited Branch — ${br.full}`"><span class="ob-ico">🌿</span>{{ br.short }}</span>
  </span>
</template>

<script setup lang="ts">
import type { Chart, ChartNode, OrgRef } from '@raci/core';

const props = defineProps<{
  chart: Chart;
  node: ChartNode;
  tier: number;
  inherited: { division: OrgRef | null; branch: OrgRef | null };
}>();
const session = useWorkspaceSession();
const labels = useLabels();
const lab = (ref: OrgRef | null | undefined) => legacyOrgLabel(session.workspace.value, labels.actorLabel, ref);
const own = computed(() => lab(props.node.org));
const div = computed(() => lab(props.inherited.division));
const br = computed(() => lab(props.inherited.branch));
</script>
