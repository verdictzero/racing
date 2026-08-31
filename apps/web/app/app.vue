<template>
  <div class="shell">
    <header>
      <strong>{{ appName }}</strong>
      <span class="ver">Nuxt rebuild · in progress</span>
      <nav>
        <NuxtLink to="/">Workspaces</NuxtLink>
      </nav>
      <span class="spacer" />
      <span v-if="me?.user" class="who">
        {{ me.user.displayName }} <em>{{ me.user.role }}</em>
        <button @click="signOut">Sign out</button>
      </span>
      <a v-else href="/api/auth/login">Sign in</a>
    </header>
    <main><NuxtPage /></main>
  </div>
</template>

<script setup lang="ts">
const appName = useRuntimeConfig().public.appName;
const { data: me } = await useFetch('/api/auth/me');

async function signOut() {
  const result = await $fetch<{ endSessionUrl: string | null }>('/api/auth/logout', {
    method: 'POST',
  });
  // Ending only the local session leaves the IdP's cookie in place, so the next sign-in walks
  // straight back in without a prompt — which looks exactly like the logout failed.
  location.href = result.endSessionUrl ?? '/';
}
</script>

<style>
:root {
  --bg: #14161a;
  --bg-2: #1b1e24;
  --border: #2c313a;
  --text: #e6e9ef;
  --dim: #98a1b0;
  --accent: #4dabf7;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.shell { min-height: 100vh; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 14px; padding: 10px 18px;
  background: var(--bg-2); border-bottom: 1px solid var(--border); }
header .ver { font-size: 11px; color: var(--dim); }
header .spacer { flex: 1; }
header a, header nav a { color: var(--accent); text-decoration: none; }
.who { font-size: 12px; color: var(--dim); display: flex; align-items: center; gap: 8px; }
.who em { font-style: normal; border: 1px solid var(--border); border-radius: 10px; padding: 0 6px; }
main { flex: 1; padding: 18px; }
button { font: inherit; background: var(--bg-2); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .5; cursor: default; }
</style>
