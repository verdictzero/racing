/**
 * The realtime collaboration endpoint.
 *
 * One WebSocket per client, one in-memory Y.Doc per workspace shared by everyone editing it. The
 * server is a participant in the document rather than a relay: it holds the merged state, so a
 * client that reconnects after an hour offline gets caught up by a diff instead of a full reload,
 * and a client that never comes back has still had its work persisted.
 *
 * THE SYNC PROTOCOL is y-protocols/sync, the same one y-websocket speaks:
 *
 *   Step 1  client sends its state vector — "here is what I have"
 *   Step 2  server replies with the diff — "here is what you are missing"
 *   Update  either side sends changes as they happen
 *
 * Implemented here rather than by running the y-websocket server because that would be a second
 * process with its own auth story, and the whole point of the permission model is that the same
 * session decides what you may read and write everywhere.
 *
 * PERSISTENCE is append-on-update, with compaction when the log gets long. Writes are appends, so
 * two clients saving in the same instant produce two INSERTs and never contend.
 *
 * WHAT IS NOT DONE HERE, deliberately: a single process holds each document in memory, so two app
 * instances behind a load balancer would each hold their own copy and diverge. Getting past that
 * needs a shared bus (Redis pub/sub) or sticky routing by workspace id. It is called out in
 * docs/dev/ARCHITECTURE.md rather than half-built, because a half-built version of it would look
 * like it worked right up until the second instance was deployed.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { appendUpdate, loadDoc, pendingUpdateCount, compact, getWorkspace } from '@raci/db';
import { attachAutoRepair } from '@raci/crdt';
import type { Peer } from 'crossws';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly peers: Set<Peer>;
  readonly workspaceId: string;
  detachRepair: () => void;
  /** Guards against two peers loading the same workspace at once. */
  loading: Promise<void> | null;
}

/**
 * Rooms live for the life of the process.
 *
 * A room is dropped once the last peer leaves — the document is safe in the log by then, and
 * holding every workspace ever opened in memory is how a long-lived process runs out of it.
 */
const rooms = new Map<string, Room>();

/**
 * Wire document changes to persistence and to the other peers.
 *
 * Attached once per room, when it is built. Updates that came from the database on load carry the
 * 'db' origin and are skipped, so a load is never written straight back as if it were an edit.
 */
function attachRoomListeners(room: Room): void {
  room.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'db') return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder));

    // The transaction origin is the Peer that sent the update, so attribution comes for free.
    // A server-side write (a directory sync) has a string origin and is attributed to nobody.
    const userId =
      origin && typeof origin === 'object' && 'context' in origin
        ? ((origin as Peer).context as { userId?: string } | undefined)?.userId ?? null
        : null;
    void persist(room, update, userId);
  });

  room.awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }) => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed),
    );
    broadcast(room, encoding.toUint8Array(encoder));
  });
}

async function getRoom(workspaceId: string): Promise<Room> {
  const existing = rooms.get(workspaceId);
  if (existing) {
    if (existing.loading) await existing.loading;
    return existing;
  }

  const doc = new Y.Doc();
  const room: Room = {
    doc,
    awareness: new awarenessProtocol.Awareness(doc),
    peers: new Set(),
    workspaceId,
    detachRepair: () => {},
    loading: null,
  };
  rooms.set(workspaceId, room);

  room.loading = (async () => {
    const db = useDb();
    const loaded = await loadDoc(db, workspaceId);
    // 'db' origin so the load is not mistaken for a local edit and written straight back.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(loaded.doc), 'db');

    // The tree invariants a merge can break are restored server-side too, so a client that never
    // runs the repair (an API consumer, an export job) still reads a well-formed document.
    room.detachRepair = attachAutoRepair(doc, (results) => {
      for (const result of results) {
        console.warn(
          `[collab] repaired ${result.plan.cycles.length} cycle(s) and ` +
            `${result.plan.orphans.length} orphan(s) in chart ${result.chartId}`,
        );
      }
    });

    // Attached AFTER the load, so replaying the log does not re-broadcast and re-persist every
    // update the document was just built from.
    attachRoomListeners(room);
  })();

  await room.loading;
  room.loading = null;
  return room;
}

function broadcast(room: Room, message: Uint8Array, except?: Peer): void {
  for (const peer of room.peers) {
    if (peer === except) continue;
    try {
      peer.send(message);
    } catch {
      // A peer that has gone away is removed by its own close handler; a failed send here must
      // not stop the message reaching everybody else.
    }
  }
}

