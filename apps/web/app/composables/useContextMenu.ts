/**
 * The right-click menu — one system for every screen, exactly as index.html has one (`openCtxMenu`).
 *
 * A screen builds the item list for the thing under the cursor and hands it over; the shell draws
 * the menu (ShellContextMenu), positions it, drives it from the keyboard and dismisses it. Items use
 * index.html's shape, so a builder ported from the source reads the same as its original.
 *
 *   function onContext(e: MouseEvent) {
 *     if (menu.open(e.clientX, e.clientY, [
 *       { title: 'Portfolio activity' },
 *       { label: 'Rename', ico: '✎', run: () => … },
 *       { sep: true },
 *       canEdit ? { label: 'Delete', ico: '🗑', danger: true, run: () => … } : CTX_LOCK_NOTE,
 *     ])) e.preventDefault();
 *   }
 */

export type CtxItem =
  | { sep: true }
  | { title: string }
  | { note: string }
  | {
      label: string;
      ico?: string;
      kbd?: string;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      run?: () => void;
    };

/** Falsy entries are dropped, so a builder can write `cond && { … }` inline, as the source does. */
export type CtxEntry = CtxItem | false | null | undefined;

interface MenuState {
  x: number;
  y: number;
  items: CtxItem[];
}

// Module state rather than useState: it holds functions, is only ever touched from client event
// handlers, and must be the same object for the screen that opens it and the shell that draws it.
const state = shallowRef<MenuState | null>(null);

function isAction(it: CtxItem): it is Extract<CtxItem, { label: string }> {
  return 'label' in it;
}

/**
 * Open the menu at viewport coordinates. Returns true when a menu went up — the caller then calls
 * `preventDefault()`, and only then, so "nothing to offer" leaves the browser's own menu working.
 */
function open(x: number, y: number, entries: CtxEntry[]): boolean {
  const live = entries.filter((e): e is CtxItem => Boolean(e));
  // Trim separators that ended up at an edge or doubled once the falsy entries were dropped.
  const items = live.filter(
    (it, i) => !('sep' in it) || (i > 0 && i < live.length - 1 && !('sep' in live[i - 1]!)),
  );
  // Nothing to run AND nothing to explain → let the browser have the event. A note alone is enough
  // reason to show a menu: it answers "why is there no × on this?", which a lock creates.
  if (!items.some((it) => (isAction(it) && it.run) || 'note' in it)) {
    state.value = null;
    return false;
  }
  state.value = { x, y, items };
  return true;
}

function close(): void {
  state.value = null;
}

export function useContextMenu() {
  return { open, close, state: readonly(state) };
}
