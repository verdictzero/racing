import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { MAX_DOC_BYTES, decodeDataUrl, encodeDataUrl } from '@raci/core';
import { schema, workspaces } from './schema.js';
import {
  deleteDocumentBlob,
  documentDataUrls,
  getDocumentBlob,
  getDocumentBlobs,
  listDocumentBlobs,
  putDocumentBlob,
  storeEmbeddedDocuments,
} from './documents.js';
import { createOrganization, createWorkspace } from './repositories.js';
import type { Database } from './client.js';

/**
 * Real Postgres in process (PGlite), running the real migrations — including the one that moved
 * document_blob onto its (workspace_id, id) key, which is the thing most worth proving here: a
 * mock would agree that two workspaces can hold one doc id whether or not the key allows it.
 */
let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema }) as unknown as Database;
  const dir = join(import.meta.dirname, '../migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    for (const statement of readFileSync(join(dir, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim()) await pg.exec(statement.trim());
    }
  }
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function seedWorkspace(name = 'Docs') {
  const org = await createOrganization(db, 'Org', `org-${Math.random().toString(36).slice(2, 10)}`);
  return createWorkspace(db, { organizationId: org.id, name, createdBy: null });
}

const text = (s: string) => new TextEncoder().encode(s);

function put(workspaceId: string, id: string, bytes: Uint8Array, filename = `${id}.bin`) {
  return putDocumentBlob(db, {
    workspaceId,
    id,
    filename,
    contentType: 'application/octet-stream',
    bytes,
    uploadedBy: null,
  });
}

describe('the document store', () => {
  it('gives back exactly the bytes it was given, every byte value included', async () => {
    const ws = await seedWorkspace();
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 7) & 0xff);
    const info = await putDocumentBlob(db, {
      workspaceId: ws.id,
      id: 'k3j9x2qa',
      filename: 'Résumé – final.pdf',
      contentType: 'application/pdf',
      bytes,
      uploadedBy: null,
    });
    expect(info).toMatchObject({
      id: 'k3j9x2qa',
      workspaceId: ws.id,
      filename: 'Résumé – final.pdf',
      contentType: 'application/pdf',
      byteSize: 512,
    });

    const back = await getDocumentBlob(db, ws.id, 'k3j9x2qa');
    expect(back!.bytes).toEqual(bytes);
    expect(back!.filename).toBe('Résumé – final.pdf');
  });

  it('stores an empty file as an empty file, not as nothing', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'empty', new Uint8Array(0));
    const back = await getDocumentBlob(db, ws.id, 'empty');
    expect(back!.bytes).toEqual(new Uint8Array(0));
    expect(back!.byteSize).toBe(0);
  });

  it('replaces a document put twice under one id rather than failing or keeping both', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'd1', text('first version'), 'v1.txt');
    const second = await putDocumentBlob(db, {
      workspaceId: ws.id,
      id: 'd1',
      filename: 'v2.txt',
      contentType: 'text/plain',
      bytes: text('second'),
      uploadedBy: null,
    });
    expect(second).toMatchObject({ filename: 'v2.txt', contentType: 'text/plain', byteSize: 6 });

    const back = await getDocumentBlob(db, ws.id, 'd1');
    expect(back!.bytes).toEqual(text('second'));
    expect(await listDocumentBlobs(db, ws.id)).toHaveLength(1);
  });

  it('keeps one doc id apart in two workspaces — two imports of one file', async () => {
    const a = await seedWorkspace('A');
    const b = await seedWorkspace('B');
    await put(a.id, 'shared', text('A’s copy'));
    await put(b.id, 'shared', text('B’s copy'));

    expect((await getDocumentBlob(db, a.id, 'shared'))!.bytes).toEqual(text('A’s copy'));
    expect((await getDocumentBlob(db, b.id, 'shared'))!.bytes).toEqual(text('B’s copy'));

    // Removing it from one workspace leaves the other's bytes where they were.
    expect(await deleteDocumentBlob(db, a.id, 'shared')).toBe(true);
    expect(await getDocumentBlob(db, a.id, 'shared')).toBeNull();
    expect((await getDocumentBlob(db, b.id, 'shared'))!.bytes).toEqual(text('B’s copy'));
  });

  it('never reaches a document through the wrong workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    await put(theirs.id, 'secret', text('not yours'));

    expect(await getDocumentBlob(db, mine.id, 'secret')).toBeNull();
    expect(await getDocumentBlobs(db, mine.id, ['secret'])).toEqual([]);
    expect(await deleteDocumentBlob(db, mine.id, 'secret')).toBe(false);
    expect(await getDocumentBlob(db, theirs.id, 'secret')).not.toBeNull();
  });

  it('says whether a delete removed anything', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'd1', text('x'));
    expect(await deleteDocumentBlob(db, ws.id, 'd1')).toBe(true);
    expect(await deleteDocumentBlob(db, ws.id, 'd1')).toBe(false);
  });

  it('lists a workspace’s documents without their bytes', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'd1', text('one'));
    await put(ws.id, 'd2', text('two!'));
    const rows = await listDocumentBlobs(db, ws.id);
    expect(rows.map((r) => [r.id, r.byteSize])).toEqual([
      ['d1', 3],
      ['d2', 4],
    ]);
    for (const row of rows) expect(row).not.toHaveProperty('bytes');
  });

  it('fetches several by id, leaving out the ones it does not hold', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'd1', text('one'));
    await put(ws.id, 'd2', text('two'));
    const rows = await getDocumentBlobs(db, ws.id, ['d2', 'missing', 'd1']);
    expect(rows.map((r) => r.id).sort()).toEqual(['d1', 'd2']);
    expect(await getDocumentBlobs(db, ws.id, [])).toEqual([]);
  });

  it('goes with its workspace when the workspace itself is deleted', async () => {
    const ws = await seedWorkspace();
    await put(ws.id, 'd1', text('x'));
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    expect(await getDocumentBlob(db, ws.id, 'd1')).toBeNull();
  });
});

