<template>
  <!-- Always in the DOM, as in index.html: the stylesheet hides it until it .has-issues. -->
  <button id="violations-toast" type="button" title="Click to view R/A rule violations"
    :class="{ 'has-issues': records.length > 0, 'only-warn': records.length > 0 && !hasErr }"
    @click.stop="open = !open">
    <span class="vt-icon">⚠</span><span class="vt-text">{{ records.length ? text : '0 issues' }}</span>
  </button>
  <div id="violations-popover" ref="pop" role="dialog" aria-label="RACI rule violations"
    :class="{ open: open && records.length > 0 }">
    <div class="vp-head">
      <span>R / A Rule Violations</span>
      <button id="vp-close" type="button" title="Close" @click="open = false">×</button>
    </div>
    <div id="vp-list" class="vp-list">
      <div v-for="r in records" :key="`${r.kind}:${recordId(r)}`" class="vp-item"
        :title="r.kind === 'flow' ? 'Jump to this flow step' : 'Jump to this row'" @click="jump(r)">
        <span class="vp-sev" :class="{ warn: r.severity !== 'err' }">{{ r.kind === 'flow' ? '⤵' : '⚠' }}</span>
        <div class="vp-body">
          <div class="vp-title">{{ r.name }}</div>
          <div class="vp-meta">{{ r.tierLabel }}{{ r.ancestors.length ? ' · ' + r.ancestors.map((a) => a.name).join(' › ') : '' }}</div>
          <div v-for="(i, n) in r.issues" :key="n" class="vp-msg">{{ i.message }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The warnings pill and its popover — index.html's #violations-toast and #violations-popover.
 * The jump asks the owning screen to bring the row or step into view (useJumpRequest), navigating
 * there first if another screen is up.
 */
import { recordId, violationPillText, type ViolationRecord } from '~/composables/useViolationRecords';

const props = defineProps<{ records: ViolationRecord[] }>();
const emit = defineEmits<{ jump: [record: ViolationRecord] }>();

const open = ref(false);
const pop = ref<HTMLElement | null>(null);
const text = computed(() => violationPillText(props.records));
const hasErr = computed(() => props.records.some((r) => r.severity === 'err'));

function jump(r: ViolationRecord): void {
  open.value = false;
  emit('jump', r);
}

// Click outside closes it — the source's wireViolationsUI.
function onDown(e: MouseEvent): void {
  if (!open.value) return;
  const t = e.target as Element | null;
  if (t?.closest?.('#violations-popover') || t?.closest?.('#violations-toast')) return;
  open.value = false;
}
onMounted(() => document.addEventListener('click', onDown));
onBeforeUnmount(() => document.removeEventListener('click', onDown));
</script>
