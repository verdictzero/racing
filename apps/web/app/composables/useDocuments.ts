/**
 * Process documents on a chart row — index.html's addDocumentsToNode, openDocument,
 * downloadDocument and deleteDocument.
 *
 * The row holds the metadata (id, name, type, size); the bytes live server-side, keyed by
 * (workspace, doc id), exactly as the source keeps them in IndexedDB rather than in its state:
 *   PUT    /api/workspaces/:id/documents/:docId   raw bytes, X-File-Name — editor
 *   GET    /api/workspaces/:id/documents/:docId   inline; ?download=1 for attachment
 *   DELETE /api/workspaces/:id/documents/:docId   editor
 * The client mints the id, so an imported file's rows and their bytes keep the same ids.
 */
import type { DocRef } from '@raci/core';
import { LOCAL_ORIGIN, maps, setField } from '@raci/crdt';

/** index.html's MAX_DOC_BYTES: a soft cap per file. */
export const MAX_DOC_BYTES = 3 * 1024 * 1024;

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/** index.html's docIconFor — keeps the chip dense. */
export function docIconFor(name: string, type: string): string {
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) return '📊';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📽';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return '🖼';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return '🗜';
  if (['md', 'txt', 'log'].includes(ext) || (type || '').startsWith('text/')) return '📃';
  return '📎';
}

function newDocId(): string {
  // Same shape the source's uid() produces: short, url-safe, unique enough within a workspace.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function useDocuments() {
  const session = useWorkspaceSession();
  const shell = useShell();
  const url = (docId: string) => `/api/workspaces/${session.workspaceId}/documents/${encodeURIComponent(docId)}`;

  function current(nodeId: string): DocRef[] {
    for (const chart of Object.values(session.workspace.value.charts)) {
      const n = chart.nodes[nodeId];
      if (n) return n.documents;
    }
    return [];
  }
  function write(nodeId: string, docs: DocRef[]): void {
    session.doc.transact(() => setField(maps(session.doc).nodes, nodeId, 'documents', docs), LOCAL_ORIGIN);
  }

  async function attach(nodeId: string, files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      if (file.size > MAX_DOC_BYTES) {
        alert(`"${file.name}" is ${fmtBytes(file.size)} — over the ${fmtBytes(MAX_DOC_BYTES)} per-file cap. Skipped.`);
        continue;
      }
      const id = newDocId();
      try {
        // No Content-Type of our own: the browser sends the File's, or none when it has none, and the
        // server records exactly that — index.html's `file.type || ''`.
        const saved = await $fetch<DocRef>(url(id), {
          method: 'PUT',
          body: file,
          headers: { 'X-File-Name': encodeURIComponent(file.name) },
        });
        // Re-read at write time, not before the upload: a collaborator may have attached one too.
        write(nodeId, [...current(nodeId), { id: saved.id ?? id, name: file.name, type: file.type || '', size: file.size }]);
      } catch {
        alert(`Failed to read "${file.name}".`);
      }
    }
  }

  /** Open in a new tab — PDFs and images preview inline; other types are saved by the browser. */
  function open(docId: string): void {
    const w = window.open(url(docId), '_blank', 'noopener');
    if (!w) download(docId);
  }
  function download(docId: string): void { location.href = `${url(docId)}?download=1`; }

  async function remove(nodeId: string, docId: string): Promise<void> {
    const doc = current(nodeId).find((d) => d.id === docId);
    if (!doc) return;
    if (!confirm(`Remove "${doc.name}" from this activity?`)) return;
    write(nodeId, current(nodeId).filter((d) => d.id !== docId));
    // The row stops pointing at it first; losing the blob delete only strands bytes nobody can see.
    await $fetch(url(docId), { method: 'DELETE' }).catch(() => shell.toast('The file was unlinked, but the server kept its copy.', 'error'));
  }

  return { attach, open, download, remove };
}
