<template>
  <!-- index.html's .bz-toolbar, filled by bizSelectorHtml. -->
  <div class="bz-toolbar">
    <button v-if="backTo" id="bz-back" :title="`Back to ${backTo}`" @click="navBack">↩ Back</button>
    <button id="bz-gallery" :class="screen.galleryOpen.value ? 'active' : ''"
      title="Flow gallery — every business case in this workspace. Click one to open it, or drag it onto the canvas to nest it inside this flow."
      @click="chrome.toggleGallery()">⊞ Gallery</button>
    <select id="bz-select" data-lock-ok title="Active business case" @change="pick">
      <template v-if="attached.length && standalone.length">
        <optgroup label="Attached to chart tasks">
          <option v-for="c in attached" :key="c.id" :value="c.id" :selected="c.id === flow?.id">{{ optLabel(c) }}</option>
        </optgroup>
        <optgroup label="Standalone (tabletop)">
          <option v-for="c in standalone" :key="c.id" :value="c.id" :selected="c.id === flow?.id">{{ optLabel(c) }}</option>
        </optgroup>
      </template>
      <template v-else>
        <option v-for="c in chrome.flows.value" :key="c.id" :value="c.id" :selected="c.id === flow?.id">{{ optLabel(c) }}</option>
      </template>
    </select>
    <button id="bz-new" title="New business case" :disabled="!canEdit" @click="chrome.addCase()">+ New Graph</button>
    <!-- A viewer, like a Final flow, has nothing here to reach for: the lock hides these same four. -->
    <button v-if="canEdit" id="bz-rename" title="Rename this business case" @click="chrome.renameCase()">Rename</button>
    <button v-if="canEdit" id="bz-del" title="Delete this business case" @click="chrome.deleteCase()">Delete</button>
    <template v-if="srcCharts">
      <span class="bz-sep" aria-hidden="true" />
      <select id="bz-source-chart" title="Which organization chart this flow’s steps link their rows from" :disabled="!canEdit" @change="pickSource">
        <option v-for="c in srcCharts" :key="c.id" :value="c.id" :selected="c.id === srcChart?.id">{{ c.title || 'Untitled chart' }}</option>
      </select>
    </template>
    <span class="bz-sep" aria-hidden="true" />
    <button v-if="canEdit" id="bz-add-task" title="Add a task box to the canvas" @click="screen.canvas.addTaskAtCentre()">+ Add task</button>
    <button v-if="canEdit" id="bz-group" :disabled="!nSel"
      :title="nSel ? `Wrap the ${nSel} selected step${nSel === 1 ? '' : 's'} in a labelled frame` : 'Select steps first — click one, then shift-click others, or shift-drag a box around them'"
      @click="screen.canvas.groupSelection()">⊟ Group{{ nSel ? ` (${nSel})` : '' }}</button>
    <button id="bz-toggle-table" :class="tableOn ? 'active' : ''" title="Show/hide the RACI table pane" @click="toggleTable">▦ Table</button>
    <span class="bz-meta">{{ meta }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * The flow toolbar — index.html's bizSelectorHtml and the click and change handlers it wires:
 * ↩ Back out of a nested flow, the gallery toggle, the flow picker, New / Rename / Delete, the
 * Chart-Linked source chart, + Add task and ⊟ Group (which the canvas carries out), the table pane,
 * and the affordance line.
 */
import type { Flow } from '@raci/core';
import { ART_STATUS_META } from '~/composables/useFlowChrome';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const screen = chrome.screen;

// The picker groups flows attached to a chart task apart from standalone tabletop exercises — but
// only when there are both kinds. An anchor whose row is gone is no anchor: index.html's loader drops
// it and its row delete clears it, so it never lists a flow as attached to nothing (core's liveAnchor).
const attached = computed(() => chrome.flows.value.filter((c) => chrome.anchorInfo(c)));
const standalone = computed(() => chrome.flows.value.filter((c) => !chrome.anchorInfo(c)));
/** Status leads the label, so the picker reads as signed and unsigned at a glance. */
function optLabel(c: Flow): string {
  const an = chrome.anchorInfo(c);
  const tail = an ? ` — ⚓ ${an.node.name || 'untitled task'}` : '';
  return `[${ART_STATUS_META[c.status === 'final' ? 'final' : 'draft'].short}] ${c.name || 'Untitled'}${tail}`;
}
/** Picking from the dropdown is a jump, not a step out of a nested flow, so the Back trail goes. */
function pick(e: Event): void {
  chrome.closeParty();
  screen.switchFlow((e.target as HTMLSelectElement).value);
}

// The source chart picker rides alongside only when there is a choice to make and the flow is in
// the mode that uses it.
const srcChart = computed(() => chrome.sourceChart(props.flow));
const srcCharts = computed(() => (chrome.isLinked(props.flow) && chrome.linkable.value.length > 1 ? chrome.linkable.value : null));
function pickSource(e: Event): void { chrome.setSourceChart((e.target as HTMLSelectElement).value); }

/** ↩ Back appears only once you have descended into a nested flow, so the way out is the way in. */
const backTo = computed(() => {
  const trail = screen.navStack.value;
  return trail.length ? chrome.flowName(trail[trail.length - 1]!) : null;
});
/** bizNavBack. */
function navBack(): void {
  const trail = [...screen.navStack.value];
  const id = trail.pop();
  screen.navStack.value = trail;
  if (id && chrome.ws.value.flows[id]) screen.switchFlow(id, true);
}

const nSel = computed(() => screen.selection.value.length);
const tableOn = computed(() => screen.isTableOpen(props.flow?.id));
/** bizToggleTable. */
function toggleTable(): void { if (props.flow) screen.setTable(props.flow.id, !tableOn.value); }

const meta = computed(() => {
  const b = props.flow;
  const steps = b ? chrome.steps(b) : [];
  const nSub = steps.filter(chrome.isSub).length;
  const n = steps.length - nSub;
  const e = b ? chrome.edges(b).length : 0;
  const g = b ? Object.keys(b.groups).length : 0;
  return `${n} step${n === 1 ? '' : 's'} · ${e} handoff${e === 1 ? '' : 's'}`
    + `${nSub ? ` · ${nSub} nested flow${nSub === 1 ? '' : 's'}` : ''}${g ? ` · ${g} group${g === 1 ? '' : 's'}` : ''}`
    + ' · drag a socket to connect · drag a handoff to route it · shift-drag to select · scroll to zoom · right-click for actions';
});
</script>
