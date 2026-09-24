<template>
  <div class="division" :data-division-id="div.id">
    <div class="div-header">
      <span
        v-editable-text="{ text: div.name, commit: (v: string) => edits.renameUnit(div.id, v) }"
        class="div-name" :contenteditable="edits.canEdit.value ? 'true' : 'false'" spellcheck="false"
        :data-actor="actor" :data-division-id="div.id" data-field="div-name"
        :title="div.externalId ? FROM_DIRECTORY : undefined"
      />
      <button v-if="edits.canEdit.value" class="del-icon" :data-del-division="`${actor}|${div.id}`"
        title="Delete division" @click="edits.deleteDivision(div.id)">×</button>
    </div>
    <div class="div-body">
      <RosterLeadSlot :actor="actor" :div-id="div.id" :br-id="null" :team-id="null" role="DC" :lead="div.chief" />
      <RosterBranchPanel v-for="b in div.branches" :key="b.id" :actor="actor" :div-id="div.id" :br="b" />
      <button v-if="edits.canEdit.value" class="add-branch" :data-add-branch="`${actor}|${div.id}`"
        @click="edits.addBranch(actor, div.id)">+ Add branch</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** index.html's renderDivisionPanel: a division in the Full hierarchy — its chief, then its branches. */
import type { Actor, Division } from '@raci/core';
import { FROM_DIRECTORY, useRosterEdits, vEditableText } from '~/composables/roster/edits';

defineProps<{ actor: Actor; div: Division }>();
const edits = useRosterEdits();
</script>
