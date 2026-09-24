<template>
  <div class="branch" :data-branch-id="br.id">
    <div class="branch-header">
      <span
        v-editable-text="{ text: br.name, commit: (v: string) => edits.renameUnit(br.id, v) }"
        class="branch-name" :contenteditable="edits.canEdit.value ? 'true' : 'false'" spellcheck="false"
        :data-actor="actor" :data-division-id="divId" :data-branch-id="br.id" data-field="branch-name"
        :title="br.externalId ? FROM_DIRECTORY : undefined"
      />
      <button v-if="edits.canEdit.value" class="del-icon" :data-del-branch="`${actor}|${divId}|${br.id}`"
        title="Delete branch" @click="edits.deleteBranch(br.id)">×</button>
    </div>
    <div class="branch-body">
      <RosterLeadSlot :actor="actor" :div-id="divId" :br-id="br.id" :team-id="null" role="BC" :lead="br.chief" />
      <RosterTeamPanel v-for="t in br.teams" :key="t.id" :actor="actor" :div-id="divId" :br-id="br.id" :team="t" />
      <button v-if="edits.canEdit.value" class="add-team" :data-add-team="`${actor}|${divId}|${br.id}`"
        @click="edits.addTeam(actor, divId, br.id)">+ Add team</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** index.html's renderBranchPanel: a branch in the Full hierarchy — its chief, then its teams. */
import type { Actor, Branch } from '@raci/core';
import { FROM_DIRECTORY, useRosterEdits, vEditableText } from '~/composables/roster/edits';

defineProps<{ actor: Actor; divId: string; br: Branch }>();
const edits = useRosterEdits();
</script>
