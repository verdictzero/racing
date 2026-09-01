/**
 * The collaboration socket's open/message ordering.
 *
 * This pins a bug that every unit test in the repository missed and that made the whole app look
 * empty: crossws delivers `message` without waiting for an in-flight async `open`, and a client
 * sends sync step 1 — the one message that ASKS for the document — within milliseconds of the
 * socket opening. While `open` was still awaiting the session lookup and the room load there was
 * nothing on the peer's context, so the step-1 message was dropped. No client re-sends it, so the
 * socket reported itself live against a document that stayed empty forever.
 *
 * The test drives the real handler with a room load slow enough to lose that race reliably.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;

/** How long the mocked room load takes. Any client is far quicker than this. */
const LOAD_MS = 40;

const serverDoc = new Y.Doc();
serverDoc.getMap('charts').set('c_1', 'a chart the client must receive');

vi.mock('@raci/db', () => ({
  appendUpdate: vi.fn(async () => {}),
  pendingUpdateCount: vi.fn(async () => 0),
  compact: vi.fn(async () => {}),
  getWorkspace: vi.fn(async () => ({ id: 'w1', name: 'W' })),
  loadDoc: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, LOAD_MS));
    return { doc: serverDoc };
  }),
}));

interface FakePeer {
  request: { url: string; headers: Headers };
  context: Record<string, unknown>;
  sent: Uint8Array[];
  closed: { code: number; reason: string } | null;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

function makePeer(workspace = 'w1'): FakePeer {
  return {
    request: {
      url: `http://localhost:3000/api/collab?workspace=${workspace}`,
      headers: new Headers({ cookie: 'raci_session=token' }),
    },
    context: {},
    sent: [],
    closed: null,
    send(data) {
      this.sent.push(new Uint8Array(data));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}

/** The client's opening move: "here is what I have", which is nothing. */
function syncStep1From(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Apply every sync frame the peer was sent to `into`, exactly as the real client would. */
function applySyncFrames(peer: FakePeer, into: Y.Doc): void {
  for (const frame of peer.sent) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), into, 'test');
  }
}

async function loadHandler() {
  vi.stubGlobal('defineWebSocketHandler', (handler: unknown) => handler);
  vi.stubGlobal('useDb', () => ({}));
  vi.stubGlobal('useRuntimeConfig', () => ({ collabSnapshotEvery: '200' }));
  vi.stubGlobal('getSocketSession', async () => ({
    userId: 'u1',
    organizationId: 'o1',
    displayName: 'Tester',
    email: null,
    role: 'editor',
    sessionId: 's1',
  }));
  const mod = await import('./collab');
  return mod.default as unknown as {
    open(peer: unknown): Promise<void>;
    message(peer: unknown, message: { uint8Array(): Uint8Array }): Promise<void>;
    close(peer: unknown): void;
  };
}

describe('the collaboration socket', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('answers a sync step 1 that arrives while open is still loading the room', async () => {
    const handler = await loadHandler();
    const peer = makePeer();
    const clientDoc = new Y.Doc();

    // Exactly the real sequence: the client does not wait for the server's greeting before asking.
    const opened = handler.open(peer);
    const delivered = handler.message(peer, { uint8Array: () => syncStep1From(clientDoc) });
    await Promise.all([opened, delivered]);

    expect(peer.closed).toBeNull();
    applySyncFrames(peer, clientDoc);
    expect(clientDoc.getMap('charts').get('c_1')).toBe('a chart the client must receive');

    handler.close(peer);
  });

  it('still answers a sync step 1 that arrives after open has finished', async () => {
    const handler = await loadHandler();
    const peer = makePeer();
    const clientDoc = new Y.Doc();

    await handler.open(peer);
    await handler.message(peer, { uint8Array: () => syncStep1From(clientDoc) });

    applySyncFrames(peer, clientDoc);
    expect(clientDoc.getMap('charts').get('c_1')).toBe('a chart the client must receive');

    handler.close(peer);
  });

  it('closes an unauthenticated socket instead of serving it', async () => {
    vi.stubGlobal('defineWebSocketHandler', (handler: unknown) => handler);
    vi.stubGlobal('useDb', () => ({}));
    vi.stubGlobal('useRuntimeConfig', () => ({ collabSnapshotEvery: '200' }));
    vi.stubGlobal('getSocketSession', async () => null);
    const handler = (await import('./collab')).default as unknown as {
      open(peer: unknown): Promise<void>;
    };

    const peer = makePeer();
    await handler.open(peer);

    expect(peer.closed).toEqual({ code: 1008, reason: 'not signed in' });
    expect(peer.sent).toHaveLength(0);
  });
});
