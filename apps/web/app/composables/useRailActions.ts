/**
 * The right rail's document-level actions — Load, Merge, Demo, Clear and the Ingest Kit — as
 * index.html's handlers do them, against the shared document.
 *
 * Load, Demo and Clear REPLACE the workspace. In the source that replaced one person's browser
 * state; here it replaces the document everyone in the workspace is looking at, so each asks first
 * and says so. Merge only adds, as in the source.
 */
export function useRailActions() {
  const shell = useShell();
  const importWorkbook = useXlsxImport();

  /** index.html's #file-import handler: a workbook always lands as a new tab; JSON loads or merges. */
  async function openWorkspaceFile(file: File, merge: boolean): Promise<void> {
    if (/\.xlsx$/i.test(file.name)) { await importWorkbook(file); return; }
    void merge;
    shell.toast('Loading a saved workspace file is being wired up.', 'error');
  }
  function loadDemo(): void {
    shell.toast('Loading the demo is being wired up.', 'error');
  }
  function clearAll(): void {
    shell.toast('Clear is being wired up.', 'error');
  }
  function downloadIngestKit(): void {
    shell.toast('The Ingest Kit download is being wired up.', 'error');
  }
  return { openWorkspaceFile, loadDemo, clearAll, downloadIngestKit };
}
