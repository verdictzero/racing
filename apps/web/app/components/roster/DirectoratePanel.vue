<template>
  <section class="directorate" :class="{ collapsed }" :data-actor="actor">
    <header class="dir-header" :data-toggle-dir="actor" @click="onHeaderClick">
      <span class="caret">▼</span>
      <h3
        v-editable-text="{ text: label, commit: (v: string) => edits.renameDirectorate(actor, v) }"
        class="dir-name-edit" :contenteditable="edits.canEdit.value ? 'true' : 'false'" spellcheck="false"
        :data-actor="actor" data-field="dir-name"
        :title="edits.canEdit.value ? 'Click to rename this directorate' : undefined"
      />
      <span class="dir-stats">{{ stat }}</span>
    </header>
    <div class="dir-body">
      <RosterLeadSlot :actor="actor" :div-id="null" :br-id="null" :team-id="null" role="AD" :lead="directorate.lead" />
      <!-- Memoised on the division's content: the snapshot is rebuilt on every edit anywhere, and
           without this every division of every directorate would re-render for each keystroke. -->
      <RosterDivisionPanel v-for="d in directorate.divisions" :key="d.id" v-memo="[JSON.stringify(d), edits.canEdit.value]"
        :actor="actor" :div="d" />
      <button v-if="edits.canEdit.value" class="add-division" :data-add-division="actor" @click="add">+ Add division</button>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * index.html's renderDirectoratePanel: one directorate of the Full hierarchy, collapsible from its
 * header. Collapsing is the viewer's own view state (the page keeps it), never the document's.
 *
 * Everything it shows arrives as props — nothing here reads the workspace itself — so the page can
 * skip re-rendering a directorate whose content did not change.
 */
import type { Actor, Directorate } from '@raci/core';
import { useRosterEdits, vEditableText } from '~/composables/roster/edits';

const props = defineProps<{ actor: Actor; directorate: Directorate; label: string; stat: string; collapsed: boolean }>();
const emit = defineEmits<{ toggle: []; expand: [] }>();

const edits = useRosterEdits();

// The header toggles — except from a button in it, or from the name, which is for renaming.
function onHeaderClick(e: MouseEvent) {
  const t = e.target as Element;
  if (t.closest('button') || t.closest('.dir-name-edit')) return;
  emit('toggle');
}

// A division added to a collapsed directorate would be added out of sight, so adding opens it.
function add() {
  edits.addDivision(props.actor);
  emit('expand');
}
</script>
