<template>
  <!-- index.html's bizGalleryHtml: every flow, recognisable by its SHAPE. -->
  <aside id="bz-gallery-pane" class="bz-gallery" @click="onClick" @contextmenu="onContext" @dragstart="onDragStart">
    <div class="bz-gal-head">
      <h3>Flow gallery</h3>
      <button id="bz-gal-close" type="button" title="Hide the gallery — ⊞ Gallery in the toolbar brings it back">×</button>
    </div>
    <input id="bz-gal-filter" type="search" data-lock-ok placeholder="Filter flows…" :value="q" spellcheck="false" @input="onFilter">
    <div class="bz-gal-hint">Click to open · drag onto the canvas to nest</div>
    <div class="bz-gal-list">
      <article v-for="c in cards" :key="c.b.id" class="bz-gal-card" :class="{ 'is-active': c.active, 'is-blocked': c.blocked }"
        :draggable="c.blocked ? undefined : 'true'" :data-gal-case="c.b.id" :title="c.title">
        <svg v-if="c.thumb" class="bz-gal-thumb" viewBox="0 0 100 52" aria-hidden="true">
          <line v-for="(l, i) in c.thumb.lines" :key="`l${i}`" :x1="l[0]" :y1="l[1]" :x2="l[2]" :y2="l[3]" />
          <rect v-for="(r, i) in c.thumb.boxes" :key="`r${i}`" :class="r.sub ? 'is-sub' : ''" :x="r.x" :y="r.y" :width="c.thumb.w" :height="c.thumb.h" rx="1.2" />
        </svg>
        <div v-else class="bz-gal-thumb is-empty">no steps yet</div>
        <div class="bz-gal-name"><span class="bz-gal-status" :class="`is-${c.status}`" :title="ART_STATUS_META[c.status].blurb">{{ ART_STATUS_META[c.status].short }}</span>{{ c.b.name || 'Untitled' }}<span
          v-if="c.active" class="bz-gal-open">open</span></div>
        <div class="bz-gal-meta">
          <span>{{ c.n }} step{{ c.n === 1 ? '' : 's' }}</span>
          <span>{{ c.e }} handoff{{ c.e === 1 ? '' : 's' }}</span>
          <span v-if="c.nSub" class="is-sub" :title="`Contains ${c.nSub} nested flow${c.nSub === 1 ? '' : 's'}`">⧉ {{ c.nSub }}</span>
          <span v-if="c.hosts" class="is-reused" :title="`Nested inside ${c.hosts} other flow${c.hosts === 1 ? '' : 's'}`">↻ {{ c.hosts }}</span>
        </div>
        <div v-if="c.b.meta.tags.length" class="bz-gal-tags">
          <span v-for="tag in c.b.meta.tags.slice(0, 4)" :key="tag" class="bz-gal-tag">{{ tag }}</span>
          <span v-if="c.b.meta.tags.length > 4" class="bz-gal-tag" :title="c.b.meta.tags.slice(4).join(', ')">+{{ c.b.meta.tags.length - 4 }}</span>
        </div>
        <div v-if="c.anchor" class="bz-gal-anchor" title="Anchored to a chart task">⚓ {{ c.anchor }}</div>
        <div class="bz-gal-acts">
          <button type="button" :data-gal-open="c.b.id" :disabled="c.active" title="Open this flow (same as picking it in the dropdown)">Open</button>
          <!-- A viewer, like a Final flow, has no ⧉ Nest to reach for. -->
          <button v-if="canEdit" type="button" :data-gal-embed="c.b.id" :disabled="c.blocked" :title="c.embedTip">⧉ Nest</button>
        </div>
      </article>
      <div v-if="!cards.length" class="bz-gal-none">No flow matches that filter.</div>
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * The Flow Gallery — index.html's bizGalleryHtml / bizGalleryCardsHtml / bizFlowThumbSvg and the
 * handlers around them: the live filter (bizRenderGalleryList), Open, ⧉ Nest, dragging a card onto
 * the canvas to nest it there, × (bizToggleGallery), and the gallery's right-click menus
 * (ctxFlowCardItems / ctxFlowGalleryItems).
 */