/** Persist a local update and compact when the log has grown long enough to be worth it. */
async function persist(room: Room, update: Uint8Array, userId: string | null): Promise<void> {
  const db = useDb();
  await appendUpdate(db, {
    workspaceId: room.workspaceId,
    update,
    userId,
    origin: 'local',
  });

  const threshold = Number(useRuntimeConfig().collabSnapshotEvery || 200);
  const pending = await pendingUpdateCount(db, room.workspaceId);
  if (pending >= threshold) {
    // Compaction is additive and safe to run while people are editing: the snapshot is written
    // first and only then is what it covers pruned.
    await compact(db, room.workspaceId).catch((err) => {
      console.error('[collab] compaction failed', err);
    });
  }
}

/**
 * Peers whose `open` hook has not finished yet.
 *
 * crossws delivers `message` as soon as the frame arrives; it does not wait for an in-flight async
 * `open`. The sync protocol loses that race every time on a cold room: the client sends sync step 1
 * — the one message that ASKS for the document — within a few milliseconds of the socket opening,
 * while `open` is still awaiting the session lookup, the workspace lookup and the room load. With
 * nothing on the peer's context yet, the handler found no room and dropped the message, and no
 * client ever re-sends step 1. The socket sat there reporting "live" against a document that stayed
 * empty forever.
 *
 * So a message waits on its own peer's open promise. Authorization still runs first, and a queued
 * message from a peer that failed it finds no room and is discarded exactly as before.
 */
const opening = new WeakMap<Peer, Promise<void>>();

async function openPeer(peer: Peer): Promise<void> {
  const url = new URL(peer.request?.url ?? '', 'http://localhost');
  const workspaceId = url.searchParams.get('workspace');
  if (!workspaceId) {
    peer.close(1008, 'workspace query parameter is required');
    return;
  }

  // The websocket carries the same session cookie as every other request, so authorization is
  // the one check it already was. A socket that skipped this would be an unauthenticated write
  // path straight into the document.
  const session = await getSocketSession(peer.request).catch((err: unknown) => {
    // Never silently: a session lookup that throws is a server fault, and swallowing it here is
    // indistinguishable from an anonymous visitor.
    console.error('[collab] session lookup failed', err);
    return null;
  });
  if (!session) {
    peer.close(1008, 'not signed in');
    return;
  }
  const workspace = await getWorkspace(useDb(), session.organizationId, workspaceId);
  if (!workspace) {
    peer.close(1008, 'no such workspace');
    return;
  }

  const room = await getRoom(workspaceId);
  room.peers.add(peer);
  // `context` is crossws's per-connection bag. It is a getter with no setter, so it is mutated
  // rather than replaced — assigning to `peer.ctx` happens to work but is off-API.
  Object.assign(peer.context, { workspaceId, userId: session.userId, role: session.role });

  // Sync step 1: tell the client what the server has, so it can ask for the difference.
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  peer.send(encoding.toUint8Array(encoder));

  // And the current presence state, so a joiner sees who else is here immediately.
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    peer.send(encoding.toUint8Array(awarenessEncoder));
  }
}

export default defineWebSocketHandler({
  open(peer) {
    // Registered synchronously — `openPeer` cannot yield before this line runs — so a message that
    // arrives immediately after the upgrade always finds a promise to wait on.
    const ready = openPeer(peer);
    opening.set(peer, ready);
    return ready;
  },

  async message(peer, message) {
    // Copied before the await: the adapter is free to reuse the frame's buffer once this returns.
    const data = new Uint8Array(message.uint8Array());
    await opening.get(peer)?.catch(() => {});

    const ctx = peer.context as { workspaceId?: string; userId?: string; role?: string };
    const room = ctx?.workspaceId ? rooms.get(ctx.workspaceId) : undefined;
    if (!room) return;
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      // A viewer may watch the document but must not write to it. Dropping the message rather
      // than closing the socket keeps read-only clients working normally.
      if (ctx?.role === 'viewer') {
        const readOnlyEncoder = encoding.createEncoder();
        encoding.writeVarUint(readOnlyEncoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, readOnlyEncoder, new Y.Doc(), peer);
        return;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, peer);
      if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
      return;
    }

    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        peer,
      );
      return;
    }
  },

  close(peer) {
    opening.delete(peer);
    const ctx = peer.context as { workspaceId?: string };
    const room = ctx?.workspaceId ? rooms.get(ctx.workspaceId) : undefined;
    if (!room) return;

    room.peers.delete(peer);
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [...room.awareness.getStates().keys()].filter((clientId) => clientId === room.doc.clientID),
      peer,
    );

    // The document is durable in the log by now, so holding it in memory only costs memory.
    if (room.peers.size === 0) {
      room.detachRepair();
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(ctx!.workspaceId!);
    }
  },

  error(peer, error) {
    console.error('[collab] socket error', error);
    peer.close(1011, 'internal error');
  },
});
