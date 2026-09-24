/**
 * The PowerPoint export.
 *
 * index.html's `pptxBytes`, out of the DOM: a title slide, then the chart one tier at a time as
 * native PowerPoint tables of thirteen rows a slide, then every flow anchored to the chart as a
 * table of its steps, eight a slide. Leadership drops these straight into the deck the chart came
 * from, so the slides are the same slides — same parts, same XML, same theme, same text — and the
 * parity test holds every part of the package to what index.html writes, byte for byte.
 *
 * HAND-WRITTEN OOXML, like the workbook writer and for the same reasons: no dependency, identical
 * in a browser and on a server, and deterministic, so it can be asserted on. The container is the
 * shared store-only ZIP writer; the one byte-level difference from the legacy file is the entry
 * timestamp, which the legacy writes as zero (not a valid DOS date) and `zipBytes` as 1980-01-01.
 *
 * NOT THE WORKBOOK'S SHEETS. `buildChartSheets` in xlsx.ts looks like the legacy's
 * `buildLevelSheets` and is not: its org-chart sheets carry one "Org unit" column where the legacy
 * carries Division / Branch / "(inherited)" columns, it omits an empty tier the legacy keeps, and
 * it labels units differently. Slides built from it would be different slides, so this module
 * ports `buildLevelSheets` itself (see document-text.ts for the vocabulary both share).
 */

import { COLS, framework } from '../constants.js';
import { childIndex, childrenIn } from '../tree.js';
import type { Chart, ChartNode, OrgRef, Workspace } from '../schema.js';
import {
  FLOW_MODE_NAMES,
  STATUS_TEXT,
  anchorContext,
  columnLabel,
  deliverableName,
  documentColumns,
  documentTierLabel,
  flowStepOrder,
  flowsAnchoredTo,
  freeFormShape,
  hasSignedStamp,
  orgText,
  passDown,
  printedLine,
  resolvedAnchor,
  rowOrg,
  signedOn,
  stepDeliverables,
  stepLinkText,
  stepNextText,
  stepPartiesText,
  stepRolesText,
  type DateStyle,
} from './document-text.js';
import { zipBytes, type ZipEntry } from './zip.js';

export const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The download name index.html gives a chart's documents — `chartFileBase`. */
export function chartFileBase(chart: Pick<Chart, 'title'>): string {
  return (chart.title || 'raci').replace(/\s+/g, '_');
}

/** Text escaping — the legacy's `escapeHtml`, which is also exactly what OOXML text needs. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- the tier tables ----------------------------------------------------------------------------

export interface LevelSheet {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
}

const branchOf = (ref: OrgRef): string | undefined =>
  'entityId' in ref ? undefined : ref.branchId;

/**
 * An organization chart as four tables, one per tier, each row carrying its ancestors and the
 * roster units above it — the legacy `buildLevelSheets`.
 *
 * All four tiers are always there, even empty: a deck with no Task slide says "no tasks" out loud.
 * The "(inherited)" columns are the Program's division and the Project's branch, carried down so a
 * Task row names who it belongs to without the reader walking back up the tree.
 */
function orgLevelSheets(ws: Workspace, chart: Chart): LevelSheet[] {
  const headers = COLS.map((k) => columnLabel(ws, k));
  const index = childIndex(chart.nodes);
  const kids = (id: string | null) => childrenIn(index, id);
  const full = (ref: OrgRef | null) => orgText(ws, ref)?.full ?? '';
  const cells = (node: ChartNode, inherited: string | null) => {
    const line = printedLine(node, inherited, COLS);
    return COLS.map((k) => line[k] ?? '');
  };

  const portfolio: string[][] = [];
  const program: string[][] = [];
  const project: string[][] = [];
  const task: string[][] = [];

  for (const pf of kids(null)) {
    portfolio.push([pf.name || '', ...cells(pf, null)]);
    const programOwner = passDown(pf, null, COLS);
    for (const prog of kids(pf.id)) {
      const progOrg = rowOrg(chart, prog);
      const division = progOrg && !branchOf(progOrg) ? progOrg : null;
      program.push([pf.name || '', prog.name || '', full(progOrg), ...cells(prog, programOwner)]);
      const projectOwner = passDown(prog, programOwner, COLS);
      for (const proj of kids(prog.id)) {
        const projOrg = rowOrg(chart, proj);
        const branch = projOrg && branchOf(projOrg) ? projOrg : null;
        project.push([
          pf.name || '',
          prog.name || '',
          proj.name || '',
          full(projOrg),
          full(division),
          ...cells(proj, projectOwner),
        ]);
        const taskOwner = passDown(proj, projectOwner, COLS);
        for (const t of kids(proj.id)) {
          task.push([
            pf.name || '',
            prog.name || '',
            proj.name || '',
            t.name || '',
            full(division),
            full(branch),
            ...cells(t, taskOwner),
          ]);
        }
      }
    }
  }

  return [
    { name: 'Portfolio', headers: ['Portfolio', ...headers], rows: portfolio },
    { name: 'Program', headers: ['Portfolio', 'Program', 'Division', ...headers], rows: program },
    {
      name: 'Project',
      headers: ['Portfolio', 'Program', 'Project', 'Branch', 'Division (inherited)', ...headers],
      rows: project,
    },
    {
      name: 'Task',
      headers: [
        'Portfolio',
        'Program',
        'Project',
        'Task',
        'Division (inherited)',
        'Branch (inherited)',
        ...headers,
      ],
      rows: task,
    },
  ];
}

