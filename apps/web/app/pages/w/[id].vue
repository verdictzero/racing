<template>
  <section class="ws">
    <header class="bar">
      <h1>{{ meta?.workspace?.name ?? 'Workspace' }}</h1>
      <span class="status" :data-state="session.status.value">{{ statusLabel }}</span>
      <span v-if="session.peers.value > 1" class="dim">{{ session.peers.value }} people here</span>
      <span class="spacer" />
      <button :disabled="!canEdit" title="Undo your own last change — not anyone else's"
        @click="session.undo.undo()">Undo</button>
    </header>

    <nav class="tabs">
      <NuxtLink :to="`/w/${workspaceId}`">Chart</NuxtLink>
      <NuxtLink :to="`/w/${workspaceId}/tasks`">Tasks</NuxtLink>
      <NuxtLink :to="`/w/${workspaceId}/objects`">
        Objects
        <b v-if="objectCount">{{ objectCount }}</b>
      </NuxtLink>
    </nav>

    <NuxtPage />
  </section>
</template>

<script setup lang="ts">
/**
 * The workspace shell.
 *
 * Owns the collaborative session and the chrome every screen inside a workspace shares — the live
 * indicator, the peer count, undo. Each screen is a child route so they all read one document over
 * one socket; see `useWorkspaceSession`.
 *
 * `canEdit` is a UI affordance, never the enforcement. The server checks the role on every write
 * (`requireRole`), because a disabled button stops nobody who can open a console.
 */
const route = useRoute();
const workspaceId = route.params.id as string;

const { data: meta } = await useFetch(`/api/workspaces/${workspaceId}`);
const { data: me } = await useFetch('/api/auth/me');

const session = provideWorkspaceSession(workspaceId);

const canEdit = computed(() => me.value?.user?.role === 'editor' || me.value?.user?.role === 'admin');
provide('raci:canEdit', canEdit);

const objectCount = computed(() => {
  const ws = session.workspace.value;
  return Object.keys(ws.artifacts).length + Object.keys(ws.entities).length;
});

const statusLabel = computed(() => {
  switch (session.status.value) {
    case 'connected': return 'live';
    case 'connecting': return 'connecting…';
    default: return 'offline — your edits are kept and will sync';
  }
});
</script>

<style scoped>
.bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.bar h1 { font-size: 18px; margin: 0; }
.spacer { flex: 1; }
.status { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border); }
.status[data-state='connected'] { color: #51cf66; border-color: #2b6b3a; }
.status[data-state='offline'] { color: #ffa94d; border-color: #7a4a12; }
.dim { color: var(--dim); font-size: 12px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tabs a { color: var(--dim); text-decoration: none; font-size: 13px; padding: 7px 14px;
  border: 1px solid transparent; border-bottom: 0; border-radius: 6px 6px 0 0;
  margin-bottom: -1px; display: flex; align-items: center; gap: 6px; }
.tabs a:hover { color: var(--text); }
.tabs a.router-link-exact-active { color: var(--text); background: var(--bg-2);
  border-color: var(--border); }
.tabs b { font-weight: 600; font-size: 11px; color: var(--dim);
  border: 1px solid var(--border); border-radius: 9px; padding: 0 6px; }
</style>
