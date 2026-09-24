<template>
  <Teleport to="body">
    <div v-if="menu" ref="el" class="ctx-menu" role="menu" :style="pos">
      <template v-for="(it, i) in menu.items" :key="i">
        <div v-if="'sep' in it" class="ctx-sep" role="separator" />
        <div v-else-if="'title' in it" class="ctx-title">{{ it.title }}</div>
        <div v-else-if="'note' in it" class="ctx-note">{{ it.note }}</div>
        <button v-else class="ctx-item" :class="{ danger: it.danger, 'is-active': active === i }"
          role="menuitem" type="button" :disabled="it.disabled" :title="it.hint" @click="run(it)">
          <span class="ctx-ico" aria-hidden="true">{{ it.ico || '' }}</span>
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.kbd" class="ctx-kbd">{{ it.kbd }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Draws the menu `useContextMenu().open()` asks for — index.html's openCtxMenu, ctxMove and its
 * dismissal listeners, as one component mounted once by the shell.
 */
import type { CtxItem } from '~/composables/useContextMenu';

const { state, close } = useContextMenu();
const menu = computed(() => state.value);
const el = ref<HTMLElement | null>(null);
const at = ref<{ x: number; y: number } | null>(null);
const active = ref(-1);

// Flip rather than clamp: a menu pinned to the bottom edge under the cursor covers the thing it
// was opened on, whereas one flipped above it never does. Measured after it renders.
watch(menu, async (m) => {
  active.value = -1;
  at.value = null;
  if (!m) return;
  await nextTick();
  const r = el.value?.getBoundingClientRect();
  if (!r) return;
  const x = m.x + r.width > window.innerWidth - 8 ? Math.max(8, m.x - r.width) : m.x;
  const y = m.y + r.height > window.innerHeight - 8
    ? Math.max(8, m.y - r.height > 8 ? m.y - r.height : window.innerHeight - r.height - 8)
    : m.y;
  at.value = { x: Math.round(x), y: Math.round(y) };
});
const pos = computed((): Record<string, string> => {
  const p = at.value ?? menu.value;
  // Hidden for the one frame before it is measured, so it never flashes at the wrong corner.
  return p ? { left: `${p.x}px`, top: `${p.y}px`, visibility: at.value ? 'visible' : 'hidden' } : {};
});

function run(it: CtxItem): void {
  if (!('label' in it) || it.disabled) return;
  close();
  it.run?.();
}

// Keyboard: the menu is opened by the context-menu KEY as often as by the mouse.
function move(dir: 1 | -1): void {
  const items = menu.value?.items ?? [];
  const enabled = items.map((it, i) => ('label' in it && !it.disabled ? i : -1)).filter((i) => i >= 0);
  if (!enabled.length) return;
  const at = enabled.indexOf(active.value);
  const next = at < 0 ? (dir > 0 ? 0 : enabled.length - 1) : (at + dir + enabled.length) % enabled.length;
  active.value = enabled[next]!;
}

function onKey(e: KeyboardEvent): void {
  if (!menu.value) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
  if (e.key === 'Enter' || e.key === ' ') {
    const it = menu.value.items[active.value];
    if (it) { e.preventDefault(); run(it); }
    return;
  }
  // Any other key is a shortcut meant for the app; the menu gets out of its way.
  close();
}
// mousedown rather than click, so the menu is gone before whatever was under it starts a drag;
// capture, so a handler that stops propagation cannot strand it on screen.
function onDown(e: MouseEvent): void {
  if (menu.value && !(e.target as Element | null)?.closest?.('.ctx-menu')) close();
}
// The menu is position:fixed, so anything scrolling under it leaves it pointing at nothing.
function onScrollish(): void { if (menu.value) close(); }

onMounted(() => {
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('scroll', onScrollish, true);
  document.addEventListener('wheel', onScrollish, { capture: true, passive: true });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDown, true);
  document.removeEventListener('scroll', onScrollish, true);
  document.removeEventListener('wheel', onScrollish, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
  close();
});
</script>