import type { Flow } from '@raci/core';
import type { CtxEntry } from '~/composables/useContextMenu';
import { ART_STATUS_META, BZ_NODE_W } from '~/composables/useFlowChrome';

const props = defineProps<{ flow: Flow | null; canEdit: boolean }>();
const chrome = useFlowChrome();
const screen = chrome.screen;
const shell = useShell();
const menu = useContextMenu();

/** _bizGalQ — kept while the pane is hidden, so it comes back filtered as it was left. */
const q = useState<string>('raci:flow:galQ', () => '');
function onFilter(e: Event): void { q.value = (e.target as HTMLInputElement).value; }

/** metaSearchText: everything the metadata block indexes, in one box. */
function searchText(b: Flow): string {
  const m = b.meta;
  return [b.name, m.description, m.customer, m.budget, m.tags.join(' ')].filter(Boolean).join(' ').toLowerCase();
}

/**
 * bizFlowThumbSvg: the whole graph in a 100×52 box at one uniform scale, so the sketch keeps the
 * real layout's proportions — which is what makes a flow recognisable at thumbnail size.
 */
function thumb(b: Flow) {
  const steps = chrome.steps(b);
  if (!steps.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of steps) {
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + BZ_NODE_W); maxY = Math.max(maxY, t.y + 130);
  }
  const s = Math.min(96 / Math.max(1, maxX - minX), 44 / Math.max(1, maxY - minY));
  const offX = (100 - (maxX - minX) * s) / 2, offY = (52 - (maxY - minY) * s) / 2;
  const bw = Math.max(3, BZ_NODE_W * s), bh = Math.max(2.2, 46 * s);
  const pos = new Map(steps.map((t) => [t.id, { x: (t.x - minX) * s + offX, y: (t.y - minY) * s + offY }]));
  const n = (v: number) => v.toFixed(1);
  const lines: string[][] = [];
  for (const e of chrome.edges(b)) {
    const f = pos.get(e.from), g = pos.get(e.to);
    if (f && g) lines.push([n(f.x + bw), n(f.y + bh / 2), n(g.x), n(g.y + bh / 2)]);
  }
  const boxes = steps.map((t) => ({ sub: chrome.isSub(t), x: n(pos.get(t.id)!.x), y: n(pos.get(t.id)!.y) }));
  return { lines, boxes, w: n(bw), h: n(bh) };
}

const cards = computed(() => {
  const act = props.flow;
  const query = q.value.trim().toLowerCase();
  return chrome.flows.value.filter((b) => !query || searchText(b).includes(query)).map((b) => {
    const active = !!act && b.id === act.id;
    // Blocked when nesting it would close a reference loop — checked across flows, not just A→A.
    const blocked = active || (!!act && chrome.wouldCycle(act.id, b.id));
    const an = chrome.anchorInfo(b);
    return {
      b,
      active,
      blocked,
      status: b.status === 'final' ? ('final' as const) : ('draft' as const),
      title: (b.meta.description || b.name || 'Untitled') + (blocked ? '' : ' — drag onto the canvas to nest it'),
      thumb: thumb(b),
      n: chrome.steps(b).length,
      e: chrome.edges(b).length,
      nSub: chrome.steps(b).filter(chrome.isSub).length,
      hosts: chrome.hostsOf(b.id).length,
      anchor: an ? an.node.name || 'untitled task' : null,
      embedTip: active ? 'A flow cannot contain itself'
        : blocked ? 'Blocked — the open flow is already nested somewhere inside this one, so embedding it would close a loop'
        : `Nest "${b.name || 'Untitled'}" inside "${act?.name || 'Untitled'}" as a single box`,
    };
  });
});

/** The gallery's clicks, in the order index.html's document listener checks them. */
function onClick(e: MouseEvent): void {
  const t = e.target as Element;
  if (t.closest('#bz-gal-close')) { chrome.toggleGallery(); return; }
  const open = t.closest<HTMLElement>('[data-gal-open]');
  if (open) { screen.switchFlow(open.dataset.galOpen!); return; }
  const embed = t.closest<HTMLElement>('[data-gal-embed]');
  if (embed) { if (props.canEdit) screen.canvas.embedAtCentre(embed.dataset.galEmbed!); return; }
  const card = t.closest<HTMLElement>('[data-gal-case]');
  if (card && !t.closest('button')) screen.switchFlow(card.dataset.galCase!);
}