/**
 * A free-form chart as one table per depth actually present, headed by the level names and the
 * chart's own columns — the legacy `buildLevelSheetsFree`.
 *
 * The names are made safe as Excel sheet names even here, where no sheet is involved, because the
 * legacy shares this function with its workbook and the slide titles inherit the result.
 */
function freeFormLevelSheets(chart: Chart): LevelSheet[] {
  const shape = freeFormShape(chart)!;
  const columns = shape.cols.map((c) => c.key);
  const headers = shape.cols.map((c) => c.label);
  const index = childIndex(chart.nodes);
  const levels: Array<{ name: string; headers: string[]; rows: string[][] }> = [];

  const level = (depth: number) => {
    let sheet = levels[depth];
    if (!sheet) {
      const lead: string[] = [];
      for (let i = 0; i <= depth; i++) lead.push(documentTierLabel(chart, i));
      sheet = { name: documentTierLabel(chart, depth), headers: [...lead, ...headers], rows: [] };
      levels[depth] = sheet;
    }
    return sheet;
  };

  const walk = (
    parentId: string | null,
    depth: number,
    path: string[],
    inherited: string | null,
  ) => {
    for (const node of childrenIn(index, parentId)) {
      const line = printedLine(node, inherited, columns);
      level(depth).rows.push([...path, node.name || '', ...columns.map((k) => line[k] ?? '')]);
      walk(node.id, depth + 1, [...path, node.name || ''], passDown(node, inherited, columns));
    }
  };
  walk(null, 0, [], null);

  const taken = new Set<string>();
  return levels.filter(Boolean).map((sheet, i) => {
    const base =
      sheet.name
        .replace(/[\\/?*[\]:]/g, ' ')
        .trim()
        .slice(0, 28) || `Level ${i + 1}`;
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base} ${n++}`;
    taken.add(name);
    return { name, headers: sheet.headers, rows: sheet.rows };
  });
}

/** The chart, one table per tier — what the tier slides are paginated from. */
export function buildLevelSheets(ws: Workspace, chart: Chart): LevelSheet[] {
  return freeFormShape(chart) ? freeFormLevelSheets(chart) : orgLevelSheets(ws, chart);
}

// ---- the slides ---------------------------------------------------------------------------------

type SlideDef =
  | { readonly kind: 'title'; readonly title: string; readonly sub: string }
  | {
      readonly kind: 'table';
      readonly title: string;
      readonly headers: readonly string[];
      readonly rows: ReadonlyArray<readonly string[]>;
      /** How many trailing columns are narrow, centred role-letter columns. */
      readonly raciCols: number;
    };

const SLIDE_W = 12192000; // 13.333" × 7.5" widescreen, in EMU
const SLIDE_H = 6858000;
const ROWS_PER_SLIDE = 13;
const FLOW_ROWS_PER_SLIDE = 8;

const SLIDE_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The empty group shape every slide, the master and the layout open their shape tree with. */
const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** How the signed date on a Final chart's title slide is written — see `DateStyle`. */
export type PptxOptions = DateStyle;

/** Every slide, in order: title, the tiers, then the anchored flows. */
function slideDefs(ws: Workspace, chart: Chart, opts: PptxOptions): SlideDef[] {
  const fw = framework(chart.framework);
  const status = STATUS_TEXT[chart.status];
  const columns = documentColumns(chart);
  const defs: SlideDef[] = [
    {
      kind: 'title',
      title: `${status.short} — ${chart.title || 'RACI chart'}`,
      sub: `${fw.name} responsibility matrix · ${status.name}${hasSignedStamp(chart) ? `, signed ${signedOn(chart, opts)}` : ''}`,
    },
  ];

  for (const sheet of buildLevelSheets(ws, chart)) {
    const pages = Math.max(1, Math.ceil(sheet.rows.length / ROWS_PER_SLIDE));
    for (let p = 0; p < pages; p++) {
      defs.push({
        kind: 'table',
        title: sheet.name + (pages > 1 ? `  (${p + 1}/${pages})` : ''),
        headers: sheet.headers,
        rows: sheet.rows.slice(p * ROWS_PER_SLIDE, (p + 1) * ROWS_PER_SLIDE),
        raciCols: columns.length,
      });
    }
  }

  for (const flow of flowsAnchoredTo(ws, chart.id)) {
    const anchor = resolvedAnchor(ws, flow);
    const context = anchorContext(ws, flow);
    const linked = flow.mode === 'linked';
    const headers = [
      ...(linked ? ['Step', 'Linked chart row'] : ['Step']),
      'Roles',
      'Responsible parties',
      'Inputs',
      'Outputs',
      'Next / condition',
    ];
    const rows = flowStepOrder(flow).map((step) => {
      const io = stepDeliverables(flow, step.id);
      return [
        ...(linked ? [step.name || '', stepLinkText(ws, flow, step, columns)] : [step.name || '']),
        stepRolesText(ws, flow, step, columns),
        stepPartiesText(ws, flow, context, step, columns),
        io.inputs.map((id) => deliverableName(ws, id)).join(', '),
        io.outputs.map((id) => deliverableName(ws, id)).join(', '),
        stepNextText(ws, flow, step),
      ];
    });
    const title =
      `[${STATUS_TEXT[flow.status].short}] Flow (${FLOW_MODE_NAMES[flow.mode]}) — ${flow.name || 'Untitled'}` +
      (anchor ? `  (⚓ ${anchor.node.name || 'task'})` : '');
    const pages = Math.max(1, Math.ceil(rows.length / FLOW_ROWS_PER_SLIDE));
    for (let p = 0; p < pages; p++) {
      defs.push({
        kind: 'table',
        title: title + (pages > 1 ? `  (${p + 1}/${pages})` : ''),
        headers,
        rows: rows.slice(p * FLOW_ROWS_PER_SLIDE, (p + 1) * FLOW_ROWS_PER_SLIDE),
        raciCols: 0,
      });
    }
  }
  return defs;
}

function textBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  runs: string,
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`
  );
}

