/**
 * The right rail's document-level actions — Load, Merge, Demo, Clear and the Ingest Kit — as
 * index.html's handlers do them, against the shared document.
 *
 * Load, Demo and Clear REPLACE the workspace, and in the source that replaced one browser's state;
 * here it replaces the document everyone in the workspace has open. They keep the source's prompts
 * word for word (Demo and Clear ask, Load does not), and each is one undoable step, as each is one
 * step on index.html's undo stack. Merge only adds, as in the source.
 *
 * A Load or Demo also brings in the file's VIEW, because index.html's `state = incoming` does: the
 * screen it was saved on, its open tab and flow, the Legend, each chart's drill, panes and zoom.
 * Those are this person's camera, never the document's, so they land in the same per-browser
 * places the screens keep them.
 */
import {
  chartsInTabOrder, clearedWorkspace, importLegacy, ingestKitMarkdown, mergeLegacy, mergeToast,
  type EmbeddedDocument, type Workspace,
} from '@raci/core';
import { LOCAL_ORIGIN, loadWorkspace, readWorkspace, replaceWorkspace } from '@raci/crdt';

/** The source's view names → this app's routes. */
const VIEW_ROUTE: Record<string, string> = { chart: '', roster: '/roster', work: '/tasks', bizcase: '/flow', objects: '/objects', help: '/help' };
/** A request's worth of embedded documents: base64 is a third bigger than the bytes it carries. */
const BATCH_CHARS = 6 * 1024 * 1024;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function useRailActions() {
  const session = useWorkspaceSession();
  const shell = useShell();
  const importWorkbook = useXlsxImport();
  const activeChartId = useActiveChartId();
  const activeFlowId = useActiveFlowId();
  const { setLegend, closeDetails } = useChartView();
  const putCamera = useChartCameraStore(session.workspaceId);

  /** Store a file's attachments before its rows point at them. What cannot be stored is said once. */
  async function storeAttachments(docs: readonly EmbeddedDocument[]): Promise<void> {
    const skipped: string[] = [];
    let batch: EmbeddedDocument[] = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const body = { docs: batch };
      batch = []; size = 0;
      try {
        const r = await $fetch<{ stored: number; skipped: Array<{ id: string; reason: string }> }>(
          `/api/workspaces/${session.workspaceId}/documents/import`, { method: 'POST', body });
        skipped.push(...r.skipped.map((s) => s.reason));
      } catch {
        skipped.push(`${body.docs.length} attached document(s) could not be stored.`);
      }
    };
    for (const d of docs) {
      if (size + d.dataUrl.length > BATCH_CHARS) await flush();
      batch.push(d); size += d.dataUrl.length;
    }
    await flush();
    if (skipped.length) alert(skipped.join('\n'));
  }

  /** The view a file was saved with — index.html's `state = incoming`, minus the document. */
  function applyView(raw: Raw, ws: Workspace): void {
    const tabs = chartsInTabOrder(ws);
    const chartId = typeof raw.activeChartId === 'string' && ws.charts[raw.activeChartId] ? raw.activeChartId : tabs[0]?.id ?? null;
    activeChartId.value = chartId;
    const flowIds = Object.keys(ws.flows);
    activeFlowId.value = typeof raw.activeBizCaseId === 'string' && ws.flows[raw.activeBizCaseId] ? raw.activeBizCaseId : flowIds[0] ?? null;
    setLegend(raw.showLegend === true);
    closeDetails(); // the row it showed belonged to the old document
    for (const c of Array.isArray(raw.charts) ? raw.charts : []) {
      if (!isObj(c) || typeof c.id !== 'string' || !ws.charts[c.id]) continue;
      const size = isObj(c.chartSize) && Number.isFinite(c.chartSize.w) && Number.isFinite(c.chartSize.h)
        ? { w: Number(c.chartSize.w), h: Number(c.chartSize.h) } : null;
      putCamera(c.id, {
        drillPath: Array.isArray(c.drillPath) ? c.drillPath.filter((x): x is string => typeof x === 'string') : [],
        pos: isObj(c.chartPos) ? (c.chartPos as Record<string, { x: number; y: number }>) : {},
        zoom: Number.isFinite(c.chartZoom) ? Number(c.chartZoom) : 1,
        size,
      });
    }
    const view = typeof raw.viewMode === 'string' && raw.viewMode in VIEW_ROUTE ? raw.viewMode : 'chart';
    void navigateTo(`/w/${session.workspaceId}${VIEW_ROUTE[view]}`);
  }

  /** Load: replace the workspace with a saved file, attachments and all. */
  async function load(raw: unknown): Promise<void> {
    const { workspace, attachments } = importLegacy(raw);
    await storeAttachments(attachments);
    replaceWorkspace(session.doc, workspace, LOCAL_ORIGIN);
    applyView(isObj(raw) ? raw : {}, workspace);
  }

  /** Merge: the file's charts and flows arrive as new tabs; nothing already here changes. */
  async function merge(raw: unknown): Promise<void> {
    const r = mergeLegacy(readWorkspace(session.doc), raw);
    await storeAttachments(importLegacy(raw).attachments);
    session.doc.transact(() => loadWorkspace(session.doc, r.additions), LOCAL_ORIGIN);
    if (r.activeChartId) activeChartId.value = r.activeChartId;
    shell.toast(mergeToast(r.summary), 'suggest');
  }

  /** index.html's #file-import handler: a workbook always lands as a new tab; JSON loads or merges. */
  async function openWorkspaceFile(file: File, asMerge: boolean): Promise<void> {
    if (/\.xlsx$/i.test(file.name)) { await importWorkbook(file); return; }
    try {
      const raw: unknown = JSON.parse(await file.text());
      await (asMerge ? merge(raw) : load(raw));
    } catch (err) {
      alert('Import failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function loadDemo(): Promise<void> {
    if (!confirm('Load the demo dataset? This replaces the chart AND the roster.')) return;
    try {
      await load(await $fetch<unknown>('/api/demo'));
    } catch (err) {
      alert('Import failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  function clearAll(): void {
    if (!confirm('Clear everything? This wipes every chart tab AND every roster entry — leaving a single blank chart. This cannot be undone.')) return;
    const blank = clearedWorkspace(readWorkspace(session.doc));
    replaceWorkspace(session.doc, blank, LOCAL_ORIGIN);
    // index.html's blank state is defaultState() with one empty chart: the chart view, no Legend.
    applyView({ viewMode: 'chart', showLegend: false }, blank);
  }

  function downloadIngestKit(): void {
    const blob = new Blob([ingestKitMarkdown(session.workspace.value)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'raci-ingest-kit.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { openWorkspaceFile, loadDemo, clearAll, downloadIngestKit };
}
