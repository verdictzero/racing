import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_DOC_BYTES,
  base64ToBytes,
  bytesToBase64,
  contentTypeEssence,
  decodeDataUrl,
  encodeDataUrl,
  formatBytes,
  normalizeContentType,
  prepareEmbeddedDocument,
  workspaceDocumentIds,
} from './documents.js';
import { importLegacy } from './legacy.js';

/**
 * The oracles are index.html's own functions, lifted out of the file at test time rather than
 * re-typed here. "Matches the source" then means the source's code, not a transcription of it
 * that could drift — and if index.html changes how it reads an attachment, this is what notices.
 */
const SOURCE = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function legacyFunction<T>(name: string): T {
  const start = SOURCE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`index.html no longer defines ${name}()`);
  const end = SOURCE.indexOf('\n}\n', start);
  return new Function(`${SOURCE.slice(start + 1, end + 2)}\nreturn ${name};`)() as T;
}

/** index.html turns a stored doc into a Blob with this to open or download it. */
const docToBlob =
  legacyFunction<(doc: { dataUrl: string; type?: string }) => Blob | null>('docToBlob');
const fmtBytes = legacyFunction<(n: number) => string>('fmtBytes');

/** What index.html gets out of a dataUrl: its bytes and Blob type, or null where it fails. */
async function sourceReads(dataUrl: string): Promise<{ type: string; bytes: number[] } | null> {
  let blob: Blob | null;
  try {
    blob = docToBlob({ dataUrl, type: '' });
  } catch {
    return null; // atob or decodeURIComponent threw — the source cannot open this file
  }
  if (!blob) return null;
  return { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function randomBytes(length: number, seed: number): Uint8Array {
  // Deterministic, so a failure reproduces. Every byte value turns up across the lengths used.
  const out = new Uint8Array(length);
  let x = seed || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

describe('formatBytes', () => {
  it('prints every size exactly as index.html does', () => {
    const sizes = [
      0,
      -1,
      NaN,
      Infinity,
      1,
      512,
      1023,
      1024,
      1025,
      1536,
      10_239,
      10_240,
      1_048_575,
      1_048_576,
      MAX_DOC_BYTES,
      MAX_DOC_BYTES + 1,
      3.4 * 1_048_576,
      1_073_741_824,
      5e12,
    ];
    for (const n of sizes) expect(formatBytes(n), String(n)).toBe(fmtBytes(n));
  });
});

describe('base64', () => {
  it('encodes the RFC 4648 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='],
      ['fooba', 'Zm9vYmE='],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [text, encoded] of vectors) {
      expect(bytesToBase64(new TextEncoder().encode(text))).toBe(encoded);
      expect(base64ToBytes(encoded)).toEqual(new TextEncoder().encode(text));
    }
  });

  it('agrees with the platform encoder on every byte value and every tail length', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToBase64(all)).toBe(Buffer.from(all).toString('base64'));
    for (let length = 0; length < 70; length++) {
      const bytes = randomBytes(length, length + 7);
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(encoded)).toEqual(bytes);
    }
  });

  it('accepts and refuses exactly what atob does', () => {
    // atob is what index.html opens a document with, so this is the line that matters: a dataUrl
    // accepted here and refused there would import cleanly and then never open in the source.
    const inputs = [
      '',
      'Zg',
      'Zg=',
      'Zg==',
      'Zg===',
      'Zm9v',
      'Zm9vYg',
      'Z',
      'Zm9vY',
      '=',
      '==',
      '====',
      'Zm9v=',
      'Zm9v==',
      'Zm 9v\n',
      '\tZm9v\f\r',
      ' Z g = = ',
      'Zm9v ',
      'Zm-v',
      'Zm_v',
      'Zm9v!',
      'YQ==YQ==',
      'YR==',
      'YWJj\nZGVm',
      'Zm9vYmFy',
      'é',
      'Zm9v ',
    ];
    for (const input of inputs) {
      let expected: Uint8Array | null;
      try {
        expected = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
      } catch {
        expected = null;
      }
      expect(base64ToBytes(input), JSON.stringify(input)).toEqual(expected);
    }
  });

  it('handles a file at the size cap', () => {
    const bytes = randomBytes(MAX_DOC_BYTES, 3);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    // Buffer.compare, not toEqual: a deep equality over 3M elements takes the test ten seconds.
    expect(Buffer.compare(base64ToBytes(encoded)!, bytes)).toBe(0);
  });
});

