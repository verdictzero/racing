/**
 * One collaborative session per workspace, shared by every screen inside it.
 *
 * `useCollab` opens a websocket and builds a Y.Doc. Calling it from each screen would mean one
 * socket, one document and one undo manager PER SCREEN — so moving from the chart to the gallery
 * would quietly double them, and an undo pressed on one screen would not see the edit made on the
 * other. The session is created once by the workspace shell and provided down.
 *
 * It also does the document read in one place. Every screen wants a plain `Workspace` rather than a
 * tree of `Y.Map`s, and re-reading per screen walks the same document repeatedly for one answer.
 *
 * WHY A WHOLE-DOCUMENT READ. It is O(rows + steps) on every change, which sounds wasteful and is
 * not yet: Yjs fires one `update` per transaction, so a keystroke costs one pass over a few hundred
 * records. If a document ever grows enough to need finer bindings, the seam to cut is here and
 * nowhere else — nothing downstream knows the difference.
 *
 * The Y.Doc itself is built during setup, on the server too. That is deliberate and free: a CRDT
 * document with nothing in it costs nothing, and building it eagerly means a child route can write
 * through `session.doc` in its own setup without a null check on every mutation. Only the socket is
 * client-only, and `useCollab` already guards that.
 */

import type * as Y from 'yjs';
import { readWorkspace } from '@raci/crdt';
import { emptyWorkspace, type Workspace } from '@raci/core';

export interface WorkspaceSession {
  readonly workspaceId: string;
  readonly doc: Y.Doc;
  readonly undo: Y.UndoManager;
  readonly status: Ref<CollabStatus>;
  readonly peers: Ref<number>;
  /** The document as a plain workspace, refreshed once per transaction. */
  readonly workspace: Ref<Workspace>;
  /** False until the first sync lands, so a screen can say "loading" rather than "empty". */
  readonly ready: Ref<boolean>;
}

const KEY = Symbol('raci:workspace-session') as InjectionKey<WorkspaceSession>;

/** Called once, by the workspace shell. */
export function provideWorkspaceSession(workspaceId: string): WorkspaceSession {
  const collab = useCollab(workspaceId);
  const workspace = shallowRef<Workspace>(emptyWorkspace());
  const ready = ref(false);

  const refresh = () => {
    workspace.value = readWorkspace(collab.doc);
    // An empty document is a real state — a brand new workspace — so readiness is "the socket has
    // spoken", not "there is something to show". Otherwise a genuinely empty workspace would sit on
    // a loading spinner forever.
    ready.value = true;
  };

  if (import.meta.client) {
    collab.doc.on('update', refresh);
    onBeforeUnmount(() => {
      collab.doc.off('update', refresh);
      collab.destroy();
    });
    // Sync step 1 may already have landed for a warm cache.
    if (collab.status.value === 'connected') refresh();
  }

  const session: WorkspaceSession = {
    workspaceId,
    doc: collab.doc,
    undo: collab.undo,
    status: collab.status,
    peers: collab.peers,
    workspace,
    ready,
  };
  provide(KEY, session);
  return session;
}

/** Called by any screen inside the workspace. */
export function useWorkspaceSession(): WorkspaceSession {
  const session = inject(KEY, null);
  if (!session) throw new Error('useWorkspaceSession() called outside a workspace route');
  return session;
}