function para(text: string, size: number, bold: boolean, color: string): string {
  return (
    `<a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`
  );
}

/**
 * A native PowerPoint table. The trailing `raciCols` columns are narrow and centred — role letters
 * — and the leading ones share whatever width is left, never narrower than ~0.98".
 */
function tableFrame(
  id: number,
  headers: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  raciCols: number,
): string {
  const TW = 11582400;
  const x = 304800;
  const y = 1295400;
  const nRaci = Math.min(raciCols, headers.length);
  const nLead = headers.length - nRaci;
  const raciW = 640000;
  const leadW = Math.max(900000, Math.floor((TW - raciW * nRaci) / Math.max(1, nLead)));
  const grid = `<a:tblGrid>${headers.map((_, i) => `<a:gridCol w="${i < nLead ? leadW : raciW}"/>`).join('')}</a:tblGrid>`;

  const cell = (text: string | undefined, i: number, header: boolean) => {
    // Banding is by COLUMN, not row: alternate columns are shaded so a wide row stays readable.
    const fill = header ? '2D5FA5' : i % 2 ? 'EEF2F8' : 'FFFFFF';
    const color = header ? 'FFFFFF' : '20242B';
    const align = i >= nLead ? ' algn="ctr"' : '';
    return (
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr${align}/>` +
      `<a:r><a:rPr lang="en-US" sz="${header ? 1000 : 900}"${header ? ' b="1"' : ''} dirty="0">` +
      `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></a:txBody>` +
      `<a:tcPr marL="36000" marR="36000" marT="18000" marB="18000" anchor="ctr"><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`
    );
  };
  const head = `<a:tr h="370000">${headers.map((h, i) => cell(h, i, true)).join('')}</a:tr>`;
  const body = rows
    .map((r) => `<a:tr h="320000">${headers.map((_, i) => cell(r[i], i, false)).join('')}</a:tr>`)
    .join('');
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${TW}" cy="${320000 * rows.length + 370000}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>${grid}${head}${body}</a:tbl>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

function slideWrap(inner: string): string {
  return (
    `${XML_HEAD}<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${EMPTY_TREE}` +
    `${inner}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function slideXml(d: SlideDef): string {
  if (d.kind === 'title') {
    return slideWrap(
      textBox(2, 'Title', 685800, 2286000, 10820400, 1143000, para(d.title, 4000, true, '20242B')) +
        textBox(
          3,
          'Subtitle',
          685800,
          3505200,
          10820400,
          685800,
          para(d.sub, 1800, false, '2D5FA5'),
        ),
    );
  }
  return slideWrap(
    textBox(2, 'Heading', 304800, 304800, 11582400, 838200, para(d.title, 2400, true, '20242B')) +
      tableFrame(5, d.headers, d.rows, d.raciCols),
  );
}

// ---- the package --------------------------------------------------------------------------------

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const fill = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const stroke = (w: number) =>
  `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;

/** Minimal but schema-complete: PowerPoint refuses a package whose master has no theme. */
const THEME =
  `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ASIC"><a:themeElements>` +
  '<a:clrScheme name="ASIC"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="20242B"/></a:dk2><a:lt2><a:srgbClr val="EEF2F8"/></a:lt2><a:accent1><a:srgbClr val="2D5FA5"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="FA5252"/></a:accent2><a:accent3><a:srgbClr val="FCC419"/></a:accent3><a:accent4><a:srgbClr val="51CF66"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="4DABF7"/></a:accent5><a:accent6><a:srgbClr val="9775FA"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  `<a:fmtScheme name="Office"><a:fillStyleLst>${fill('F5F5F5')}${fill('DDDDDD')}${fill('CCCCCC')}</a:fillStyleLst>` +
  `<a:lnStyleLst>${stroke(6350)}${stroke(12700)}${stroke(19050)}</a:lnStyleLst>` +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  `<a:bgFillStyleLst>${fill('FFFFFF')}${fill('F5F5F5')}${fill('EEEEEE')}</a:bgFillStyleLst></a:fmtScheme>` +
  '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

/** Every part of the package, in the order the legacy writes them. */
export function pptxParts(ws: Workspace, chartId: string, opts: PptxOptions = {}): ZipEntry[] {
  const chart = ws.charts[chartId];
  if (!chart) throw new Error(`no such chart: ${chartId}`);
  const defs = slideDefs(ws, chart, opts);

  const parts: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      content:
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        defs
          .map(
            (_, i) =>
              `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
          )
          .join('') +
        '</Types>',
    },
    {
      path: '_rels/.rels',
      content:
        `${XML_HEAD}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    },
    {
      path: 'ppt/presentation.xml',
      content:
        `${XML_HEAD}<p:presentation ${SLIDE_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>${defs.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
        `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content:
        `${XML_HEAD}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        defs
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`,
          )
          .join('') +
        '</Relationships>',
    },
    {
      path: 'ppt/slideMasters/slideMaster1.xml',
      content:
        `${XML_HEAD}<p:sldMaster ${SLIDE_NS}><p:cSld><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    },
    {
      path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      content:
        `${XML_HEAD}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    },
    {
      path: 'ppt/slideLayouts/slideLayout1.xml',
      content:
        `${XML_HEAD}<p:sldLayout ${SLIDE_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
    },
    {
      path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      content:
        `${XML_HEAD}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    },
    { path: 'ppt/theme/theme1.xml', content: THEME },
  ];

  defs.forEach((d, i) => {
    parts.push({ path: `ppt/slides/slide${i + 1}.xml`, content: slideXml(d) });
    parts.push({
      path: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      content:
        `${XML_HEAD}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    });
  });
  return parts;
}

/**
 * One chart as a PowerPoint deck.
 *
 * `opts` says how the signed date on a Final chart's title slide is written; see `DateStyle`.
 */
export function chartToPptx(
  ws: Workspace,
  chartId: string,
  opts: PptxOptions = {},
): Uint8Array<ArrayBuffer> {
  return zipBytes(pptxParts(ws, chartId, opts));
}
