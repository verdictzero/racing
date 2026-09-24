<template>
  <div class="team" :data-team-id="team.id">
    <div class="team-header">
      <span
        v-editable-text="{ text: team.name, commit: (v: string) => edits.renameUnit(team.id, v) }"
        class="team-name" :contenteditable="edits.canEdit.value ? 'true' : 'false'" spellcheck="false"
        :data-actor="actor" :data-division-id="divId" :data-branch-id="brId" :data-team-id="team.id"
        data-field="team-name" :title="team.externalId ? FROM_DIRECTORY : undefined"
      />
      <button v-if="edits.canEdit.value" class="del-icon" :data-del-team="`${actor}|${divId}|${brId}|${team.id}`"
        title="Delete team" @click="edits.deleteTeam(team.id)">×</button>
    </div>
    <div class="people">
      <RosterLeadSlot :actor="actor" :div-id="divId" :br-id="brId" :team-id="team.id" role="TL" :lead="team.chief" />
      <RosterPersonRow v-for="p in team.people" :key="p.id" :actor="actor" :div-id="divId" :br-id="brId"
        :team-id="team.id" :person="p" />
      <button v-if="edits.canEdit.value" class="add-person" :data-add-person="`${actor}|${divId}|${brId}|${team.id}`"
        @click="edits.addPerson(team.id)">+ Add person</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** index.html's renderTeamPanel: a team in the Full hierarchy — its lead, then its people. */
import type { Actor, Team } from '@raci/core';
import { FROM_DIRECTORY, useRosterEdits, vEditableText } from '~/composables/roster/edits';

defineProps<{ actor: Actor; divId: string; brId: string; team: Team }>();
const edits = useRosterEdits();
</script>
