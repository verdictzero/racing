<template>
  <section>
    <h1>Workspaces</h1>
    <p v-if="!me?.user" class="note">
      <a href="/api/auth/login">Sign in</a> to see your workspaces.
    </p>
    <template v-else>
      <ul class="list">
        <li v-for="w in workspaces" :key="w.id">
          <NuxtLink :to="`/w/${w.id}`">{{ w.name }}</NuxtLink>
          <span class="dim">updated {{ new Date(w.updatedAt).toLocaleString() }}</span>
        </li>
      </ul>
      <p v-if="workspaces && workspaces.length === 0" class="note">
        Nothing here yet. Import a workspace file exported by the current tool to bring your charts
        across — nothing is re-keyed.
      </p>

      <form v-if="canEdit" class="import" @submit.prevent="create">
        <h2>New workspace</h2>
        <input v-model="name" placeholder="Workspace name" required>
        <label>
          <span>Seed from a v0.39 export (optional)</span>
          <input type="file" accept=".json" @change="pickFile">
        </label>
        <button type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create' }}</button>
        <p v-if="report" class="note">
          Imported {{ report.charts }} chart(s), {{ report.nodes }} rows,
          {{ report.flows }} flow(s), {{ report.artifacts }} deliverable(s).
          <span v-if="report.warnings.length">{{ report.warnings.length }} warning(s).</span>
        </p>
      </form>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { ImportReport } from '@raci/core';

const { data: me } = await useFetch('/api/auth/me');
const { data: workspaces, refresh } = await useFetch('/api/workspaces', {
  immediate: true,
  default: () => [],
});

const canEdit = computed(() => me.value?.user?.role === 'editor' || me.value?.user?.role === 'admin');
const name = ref('');
const legacy = ref<unknown>(undefined);
const busy = ref(false);
const report = ref<ImportReport | null>(null);

function pickFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      legacy.value = JSON.parse(String(reader.result));
      if (!name.value) name.value = file.name.replace(/\.json$/i, '');
    } catch {
      alert('That file is not valid JSON.');
    }
  };
  reader.readAsText(file);
}

async function create() {
  busy.value = true;
  try {
    const result = await $fetch<{ report: ImportReport | null }>('/api/workspaces', {
      method: 'POST',
      body: { name: name.value, legacy: legacy.value },
    });
    report.value = result.report;
    name.value = '';
    legacy.value = undefined;
    await refresh();
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
h1 { font-size: 20px; margin: 0 0 12px; }
h2 { font-size: 14px; margin: 0 0 8px; }
.list { list-style: none; padding: 0; margin: 0 0 20px; }
.list li { display: flex; gap: 12px; align-items: baseline; padding: 8px 0;
  border-bottom: 1px solid var(--border); }
.list a { color: var(--accent); text-decoration: none; }
.dim, .note { color: var(--dim); font-size: 12px; }
.import { border: 1px solid var(--border); border-radius: 8px; padding: 14px;
  max-width: 460px; display: flex; flex-direction: column; gap: 10px; }
.import input[type="text"], .import input:not([type]) { font: inherit; padding: 6px 9px;
  background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; }
.import label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); }
</style>
