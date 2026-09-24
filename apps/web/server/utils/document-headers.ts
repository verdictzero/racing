/**
 * How a stored document crosses HTTP: the name an upload arrives with, and the headers a download
 * leaves with. Kept free of h3 and of the database so it can be tested on its own.
 */

import { contentTypeEssence } from '@raci/core';

/**
 * The file name an upload carries in X-File-Name.
 *
 * The client sends it through encodeURIComponent because a header cannot carry "Résumé.pdf" as
 * it stands. A value that does not decode is taken as it came: refusing a file over its name
 * would be a worse outcome than a name with a stray escape in it. No name at all gets the name
 * index.html gives a nameless document.
 */
export function documentFileName(header: string | undefined): string {
  if (!header) return 'document';
  try {
    return decodeURIComponent(header) || 'document';
  } catch {
    return header;
  }
}

/**
 * Content-Disposition naming the file: an ASCII `filename` for any client that predates RFC 6266,
 * then `filename*` (RFC 8187) with the real name, which every current browser prefers.
 */
export function documentContentDisposition(
  kind: 'inline' | 'attachment',
  filename: string,
): string {
  // A lone surrogate makes encodeURIComponent throw, which would turn one oddly named file into a
  // download that fails every time. Such a name can only come from a hand-edited import.
  const name = (filename || 'document').replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '�',
  );
  const fallback = name.replace(/[^\x20-\x7e]|["\\/%]/g, '_');
  // encodeURIComponent leaves ' ( ) * alone; RFC 8187's attr-char does not allow them.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * The headers a stored document is served with.
 *
 * `inline` so a PDF or an image opens in the new tab, as index.html's openDocument opens it;
 * anything the browser cannot show it saves instead, which is also what index.html gets.
 *
 * The file is someone else's, served from this origin to everybody who can read the workspace,
 * so it must not be able to act as this origin: an HTML or SVG attachment opened in a tab would
 * otherwise run its script with the viewer's session. `sandbox` renders every such document in
 * an opaque origin with scripts off, and `nosniff` stops a browser second-guessing the declared
 * type into one that executes. PDF alone is exempt, because browsers refuse to run their PDF
 * viewer in a sandboxed document — and a PDF is shown by that viewer, never as a page of this
 * origin, so it has nothing to escape from.
 */
export function documentResponseHeaders(
  doc: { readonly contentType: string; readonly filename: string },
  download: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': doc.contentType || 'application/octet-stream',
    'content-disposition': documentContentDisposition(
      download ? 'attachment' : 'inline',
      doc.filename,
    ),
    'x-content-type-options': 'nosniff',
    // A document can be replaced under the same id, and it is somebody's private file: neither a
    // shared cache nor a stale private copy is right.
    'cache-control': 'private, no-store',
  };
  if (contentTypeEssence(doc.contentType) !== 'application/pdf') {
    headers['content-security-policy'] = 'sandbox';
  }
  return headers;
}
