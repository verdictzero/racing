/**
 * index.html's importXlsx: read a workbook, say what was found in a native confirm, and add it as a
 * new chart tab. Shared by the Excel chooser and by Load/Merge, which also accept a .xlsx — a
 * workbook dropped on Load should not be refused, and in a spreadsheet there is nothing that could
 * replace a workspace, so for a workbook Load and Merge mean the same thing.
 *
 * Parsed in the browser: importXlsx is pure, so there is no upload and no round trip, and the result
 * lands through the collaborative document like every other edit.
 */
import { COL_LABELS_DEFAULT, importXlsx } from '@raci/core';
import { insertChart, insertEntities, setColumnLabels } from '@raci/crdt';

export function useXlsxImport() {
  const session = useWorkspaceSession();
  const shell = useShell();
  const activeChartId = useActiveChartId();

  return async function importWorkbook(file: File): Promise<void> {
    let parsed;
    try {
      parsed = await importXlsx(new Uint8Array(await file.arrayBuffer()), { fileName: file.name });
    } catch (err) {
      shell.toast(err instanceof Error && err.message ? err.message : 'Could not read that workbook.', 'error');
      return;
    }
    const st = parsed.stats;
    const current = session.workspace.value.columnLabels;
    const renamed = Object.entries(parsed.labels).filter(([k, label]) =>
      label && label !== (current[k] ?? COL_LABELS_DEFAULT[k as keyof typeof COL_LABELS_DEFAULT] ?? k));
    const lines = [
      `Read ${st.sheets.map((n) => `"${n}"`).join(' + ')} from ${file.name}:`,
      '',
      `  ${st.nodes} activit${st.nodes === 1 ? 'y' : 'ies'} from ${st.rows} row${st.rows === 1 ? '' : 's'}`,
      `  ${st.columns} party column${st.columns === 1 ? '' : 's'}`,
      st.entities ? `  ${st.entities} entit${st.entities === 1 ? 'y' : 'ies'}` : null,
      '',
      ...parsed.warnings.map((w) => `  ! ${w}`),
      renamed.length ? '  ! The party column headers differ from this workspace’s. Importing renames'
        + ' them for every organization chart, not just this one.' : null,
      parsed.warnings.length || renamed.length ? '' : null,
      'Add it as a new chart tab? Nothing already in the workspace is changed.',
    ].filter((x): x is string => x !== null);
    if (!confirm(lines.join('\n'))) return;

    insertChart(session.doc, parsed.chart);
    if (renamed.length) setColumnLabels(session.doc, parsed.labels, parsed.shorts);
    const added = insertEntities(session.doc, parsed.entities).length;
    activeChartId.value = parsed.chart.id;
    await navigateTo(`/w/${session.workspaceId}`);
    shell.toast(`Imported ${st.nodes} activities into a new chart tab`
      + (added ? `, plus ${added} entit${added === 1 ? 'y' : 'ies'}` : '') + '.', 'suggest');
  };
}
