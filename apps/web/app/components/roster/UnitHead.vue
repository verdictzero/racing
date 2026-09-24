<template>
  <div class="rost-unit-head">
    <div class="rost-uh-top">
      <span class="rost-uh-kind">{{ KIND[level] }}</span>
      <h3 v-if="level === 'dir'" v-editable-text="{ text: name, commit: rename }" class="dir-name-edit rost-uh-name"
        :contenteditable="ce" spellcheck="false" :data-actor="actor" data-field="dir-name"
        :title="edits.canEdit.value ? 'Click to rename this directorate' : undefined" />
      <span v-else v-editable-text="{ text: name, commit: rename }" :class="`${FIELD[level]} rost-uh-name`"
        :contenteditable="ce" spellcheck="false" :data-actor="actor" :data-division-id="divId || undefined"
        :data-branch-id="brId || undefined" :data-team-id="teamId || undefined" :data-field="FIELD[level]"
        :title="fromDirectory ? FROM_DIRECTORY : undefined" />
      <span class="rost-uh-stat">{{ stat }}</span>
    </div>
    <div class="rost-uh-lead">
      <RosterLeadSlot :actor="actor" :div-id="divId" :br-id="brId" :team-id="teamId" :role="ROLE[level]" :lead="lead" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * index.html's rosterUnitHead: the strip over a drilled-in unit in the Explore layout — what kind of
 * unit it is, its name (renamed in place, through the same hooks as the Full hierarchy's), what sits
 * under it, and its lead slot.
 */
import type { Actor } from '@raci/core';
import { FROM_DIRECTORY, useRosterEdits, vEditableText, type LeadRole } from '~/composables/roster/edits';

const props = defineProps<{
  level: 'dir' | 'div' | 'br' | 'team';
  actor: Actor;
  divId: string | null;
  brId: string | null;
  teamId: string | null;
  /** The unit's name as stored — a directorate's is its display label. */
  name: string;
  stat: string;
  lead: { id: string; name: string } | null;
  /** The unit came from the directory (see FROM_DIRECTORY). */
  fromDirectory?: boolean;
}>();

const KIND = { dir: 'Directorate', div: 'Division', br: 'Branch', team: 'Team' } as const;
const FIELD = { dir: 'dir-name', div: 'div-name', br: 'branch-name', team: 'team-name' } as const;
const ROLE: Record<typeof props.level, LeadRole> = { dir: 'AD', div: 'DC', br: 'BC', team: 'TL' };

const edits = useRosterEdits();
const ce = computed(() => (edits.canEdit.value ? 'true' : 'false'));

function rename(v: string) {
  if (props.level === 'dir') edits.renameDirectorate(props.actor, v);
  else {
    const id = props.teamId ?? props.brId ?? props.divId;
    if (id) edits.renameUnit(id, v);
  }
}
</script>