describe('a legacy file’s embedded documents', () => {
  it('stores each under its own id, and skips what the picker would refuse', async () => {
    const ws = await seedWorkspace();
    const result = await storeEmbeddedDocuments(db, {
      workspaceId: ws.id,
      uploadedBy: null,
      docs: [
        {
          id: 'sop',
          name: 'SOP.pdf',
          type: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,JVBERi0=',
        },
        {
          id: 'at-cap',
          name: 'at.bin',
          type: '',
          dataUrl: encodeDataUrl(new Uint8Array(MAX_DOC_BYTES), ''),
        },
        {
          id: 'over',
          name: 'Budget.xlsx',
          type: '',
          dataUrl: encodeDataUrl(new Uint8Array(MAX_DOC_BYTES + 1), ''),
        },
        { id: 'bad', name: 'notes.txt', type: 'text/plain', dataUrl: 'data:text/plain;base64,%%%' },
      ],
    });

    expect(result.stored).toBe(2);
    expect(result.skipped).toEqual([
      { id: 'over', reason: '"Budget.xlsx" is 3.0 MB — over the 3.0 MB per-file cap. Skipped.' },
      { id: 'bad', reason: expect.stringMatching(/^Failed to read "notes\.txt"/) },
    ]);

    const sop = await getDocumentBlob(db, ws.id, 'sop');
    expect(sop).toMatchObject({ filename: 'SOP.pdf', contentType: 'application/pdf', byteSize: 5 });
    expect(sop!.bytes).toEqual(text('%PDF-'));
    expect((await getDocumentBlob(db, ws.id, 'at-cap'))!.byteSize).toBe(MAX_DOC_BYTES);
    expect(await getDocumentBlob(db, ws.id, 'over')).toBeNull();
    expect(await getDocumentBlob(db, ws.id, 'bad')).toBeNull();
  });

  it('hands back stored bytes as the data URLs a saved file embeds', async () => {
    const ws = await seedWorkspace();
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 31) & 0xff);
    await putDocumentBlob(db, {
      workspaceId: ws.id,
      id: 'img',
      filename: 'chart.png',
      contentType: 'image/png',
      bytes,
      uploadedBy: null,
    });
    await put(ws.id, 'other', text('x'));

    // A batch size of 1 makes the batching itself part of what is tested.
    const urls = await documentDataUrls(db, ws.id, ['img', 'gone'], 1);
    expect([...urls.keys()]).toEqual(['img']);
    expect(urls.get('img')!.startsWith('data:image/png;base64,')).toBe(true);
    expect(decodeDataUrl(urls.get('img')!)!.bytes).toEqual(bytes);
  });
});