describe('data URLs', () => {
  it('writes what readAsDataURL writes', () => {
    expect(encodeDataUrl(new TextEncoder().encode('Hi'), 'text/plain')).toBe(
      'data:text/plain;base64,SGk=',
    );
    // A file whose type the browser does not know: readAsDataURL writes octet-stream.
    expect(encodeDataUrl(bytesOf(1, 2, 3), '')).toBe('data:application/octet-stream;base64,AQID');
    expect(encodeDataUrl(bytesOf(), 'application/pdf')).toBe('data:application/pdf;base64,');
  });

  it('never writes a type that is not a media type', () => {
    expect(encodeDataUrl(bytesOf(0), 'text/plain\r\nX-Evil: 1')).toBe(
      'data:application/octet-stream;base64,AA==',
    );
    expect(encodeDataUrl(bytesOf(0), 'not a type')).toBe(
      'data:application/octet-stream;base64,AA==',
    );
  });

  it('writes files index.html can open byte for byte', async () => {
    // The Save round trip: bytes from the blob store, out through encodeDataUrl into the JSON
    // file, and back in through the source's own docToBlob.
    const types = ['application/pdf', 'image/png', 'text/plain;charset=utf-8', ''];
    for (let length = 0; length < 40; length++) {
      const bytes = randomBytes(length * 13, length + 1);
      const type = types[length % types.length]!;
      const read = await sourceReads(encodeDataUrl(bytes, type));
      expect(read).not.toBeNull();
      expect(read!.bytes).toEqual([...bytes]);
      expect(read!.type).toBe(contentTypeEssence(type) || 'application/octet-stream');
    }
  });

  it('reads every dataUrl the way index.html reads it', async () => {
    const corpus = [
      'data:application/pdf;base64,JVBERi0xLjQK',
      'data:text/plain;base64,SGVsbG8sIHdvcmxkIQ==',
      'data:text/plain;charset=utf-8;base64,SGk=',
      'data:;base64,AAEC',
      'data:text/plain,Hello%2C%20world',
      'data:,Caf%C3%A9',
      'data:image/png;base64,iVBORw0KGgo=',
      'data:application/octet-stream;base64,',
      'data:text/plain;base64,QUJDRA',
      'data:text/plain;base64,QUJD RA==',
      'DATA:TEXT/PLAIN;BASE64,SGk=',
      // and the ones it cannot open, which must be refused rather than stored
      'data:text/plain;base64,@@@@',
      'data:text/plain;base64,QUJ-RA==',
      'data:text/plain;base64,QQ=QQ==',
      'data:text/plain,%E0%A4%A',
      'data:text/plain,100%',
      'not a data url',
      'data:text/plain;base64',
      'data:',
      '',
    ];
    for (const url of corpus) {
      const source = await sourceReads(url);
      const ours = decodeDataUrl(url);
      if (source === null) {
        expect(ours, url).toBeNull();
      } else {
        expect(ours, url).not.toBeNull();
        expect([...ours!.bytes], url).toEqual(source.bytes);
        expect(contentTypeEssence(ours!.type) || 'application/octet-stream', url).toBe(source.type);
      }
    }
  });

  it('keeps the parameters of a media type, not only its essence', () => {
    expect(decodeDataUrl('data:text/plain;charset=utf-8;base64,SGk=')!.type).toBe(
      'text/plain;charset=utf-8',
    );
    expect(decodeDataUrl('data:;base64,SGk=')!.type).toBe('');
  });

  it('reads a base64 payload wrapped across lines, which docToBlob stops at', () => {
    // atob would strip the breaks; only docToBlob's regex trips on them. Stored, it saves unwrapped.
    expect(decodeDataUrl('data:text/plain;base64,SGVs\nbG8=')!.bytes).toEqual(
      new TextEncoder().encode('Hello'),
    );
  });

  it('reads an empty file in the form readAsDataURL writes one', () => {
    expect(decodeDataUrl('data:text/plain;base64,')).toEqual({
      type: 'text/plain',
      bytes: new Uint8Array(0),
    });
  });
});

