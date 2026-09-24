<template>
  <div id="xlsx-overlay" role="dialog" aria-modal="true" aria-labelledby="xlsx-title"
    :class="{ open }" @click.self="emit('close')">
    <div id="xlsx-card">
      <h2 id="xlsx-title">📗 Excel</h2>
      <p class="nc-sub">Build a chart from a spreadsheet — or get the blank workbook to fill in first.</p>
      <div class="nc-options">
        <button type="button" class="nc-opt" data-xlsx="import" @click="pick">
          <span class="nc-name">⭱ Import a workbook</span>
          <span class="nc-desc">Read a filled-in <code>.xlsx</code> and turn it into a chart. It arrives as a <b>new tab</b> behind a summary of what was found — nothing already open is touched. Real spreadsheets are fine: the header row is found rather than assumed, and a title, notes or blank rows above the table are ignored.</span>
        </button>
        <button type="button" class="nc-opt" data-xlsx="template" @click="template">
          <span class="nc-name">⭳ Download the input template</span>
          <span class="nc-desc">A blank workbook laid out the way the importer reads it: the first columns are the hierarchy, the rest are your parties. Naming a parent on a child's row creates it, so there is no scaffolding to write by hand.</span>
        </button>
      </div>
      <button id="xlsx-cancel" type="button" class="nc-cancel" @click="emit('close')">Cancel</button>
    </div>
  </div>
  <input id="file-xlsx" ref="input" type="file" data-lock-ok
    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" @change="onFile">
</template>

<script setup lang="ts">
/** The Excel chooser — index.html's #xlsx-overlay: import a workbook, or get the blank template. */
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const session = useWorkspaceSession();
const importWorkbook = useXlsxImport();
const input = ref<HTMLInputElement | null>(null);

function pick(): void { emit('close'); input.value?.click(); }
function template(): void {
  emit('close');
  location.href = `/api/workspaces/${session.workspaceId}/export?format=template`;
}
async function onFile(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = '';
  if (f) await importWorkbook(f);
}
</script>
