/**
 * The client half of the collaborative session.
 *
 * Connects to /api/collab, speaks the y-protocols sync handshake, and hands back a live Y.Doc.
 * Everything the UI renders reads from that document, so a change made by anyone — locally or two
 * desks away — arrives through exactly the same path and there is no separate "apply a remote
 * change" code path to get wrong.
 *
 * RECONNECTION is a backoff loop rather than a one-shot. On a government network a websocket drops
 * for a proxy timeout far more often than for anything wrong with the app, and the CRDT makes
 * reconnecting cheap: the client sends its state vector and gets back only what it missed, so an
 * edit made while disconnected is not lost, it is just late.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { attachAutoRepair, createUndoManager } from '@raci/crdt';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export type CollabStatus = 'connecting' | 'connected' | 'offline';

export interface CollabSession {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly undo: Y.UndoManager;
  readonly status: Ref<CollabStatus>;
  readonly peers: Ref<number>;
  destroy(): void;
}

export function useCollab(workspaceId: string): CollabSession {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const undo = createUndoManager(doc);
  const status = ref<CollabStatus>('connecting');
  const peers = ref(0);

  const detachRepair = attachAutoRepair(doc);

  let socket: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (bytes: Uint8Array) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(bytes);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Updates that arrived FROM the socket must not be echoed back to it.
    if (origin === 'remote') return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  };

  const onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'remote') return;
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    send(encoding.toUint8Array(encoder));
  };

  doc.on('update', onDocUpdate);
  awareness.on('update', onAwarenessUpdate);
  awareness.on('change', () => {
    peers.value = awareness.getStates().size;
  });

  function connect() {
    if (closed) return;
    status.value = 'connecting';

    const path = useRuntimeConfig().public.collabWsPath;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}${path}?workspace=${encodeURIComponent(workspaceId)}`);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      retry = 0;
      status.value = 'connected';
      // Sync step 1: "here is what I have" — the server replies with only the difference.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, doc);
      send(encoding.toUint8Array(encoder));
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const decoder = decoding.createDecoder(new Uint8Array(event.data));
      const messageType = decoding.readVarUint(decoder);

      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
        if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
        return;
      }
      if (messageType === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'remote');
      }
    };

    socket.onclose = () => {
      status.value = 'offline';
      if (closed) return;
      // Exponential backoff, capped. A dropped socket on this kind of network is usually a proxy
      // timeout, and hammering reconnects makes that worse rather than better.
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      reconnectTimer = setTimeout(connect, delay);
    };

    socket.onerror = () => socket?.close();
  }

  if (import.meta.client) connect();

  return {
    doc,
    awareness,
    undo,
    status,
    peers,
    destroy() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      detachRepair();
      socket?.close();
      awareness.destroy();
      undo.destroy();
      doc.destroy();
    },
  };
}
