<template>
  <div id="meta-overlay" role="dialog" aria-modal="true" aria-labelledby="meta-title"
    :class="{ open: !!subject }" @click.self="close">
    <div id="meta-card">
      <div class="mt-head">
        <h2 id="meta-title">{{ isFlow ? 'Flow details' : 'Chart details' }}</h2>
        <button id="meta-close" type="button" title="Close (Esc)" aria-label="Close" @click="close">×</button>
      </div>
      <p id="meta-sub" class="mt-sub">{{ sub }}</p>
      <div v-if="subject" id="meta-body">
        <p v-if="locked" class="mt-locked">This {{ isFlow ? 'flow' : 'chart' }} is <b>Final</b>. Its details are
          read-only — reopen it as a draft to change them.</p>
        <div class="mt-field">
          <label for="mt-desc">Description</label>
          <textarea id="mt-desc" ref="first" data-meta-field="description" spellcheck="true" :disabled="dis"
            :placeholder="`What this ${isFlow ? 'flow' : 'chart'} covers — scope, the opportunity behind it, anything a reader needs before the first row.`"
            :value="meta.description" @input="commit('description', $event)" />
        </div>
        <div class="mt-two">
          <div class="mt-field">
            <label for="mt-customer">Customer</label>
            <input id="mt-customer" type="text" data-meta-field="customer" :value="meta.customer" :disabled="dis"
              placeholder="Who it is for" spellcheck="false" @input="commit('customer', $event)">
          </div>
          <div class="mt-field">
            <label for="mt-priority">Priority</label>
            <select id="mt-priority" data-meta-field="priority" :disabled="dis" @change="commit('priority', $event)">
              <option v-for="k in META_PRIORITIES" :key="k" :value="k" :selected="meta.priority === k">{{ PRIORITY_LABEL[k] }}</option>
            </select>
          </div>
        </div>
        <div class="mt-field">
          <label for="mt-budget">Budget</label>
          <input id="mt-budget" type="text" data-meta-field="budget" :value="meta.budget" :disabled="dis"
            placeholder="Free text — a figure, a line of accounting, or a pointer" spellcheck="false"
            @input="commit('budget', $event)">
        </div>
        <div class="mt-field">
          <label for="mt-tags">Tags</label>
          <input id="mt-tags" type="text" data-meta-field="tags" :value="meta.tags.join(', ')" :disabled="dis"
            placeholder="Comma separated — intake, FY26, cyber" spellcheck="false" @change="commit('tags', $event)">
          <span class="mt-hint">Everything here is matched by the filter box, alongside the name, description, customer and budget.</span>
          <div v-if="meta.tags.length" class="mt-tagrow">
            <span v-for="t in meta.tags" :key="t" class="mt-tag">{{ t }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The Details overlay — index.html's #meta-overlay and renderMetaPanel/commitMetaField, for a chart
 * or a flow. Live write-through like the source: every keystroke lands in the document (so a
 * collaborator sees it arrive), except tags, which commit on change because the chip row they
 * rebuild would otherwise flicker under the cursor.
 */
import { META_PRIORITIES, type Meta } from '@raci/core';
import { LOCAL_ORIGIN, maps, setChartField, setField } from '@raci/crdt';

const props = defineProps<{ target: { kind: 'chart' | 'flow'; id: string | null } | null; canEdit: boolean }>();
const emit = defineEmits<{ close: [] }>();
const session = useWorkspaceSession();
const shell = useShell();

/** index.html's labels, including '— none —' for the unset priority. */
const PRIORITY_LABEL: Record<string, string> = { '': '— none —', low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };

const isFlow = computed(() => props.target?.kind === 'flow');
const subject = computed(() => {
  const t = props.target;
  if (!t?.id) return null;
  const ws = session.workspace.value;
  return t.kind === 'flow' ? ws.flows[t.id] ?? null : ws.charts[t.id] ?? null;
});
const meta = computed<Meta>(() => subject.value?.meta ?? { description: '', customer: '', priority: '', budget: '', tags: [] });
const locked = computed(() => subject.value?.status === 'final');
const dis = computed(() => locked.value || !props.canEdit);
const sub = computed(() => {
  const s = subject.value;
  if (!s) return '';
  const name = ('title' in s ? s.title : s.name) || 'Untitled';
  return `Metadata for “${name}” — searched by the ${isFlow.value ? 'gallery' : 'chart'} filter and carried into every export.`;
});

const first = ref<HTMLTextAreaElement | null>(null);
watch(subject, async (s, prev) => {
  if (!s || prev) return;
  await nextTick();
  if (first.value && !first.value.disabled) first.value.focus();
});

function commit(field: keyof Meta, e: Event): void {
  const s = subject.value;
  if (!s || !props.target?.id) return;
  if (locked.value) { shell.toast(`This ${isFlow.value ? 'flow' : 'chart'} is Final — reopen it as a draft to edit it.`, 'error'); return; }
  const value = (e.target as HTMLInputElement).value;
  const next: Meta = { ...meta.value, tags: [...meta.value.tags] };
  if (field === 'tags') next.tags = [...new Set(value.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 24);
  else if (field === 'priority') next.priority = (META_PRIORITIES as readonly string[]).includes(value) ? value as Meta['priority'] : '';
  else if (field === 'description') next.description = value;
  else next[field] = value.trim();
  if (isFlow.value) {
    const id = props.target.id;
    session.doc.transact(() => setField(maps(session.doc).flows, id, 'meta', next), LOCAL_ORIGIN);
  } else {
    setChartField(session.doc, props.target.id, 'meta', next);
  }
}

function close(): void { emit('close'); }
function onKey(e: KeyboardEvent): void { if (e.key === 'Escape' && subject.value) close(); }
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>
