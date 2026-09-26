<template>
  <!-- index.html's bizCharterHtml: the exec context an ANCHORED flow lives under. Nothing for a
       standalone flow. -->
  <div v-if="flow?.anchor && !an" class="bz-charter broken" @click="onClick">
    <span class="bzc-crumb-txt">⚓ Anchored chart task is missing (chart deleted?)</span>
    <button v-if="canEdit" class="bzc-detach" :data-bz-detach="flow.id" title="Make this a standalone case">Detach</button>
  </div>
  <div v-else-if="flow && an" class="bz-charter" @click="onClick">
    <button class="bzc-crumb" data-charter-jump="1" :data-chart-id="an.chart.id" :data-node-id="an.node.id"
      title="Back to this task's row in the org chart">⤴ {{ crumb }}</button>
    <span class="bzc-chips"><span v-for="c in chips" :key="c.col" class="bzc-col" :title="c.title"><span
      class="bzc-col-key">{{ c.key }}</span><span v-for="(l, i) in c.letters" :key="i" class="raci-chip" :class="l">{{ l }}</span><span
      v-if="c.inherited" class="raci-chip inherited" :class="F.owner" :title="`${F.meta[F.owner]?.label} — inherited from the cascade`">{{ F.owner }}</span></span></span>
    <span v-if="orgs.length" class="bzc-orgs"><span v-for="(o, i) in orgs" :key="i" class="bzc-org" :title="o.full">{{ o.short }}</span></span>
    <button v-if="canEdit" class="bzc-detach" :data-bz-detach="flow.id" title="Detach — make this a standalone tabletop case">Detach</button>
  </div>
</template>

<script setup lang="ts">
/**
 * The charter strip — index.html's bizCharterHtml: the anchor row's ancestry (click it to go back
 * to the row, jumpToChartNode), its effective RACI chips (its own letters plus the dashed owner it
 * inherits), the org units its Program / Project ancestors carry, and Detach (detachFlow).
 */
import { COLS, framework, normalizeRaci, type Flow } from '@raci/core';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();

const an = computed(() => chrome.anchorInfo(props.flow));
const F = computed(() => framework(an.value?.chart.framework));
const crumb = computed(() => {
  const a = an.value;
  if (!a) return '';
  return [a.chart.title || 'Untitled chart', ...a.ancestors.map((n) => n.name || '(untitled)'), a.node.name || '(untitled)'].join(' › ');
});
/** Only the columns that hold letters, or carry the inherited owner. */
const chips = computed(() => {
  const a = an.value;
  if (!a) return [];
  const f = F.value;
  const inh = chrome.lint.value.inheritedOwner(a.chart, a.node.id);
  const rowHasOwner = COLS.some((k) => normalizeRaci(a.node.raci[k] ?? '').includes(f.owner));
  return COLS.flatMap((k) => {
    const own = normalizeRaci(a.node.raci[k] ?? '');
    const inherited = k === inh && !rowHasOwner;
    if (!own && !inherited) return [];
    return [{ col: k, key: chrome.colShort(k), title: chrome.colLabel(k), letters: own.split(''), inherited: inherited && !own.includes(f.owner) }];
  });
});
/** Org context inherited from the ancestors (Program → Division, Project → Branch). */
const orgs = computed(() => {
  const a = an.value;
  if (!a) return [];
  return [...a.ancestors, a.node].map((n) => chrome.orgLabel(n.org)).filter((l): l is { short: string; full: string } => !!l);
});

/** The strip's two data-* handlers, as index.html's document click listener checks them. */
function onClick(e: MouseEvent): void {
  const t = e.target as Element;
  const jump = t.closest<HTMLElement>('[data-charter-jump]');
  if (jump) { void chrome.jumpToChartNode(jump.dataset.chartId!, jump.dataset.nodeId!); return; }
  const detach = t.closest<HTMLElement>('[data-bz-detach]');
  if (detach) chrome.detach(detach.dataset.bzDetach!);
}
</script>
