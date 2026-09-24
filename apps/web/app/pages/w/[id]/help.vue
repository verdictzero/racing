<template>
  <div class="ws-page">
    <div id="help-wrap">
      <div id="help-docbar" role="tablist" aria-label="Field guides">
        <span class="hd-label">Guides</span>
        <button v-for="(d, i) in HELP_DOCS" :key="d.name" type="button" role="tab" :data-help-doc="i"
          :class="{ active: i === current }" @click="current = i">{{ d.label }}</button>
      </div>
      <iframe v-for="(d, i) in HELP_DOCS" :id="d.frameId" :key="d.name" ref="frames" class="help-frame"
        :class="{ 'hf-hidden': i !== current }" :title="d.title" loading="lazy" :srcdoc="html[d.name] ?? ''"
        @load="syncTheme" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The field guides — index.html's renderHelp: a doc bar and one frame per guide, built once and
 * kept, so switching guides keeps each one's scroll position. The theme is stamped onto each
 * guide's <html> before it goes into srcdoc and re-asserted on load and on every theme change,
 * because the guides carry their own palettes keyed off data-theme.
 */
const HELP_DOCS = [
  { name: 'nested-raci', frameId: 'help-frame', label: '📖 Nested RACI — the basics',
    title: 'Understanding Nested RACIs — a field guide' },
  { name: 'chart-flows-tasks', frameId: 'help-frame-2', label: '⚓ Chart · Flow · Tasks — how it fits',
    title: 'Chart, Flow & Tasks — how it fits together' },
  { name: 'how-to', frameId: 'help-frame-3', label: '🛠 How do I use this tool',
    title: 'How do I use this tool — the manual' },
] as const;

/** Transient, like the source's _helpDoc: which guide is up resets to the basics on reload. */
const current = ref(0);
const { theme } = useTheme();
const frames = ref<HTMLIFrameElement[]>([]);
const html = ref<Record<string, string>>({});

onMounted(async () => {
  const entries = await Promise.all(HELP_DOCS.map(async (d) => {
    const text = await $fetch<string>(`/api/guides/${d.name}`, { responseType: 'text' })
      .catch(() => '<p style="font-family:sans-serif;padding:24px">Help content unavailable.</p>');
    return [d.name, stamp(text)] as const;
  }));
  html.value = Object.fromEntries(entries);
});

function stamp(text: string): string {
  const t = document.documentElement.getAttribute('data-theme') || 'dark';
  return text.replace(/<html\b([^>]*)>/i, (_m, attrs: string) =>
    `<html${attrs.replace(/\sdata-theme="[^"]*"/i, '')} data-theme="${t}">`);
}
function syncTheme(): void {
  const t = document.documentElement.getAttribute('data-theme') || 'dark';
  for (const f of frames.value) {
    try { f.contentDocument?.documentElement?.setAttribute('data-theme', t); } catch { /* not loaded yet */ }
  }
}
watch(theme, () => nextTick(syncTheme));
</script>