// ---- drag a card onto the canvas to nest it -----------------------------------------------------
// HTML5 drag and drop, as the source does it: the drag starts outside #bz-canvas, so it can never be
// mistaken for a pan, and the browser draws the cursor feedback. The shared `dragFlowId` is the
// source of truth (index.html's _bizDragCase) — the gallery sets it here and clears it on dragend;
// the canvas owns #bz-canvas's dragover and drop, and nests the flow where it lands. The
// dataTransfer payload is a courtesy for other drop targets.
function onDragStart(e: DragEvent): void {
  const card = (e.target as Element).closest?.<HTMLElement>('[data-gal-case]');
  if (!card) return;
  screen.dragFlowId.value = card.dataset.galCase!;
  document.body.classList.add('bz-embedding');
  try { e.dataTransfer?.setData('text/plain', `bzcase:${screen.dragFlowId.value}`); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; } catch { /* some browsers refuse; the id is held above */ }
}
function endDrag(): void {
  screen.dragFlowId.value = null;
  document.body.classList.remove('bz-embedding');
  document.getElementById('bz-canvas')?.classList.remove('drop-target');
}
onMounted(() => { document.addEventListener('dragend', endDrag); });
onBeforeUnmount(() => {
  document.removeEventListener('dragend', endDrag);
  if (screen.dragFlowId.value) endDrag();
});

// ---- right-click (index.html's ctxFlowCardItems / ctxFlowGalleryItems) ---------------------------
function onContext(e: MouseEvent): void {
  const t = e.target as Element;
  // A real form field keeps the browser's own menu: spellcheck and the system clipboard live there.
  if (t.closest('input, textarea')) return;
  const card = t.closest<HTMLElement>('[data-gal-case]');
  const items = card ? cardItems(card.dataset.galCase!) : galleryItems();
  if (items && menu.open(e.clientX, e.clientY, items)) e.preventDefault();
}
function cardItems(id: string): CtxEntry[] | null {
  const b = chrome.ws.value.flows[id];
  const act = props.flow;
  if (!b || !act) return null;
  const active = b.id === act.id;
  const blocked = active || chrome.wouldCycle(act.id, id);
  const hosts = chrome.hostsOf(id).length;
  const final = b.status === 'final';
  const only = chrome.flows.value.length <= 1;
  const ro = !props.canEdit;
  return [
    { title: b.name || 'Untitled flow' },
    !active && { label: 'Open', ico: '→', run: () => screen.switchFlow(id) },
    { label: 'Nest inside the open flow', ico: '⧉', disabled: blocked || ro,
      hint: blocked ? (active ? 'A flow cannot contain itself' : 'Blocked — nesting it here would close a reference loop') : '',
      run: () => screen.canvas.embedAtCentre(id) },
    { label: 'Duplicate flow', ico: '⎘', disabled: ro, run: () => chrome.duplicateCase(id) },
    { sep: true },
    { label: 'Details…', ico: '✎', run: () => { screen.switchFlow(id); shell.openMeta('flow', id); } },
    { label: final ? 'Reopen as draft' : 'Mark final', ico: final ? '↺' : '✓', disabled: ro,
      run: () => chrome.setStatus(id, final ? 'draft' : 'final') },
    { sep: true },
    { label: 'Delete flow', ico: '✕', danger: true, disabled: only || hosts > 0 || ro,
      hint: hosts ? `Nested inside ${hosts} other flow${hosts === 1 ? '' : 's'} — remove those boxes first` : only ? 'The last flow cannot be deleted' : '',
      run: () => { screen.switchFlow(id); chrome.deleteCase(); } },
  ];
}
function galleryItems(): CtxEntry[] {
  const ro = !props.canEdit;
  return [
    { title: 'Flow gallery' },
    { label: 'New flow', ico: '＋', disabled: ro, run: () => chrome.addCase() },
    { label: 'Duplicate the open flow', ico: '⧉', disabled: ro, run: () => { if (props.flow) chrome.duplicateCase(props.flow.id); } },
    { sep: true },
    { label: 'Hide the gallery', ico: '✕', run: () => chrome.toggleGallery() },
  ];
}
</script>
