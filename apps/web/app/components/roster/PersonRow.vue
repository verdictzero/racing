<template>
  <div class="person" :data-person-id="person.id">
    <span
      v-editable-text="{ text: person.name, commit: (v: string) => edits.renameUnit(person.id, v) }"
      class="p-name" :contenteditable="ce" spellcheck="false" v-bind="ids" data-field="p-name"
      data-placeholder="Name" :title="person.externalId ? FROM_DIRECTORY : undefined"
    />
    <span
      v-editable-text="{ text: person.title, commit: (v: string) => edits.setPersonTitle(person.id, v) }"
      class="p-title" :contenteditable="ce" spellcheck="false" v-bind="ids" data-field="p-title"
      data-placeholder="Title (optional)"
    />
    <button v-if="edits.canEdit.value" class="del-icon"
      :data-del-person="`${actor}|${divId}|${brId}|${teamId}|${person.id}`" title="Delete person"
      @click="edits.deletePerson(person.id)">×</button>
  </div>
</template>

<script setup lang="ts">
/** index.html's renderPersonRow: one person in a team — name, optional title, and a hover ×. */
import type { Actor, Person } from '@raci/core';
import { FROM_DIRECTORY, useRosterEdits, vEditableText } from '~/composables/roster/edits';

const props = defineProps<{
  actor: Actor;
  divId: string;
  brId: string;
  teamId: string;
  person: Person;
}>();

const edits = useRosterEdits();
const ce = computed(() => (edits.canEdit.value ? 'true' : 'false'));
const ids = computed(() => ({
  'data-actor': props.actor,
  'data-division-id': props.divId,
  'data-branch-id': props.brId,
  'data-team-id': props.teamId,
  'data-person-id': props.person.id,
}));
</script>
