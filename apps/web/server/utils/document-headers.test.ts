/**
 * The name a document is uploaded under, and what it is served with.
 *
 * The encoding half matters because a document's name is a person's file name — accents, dashes,
 * quotes — and it has to survive a header both ways. The security half matters because the file
 * is served from this origin to everyone who can read the workspace.
 */

import { describe, expect, it } from 'vitest';
import {
  documentContentDisposition,
  documentFileName,
  documentResponseHeaders,
} from './document-headers';

/** What a browser recovers from filename*: decode the RFC 8187 value. */
function nameFrom(disposition: string): string {
  const m = /filename\*=UTF-8''([^;]+)$/.exec(disposition);
  return decodeURIComponent(m![1]!);
}

describe('the upload name', () => {
  it('decodes the name the client encoded', () => {
    const name = 'Résumé – “final” (v2) 100%.pdf';
    expect(documentFileName(encodeURIComponent(name))).toBe(name);
  });

  it('keeps a name that does not decode rather than refusing the file over it', () => {
    expect(documentFileName('report%E0%A4%A.pdf')).toBe('report%E0%A4%A.pdf');
  });

  it("gives a nameless file index.html's name for one", () => {
    expect(documentFileName(undefined)).toBe('document');
    expect(documentFileName('')).toBe('document');
  });
});

describe('Content-Disposition', () => {
  it('carries any name through filename* intact', () => {
    for (const name of [
      'SOP.pdf',
      'Résumé – final.pdf',
      "O'Brien (draft) *v2*.docx",
      '報告書.xlsx',
      'a "quoted" \\ name; with=semicolon.txt',
      '😀.png',
    ]) {
      const header = documentContentDisposition('inline', name);
      expect(header.startsWith('inline; filename="')).toBe(true);
      expect(nameFrom(header)).toBe(name);
      // Header-safe: printable ASCII only, so Node will send it and no client can misparse it.
      expect(header).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it('offers an ASCII fallback that cannot break out of its quotes', () => {
    expect(documentContentDisposition('attachment', 'a "b" \\c/d%.pdf')).toBe(
      `attachment; filename="a _b_ _c_d_.pdf"; filename*=UTF-8''a%20%22b%22%20%5Cc%2Fd%25.pdf`,
    );
  });

  it('encodes the characters RFC 8187 excludes but encodeURIComponent leaves', () => {
    expect(documentContentDisposition('inline', "(it's)*")).toContain(
      "filename*=UTF-8''%28it%27s%29%2A",
    );
  });

  it('survives a name with a broken surrogate instead of throwing', () => {
    expect(() => documentContentDisposition('inline', 'bad\ud800.txt')).not.toThrow();
  });
});

describe('serving a document', () => {
  it('opens inline, or saves on request', () => {
    const doc = { contentType: 'image/png', filename: 'chart.png' };
    expect(documentResponseHeaders(doc, false)['content-disposition']).toMatch(/^inline;/);
    expect(documentResponseHeaders(doc, true)['content-disposition']).toMatch(/^attachment;/);
  });

  it('sends a file of unknown type as bytes', () => {
    expect(documentResponseHeaders({ contentType: '', filename: 'x' }, false)['content-type']).toBe(
      'application/octet-stream',
    );
  });

  it('cannot run script as this origin, whatever it claims to be', () => {
    for (const contentType of [
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      '',
    ]) {
      const headers = documentResponseHeaders({ contentType, filename: 'x' }, false);
      expect(headers['content-security-policy'], contentType).toBe('sandbox');
      expect(headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('leaves a PDF unsandboxed, because the browser will not show one sandboxed', () => {
    const headers = documentResponseHeaders(
      { contentType: 'Application/PDF', filename: 'SOP.pdf' },
      false,
    );
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('is never cached where a replaced or private file could be served stale', () => {
    const headers = documentResponseHeaders(
      { contentType: 'application/pdf', filename: 'x' },
      false,
    );
    expect(headers['cache-control']).toBe('private, no-store');
  });
});
