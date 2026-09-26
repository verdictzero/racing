<template>
  <!-- index.html's bizModeStripHtml: which mode the flow is in, and — Chart-Linked — the two facts
       that decide whether it means anything yet. The picker IS the badge. -->
  <div v-if="flow && !linked" class="bz-mode-strip is-free">
    <span class="bzm-txt">{{ BIZ_MODE_META.free.blurb }}</span>
    <button type="button" class="bzm-meta" data-open-meta="flow" :title="META_TITLE" @click="openMeta">✎ Details<span
      v-if="hasMeta" class="has-meta-dot" aria-hidden="true" /></button>
    <select id="bz-mode" class="bzm-badge" :data-mode="flow.mode" :title="MODE_TITLE" :disabled="!canEdit" @change="pickMode">
      <option v-for="k in BIZ_MODES" :key="k" :value="k" :selected="flow.mode === k">{{ BIZ_MODE_META[k].icon }} {{ BIZ_MODE_META[k].name }}</option>
    </select>
  </div>
  <div v-else-if="flow" class="bz-mode-strip is-linked" :class="{ 'has-gap': gap }">
    <span class="bzm-src">rows from <b v-if="chart">{{ chart.title || 'Untitled chart' }}</b><b v-else class="bzm-none">no organization chart available</b></span>
    <span class="bzm-count" :class="{ 'is-gap': gap }" :title="countTitle">{{ bound }}/{{ n }} step{{ n === 1 ? '' : 's' }} linked{{ broken ? ` · ${broken} broken` : '' }}</span>
    <button v-if="unset" type="button" class="bzm-fix" data-bz-bind-next="1" title="Centre the next unlinked step and pick its row"
      @click="chrome.bindNextUnbound()">Link the next one →</button>
    <button type="button" class="bzm-meta" data-open-meta="flow" :title="META_TITLE" @click="openMeta">✎ Details<span
      v-if="hasMeta" class="has-meta-dot" aria-hidden="true" /></button>
    <select id="bz-mode" class="bzm-badge" :data-mode="flow.mode" :title="MODE_TITLE" :disabled="!canEdit" @change="pickMode">
      <option v-for="k in BIZ_MODES" :key="k" :value="k" :selected="flow.mode === k">{{ BIZ_MODE_META[k].icon }} {{ BIZ_MODE_META[k].name }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
/**
 * The mode strip — index.html's bizModeStripHtml, bizSetMode (Free-Form ↔ Chart-Linked, with the
 * source's confirm and toasts), "Link the next one →" (bizBindNextUnbound) and ✎ Details.
 */
import type { Flow } from '@raci/core';
import { BIZ_MODES, BIZ_MODE_META } from '~/composables/useFlowChrome';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const shell = useShell();

const META_TITLE = 'Description, customer, priority, budget and tags for this flow — searched by the gallery filter and carried into every export';
const MODE_TITLE = BIZ_MODES.map((k) => `${BIZ_MODE_META[k].icon} ${BIZ_MODE_META[k].name} — ${BIZ_MODE_META[k].blurb}`).join('\n');

const linked = computed(() => chrome.isLinked(props.flow));
const hasMeta = computed(() => {
  const m = props.flow?.meta;
  return !!(m && (m.description || m.customer || m.priority || m.budget || m.tags.length));
});
function openMeta(): void { if (props.flow) shell.openMeta('flow', props.flow.id); }
/** #bz-mode: the party panel closes, then the mode changes. */
function pickMode(e: Event): void {
  chrome.closeParty();
  chrome.setMode((e.target as HTMLSelectElement).value);
}

// "Never linked" and "linked to a row that has since gone" are different problems with different
// fixes, so the count keeps them apart.
const counts = computed(() => {
  const b = props.flow;
  const steps = b ? chrome.steps(b).filter((t) => !chrome.isSub(t)) : [];
  const bound = steps.filter((t) => chrome.bindInfo(t)).length;
  const broken = steps.filter((t) => t.bind && !chrome.bindInfo(t)).length;
  return { n: steps.length, bound, broken, unset: steps.length - bound - broken };
});
const n = computed(() => counts.value.n);
const bound = computed(() => counts.value.bound);
const broken = computed(() => counts.value.broken);
const unset = computed(() => counts.value.unset);
const gap = computed(() => unset.value + broken.value);
const chart = computed(() => chrome.sourceChart(props.flow));
const countTitle = computed(() => {
  const u = unset.value, k = broken.value;
  if (!gap.value) return 'Every step names the chart row it implements.';
  return [
    u ? `${u} step${u === 1 ? '' : 's'} name${u === 1 ? 's' : ''} no chart row yet — ${u === 1 ? 'it carries' : 'they carry'} only whatever was typed on the card.` : '',
    k ? `${k} step${k === 1 ? '' : 's'} point${k === 1 ? 's' : ''} at a row that no longer exists — re-point or unlink ${k === 1 ? 'it' : 'them'}.` : '',
  ].filter(Boolean).join('\n');
});
</script>
