<template>
  <div v-if="lead" class="lead-card" :data-role="role">
    <span class="lead-badge">{{ ROLE_LABELS[role] }}</span>
    <span
      v-editable-text="{ text: lead.name, commit: (v: string) => edits.commitLeadName(actor, divId, brId, teamId, role, v) }"
      class="lead-name" :contenteditable="edits.canEdit.value ? 'true' : 'false'" spellcheck="false"
      :data-actor="actor" :data-division-id="divId || undefined" :data-branch-id="brId || undefined"
      :data-team-id="teamId || undefined" :data-role="role" data-field="lead-name" data-placeholder="Name"
    />
    <button v-if="edits.canEdit.value" class="del-icon" :data-del-lead="scope" title="Remove"
      @click="edits.removeLead(actor, divId, brId, teamId, role)">×</button>
  </div>
  <button v-else-if="edits.canEdit.value" class="add-lead" :data-role="role" :data-add-lead="scope"
    @click="edits.setLead(actor, divId, brId, teamId, role)">{{ ROLE_ADD_LABELS[role] }}</button>
</template>

<script setup lang="ts">
/**
 * index.html's renderLeadSlot: a unit's lead as a coloured card (Associate Director, Division Chief,
 * Branch Chief, Team Lead), or the dashed "+ Set …" button when the post is empty. The same slot
 * sits in a drilled-in unit's header and in every panel of the Full hierarchy.
 */
import type { Actor } from '@raci/core';
import { ROLE_ADD_LABELS, ROLE_LABELS, useRosterEdits, vEditableText, type LeadRole } from '~/composables/roster/edits';

const props = defineProps<{
  actor: Actor;
  divId: string | null;
  brId: string | null;
  teamId: string | null;
  role: LeadRole;
  lead: { id: string; name: string } | null;
}>();

const edits = useRosterEdits();
const scope = computed(() => `${props.actor}|${props.divId || ''}|${props.brId || ''}|${props.teamId || ''}|${props.role}`);
</script>