describe('normalizeContentType', () => {
  it('keeps a real media type exactly as given', () => {
    for (const type of [
      'application/pdf',
      'image/svg+xml',
      'text/plain;charset=UTF-8',
      'text/plain; charset="utf-8"',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'multipart/form-data; boundary=----WebKitFormBoundaryx7',
      'text/plain;',
    ]) {
      expect(normalizeContentType(type)).toBe(type);
    }
    expect(normalizeContentType('  application/pdf  ')).toBe('application/pdf');
  });

  it('turns anything that could not be sent back as a header into unknown', () => {
    for (const type of [
      '',
      'pdf',
      'text/plain\r\nSet-Cookie: x=1',
      'text/plain; charset=ü',
      'text /plain',
      'a/b/c',
      `application/${'x'.repeat(300)}`,
      42,
      null,
      undefined,
    ]) {
      expect(normalizeContentType(type), String(type)).toBe('');
    }
  });

  it('reduces a type to its essence for comparison', () => {
    expect(contentTypeEssence('Application/PDF; x=1')).toBe('application/pdf');
    expect(contentTypeEssence('')).toBe('');
  });
});

describe('prepareEmbeddedDocument', () => {
  it('decodes a document ready to store', () => {
    const result = prepareEmbeddedDocument({
      id: 'k3j9x2qa',
      name: 'SOP.pdf',
      type: 'application/pdf',
      dataUrl: 'data:application/pdf;base64,JVBERi0=',
    });
    expect(result).toEqual({
      ok: true,
      doc: {
        id: 'k3j9x2qa',
        name: 'SOP.pdf',
        type: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-'),
      },
    });
  });

  it("takes the dataUrl's own type first and the doc's second, as docToBlob does", () => {
    const own = prepareEmbeddedDocument({
      id: 'd1',
      name: 'a.txt',
      type: 'application/pdf',
      dataUrl: 'data:text/plain;base64,SGk=',
    });
    expect(own.ok && own.doc.type).toBe('text/plain');

    const fallback = prepareEmbeddedDocument({
      id: 'd2',
      name: 'a.bin',
      type: 'application/zip',
      dataUrl: 'data:;base64,SGk=',
    });
    expect(fallback.ok && fallback.doc.type).toBe('application/zip');
  });

  it('holds an import to the same cap as the picker, and says so the way index.html does', () => {
    const at = prepareEmbeddedDocument({
      id: 'at',
      name: 'at.bin',
      type: '',
      dataUrl: encodeDataUrl(new Uint8Array(MAX_DOC_BYTES), ''),
    });
    expect(at.ok).toBe(true);

    const over = prepareEmbeddedDocument({
      id: 'over',
      name: 'Budget.xlsx',
      type: '',
      dataUrl: encodeDataUrl(new Uint8Array(MAX_DOC_BYTES + 1), ''),
    });
    expect(over).toEqual({
      ok: false,
      id: 'over',
      reason: '"Budget.xlsx" is 3.0 MB — over the 3.0 MB per-file cap. Skipped.',
    });
  });

  it('refuses bytes index.html could not open, naming the file', () => {
    const result = prepareEmbeddedDocument({
      id: 'bad',
      name: 'notes.txt',
      type: 'text/plain',
      dataUrl: 'data:text/plain;base64,%%%',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.id).toBe('bad');
    expect(!result.ok && result.reason).toMatch(/^Failed to read "notes\.txt"/);
  });

  it('gives a nameless document the name index.html gives it', () => {
    const result = prepareEmbeddedDocument({ id: 'x', name: '', type: '', dataUrl: 'data:,a' });
    expect(result.ok && result.doc.name).toBe('document');
  });
});

describe('workspaceDocumentIds', () => {
  it('lists every doc a chart row or a deliverable holds, each once', () => {
    const { workspace } = importLegacy({
      artifacts: [
        { id: 'a_1', name: 'Spec', doc: { id: 'd_spec', name: 'spec.pdf' } },
        { id: 'a_2', name: 'No doc' },
      ],
      charts: [
        {
          id: 'c_1',
          activities: [
            {
              id: 'n1',
              name: 'Row',
              documents: [{ id: 'd_1', name: 'one.pdf' }],
              children: [
                {
                  id: 'n2',
                  name: 'Child',
                  documents: [{ id: 'd_2' }, { id: 'd_1' }],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(workspaceDocumentIds(workspace).sort()).toEqual(['d_1', 'd_2', 'd_spec']);
  });
});
