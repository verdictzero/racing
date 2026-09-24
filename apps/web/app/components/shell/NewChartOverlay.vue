<template>
  <div id="newchart-overlay" role="dialog" aria-modal="true" aria-labelledby="newchart-title"
    :class="{ open }" @click.self="emit('close')">
    <div id="newchart-card">
      <h2 id="newchart-title">New chart</h2>
      <p class="nc-sub">Choose the kind of nested RACI to create.</p>
      <div class="nc-options">
        <button type="button" class="nc-opt" data-newchart="org" @click="create('org')">
          <span class="nc-name">🏛 Organization chart</span>
          <span class="nc-desc">Uses the shared organizational columns and roster. Fixed Portfolio → Program → Project → Task tiers, with division/branch assignment and roster-linked people behind each column.</span>
        </button>
        <button type="button" class="nc-opt" data-newchart="free" @click="create('free')">
          <span class="nc-name">✦ Free-form chart</span>
          <span class="nc-desc">Organization-agnostic. Define your own party columns — add, rename, or remove them right in the table header — and nest activities to any depth with renamable levels. No roster links.</span>
        </button>
      </div>
      <button id="newchart-cancel" type="button" class="nc-cancel" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The new-chart chooser — index.html's #newchart-overlay and addChart(kind). A free-form chart
 * starts with the source's four placeholder parties and no level names.
 */
import { addChart } from '@raci/crdt';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; created: [id: string] }>();
const session = useWorkspaceSession();

function create(kind: 'org' | 'free'): void {
  const custom = kind === 'free'
    ? {
        cols: ['Party A', 'Party B', 'Party C', 'Party D'].map((label) => ({
          key: `p_${Math.random().toString(36).slice(2, 10)}`, label, short: '',
        })),
        tiers: [],
      }
    : null;
  const id = addChart(session.doc, 'Untitled chart', custom);
  emit('close');
  emit('created', id);
}
</script>
