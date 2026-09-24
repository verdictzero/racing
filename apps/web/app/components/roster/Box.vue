<template>
  <div :class="`rost-box k-${kind}`" :data-roster-drill="drill" tabindex="0" role="button" :title="`Open ${name}`"
    @click="onClick" @keydown.enter.self.prevent="emit('open')">
    <button v-if="canEdit" class="rost-box-del del-icon" v-bind="{ [delAttr]: delValue }"
      :title="`Delete ${KIND_LABELS[kind].toLowerCase()}`" @click="emit('delete')">×</button>
    <span class="rost-box-kind">{{ KIND_LABELS[kind] }}</span>
    <span class="rost-box-name">{{ name }}</span>
    <span class="rost-box-stat">{{ stat }}</span>
    <span v-if="lead" class="rost-box-lead">{{ `${ROLES[kind]}: ${lead}` }}</span>
    <span class="rost-box-go">{{ kind === 'team' ? 'open people ▸' : 'open ▸' }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * index.html's rosterBoxBtn: a big drillable box for a child unit — division, branch or team — in the
 * Explore layout. A div rather than a button so it can hold its own × delete; the drill is the
 * box's click, and a click on the × (or anything else that is a control) is not a drill.
 */
defineProps<{
  kind: 'div' | 'br' | 'team';
  /** The unit's path, "actor|division|branch|team" as far as it goes. */
  drill: string;
  name: string;
  stat: string;
  /** The unit's lead, if it has one with a name. */
  lead: string;
  /** Which delete hook the × carries (data-del-division / -branch / -team) and its value. */
  delAttr: string;
  delValue: string;
}>();
const emit = defineEmits<{ open: []; delete: [] }>();

const canEdit = inject<Ref<boolean>>('raci:canEdit', ref(false));

const KIND_LABELS = { div: 'Division', br: 'Branch', team: 'Team' } as const;
const ROLES = { div: 'DC', br: 'BC', team: 'TL' } as const;

function onClick(e: MouseEvent) {
  const t = e.target as Element;
  if (t.closest('button') || t.closest('[contenteditable="true"]')) return;
  emit('open');
}
</script>
