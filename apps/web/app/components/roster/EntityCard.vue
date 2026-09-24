<template>
  <div class="ent-card" :data-entity-id="entity.id">
    <div class="ent-head">
      <select class="ent-kind" :data-ent-kind="entity.id" :title="entityKindMeta(entity.kind).blurb"
        :disabled="!edits.canEdit.value" @change="onKind">
        <option v-for="k in ENTITY_KINDS" :key="k" :value="k" :selected="k === entity.kind">{{ kindText(k) }}</option>
      </select>
      <button v-if="edits.canEdit.value" class="del-icon ent-del" :data-del-entity="entity.id" title="Delete this entity"
        @click="edits.deleteEntity(entity.id)">×</button>
    </div>
    <span
      v-editable-text="{ text: entity.name, commit: (v: string) => edits.commitEntityField(entity.id, 'ent-name', v) }"
      class="ent-name" :contenteditable="ce" spellcheck="false" :data-entity-id="entity.id" data-field="ent-name"
      data-placeholder="Name — e.g. PG Board"
    />
    <div class="ent-row">
      <label>Short</label>
      <span
        v-editable-text="{ text: entity.short, commit: (v: string) => edits.commitEntityField(entity.id, 'ent-short', v) }"
        class="ent-short" :contenteditable="ce" spellcheck="false" :data-entity-id="entity.id" data-field="ent-short"
        :data-placeholder="deriveShort(entityName(entity))"
      />
    </div>
    <div class="ent-row">
      <label>Lead</label>
      <span
        v-editable-text="{ text: entity.lead?.name || '', commit: (v: string) => edits.commitEntityField(entity.id, 'ent-lead', v) }"
        class="ent-lead" :contenteditable="ce" spellcheck="false" :data-entity-id="entity.id" data-field="ent-lead"
        data-placeholder="Who speaks for it"
      />
    </div>
    <span
      v-editable-text="{ text: entity.description, commit: (v: string) => edits.commitEntityField(entity.id, 'ent-desc', v) }"
      class="ent-desc" :contenteditable="ce" spellcheck="false" :data-entity-id="entity.id" data-field="ent-desc"
      data-placeholder="＋ what this body is for"
    />
    <span class="ent-uses" :class="{ none: !uses.length }" :title="usesTitle">{{ usesText }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * index.html's entityCardHtml: one entity in the Roster's Entities section — what kind of body it
 * is, its name, short form and lead, what it is for, and how many things name it as a party.
 */
import {
  ENTITY_KIND_META,
  ENTITY_KINDS,
  entityKindMeta,
  type Entity,
  type EntityKind,
  type UseSite,
} from '@raci/core';
import { deriveShort, entityName, useRosterEdits, vEditableText } from '~/composables/roster/edits';

const props = defineProps<{ entity: Entity; uses: UseSite[] }>();

const edits = useRosterEdits();
const ce = computed(() => (edits.canEdit.value ? 'true' : 'false'));

const usesText = computed(() => {
  const n = props.uses.length;
  return n ? `named by ${n} ${n === 1 ? 'thing' : 'things'}` : 'unused';
});
const usesTitle = computed(() =>
  props.uses.length
    ? props.uses.map((u) => `${u.where} › ${u.name}`).join('\n')
    : 'Nothing names this entity as a party yet',
);

const kindText = (k: EntityKind) => `${ENTITY_KIND_META[k].icon} ${ENTITY_KIND_META[k].label}`;

function onKind(e: Event) {
  const el = e.target as HTMLSelectElement;
  edits.setEntityKind(props.entity.id, el.value);
  // Whatever was accepted, the picker shows what the document holds once it has re-rendered.
  void nextTick(() => {
    el.value = props.entity.kind;
  });
}
</script>
