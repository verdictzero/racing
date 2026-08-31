/**
 * CSV adapter.
 *
 * Three real jobs, not just a test double:
 *   1. Air-gapped deployments where the directory is exported to a file and carried across.
 *   2. Standing up a workspace before anyone has agreed to grant LDAP credentials — which, on a
 *      government network, is usually months before the tool is otherwise useful.
 *   3. The fixture the reconciliation tests run against, so directory behaviour is testable
 *      without a server.
 *
 * Columns (header row required, order irrelevant, case-insensitive):
 *   external_id, display_name, title, email, manager_external_id,
 *   unit_external_id, unit_name, unit_parent_external_id, unit_path, enabled
 *
 * Units are derived from the people: a row naming a unit declares it. A unit with no people
 * (an empty branch that still has to exist) gets a row with the unit columns and no external_id.
 */

import {
  DirectoryError,
  DirectorySnapshot,
  type DirectoryPerson,
  type DirectorySource,
  type DirectoryUnit,
} from '../port.js';

export interface CsvAdapterOptions {
  /** Raw CSV text. */
  readonly text: string;
  readonly name?: string;
}

/**
 * RFC-4180 CSV: quoted fields, embedded commas, doubled quotes, CRLF or LF.
 *
 * Hand-rolled rather than pulled in as a dependency because the format here is fixed and narrow,
 * and an air-gapped build is easier to justify with one fewer vendored package.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // A BOM is what Excel writes, and it would otherwise become part of the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Skip the blank row a trailing newline produces.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  external_id: 'external_id',
  externalid: 'external_id',
  id: 'external_id',
  objectguid: 'external_id',
  display_name: 'display_name',
  displayname: 'display_name',
  name: 'display_name',
  title: 'title',
  job_title: 'title',
  email: 'email',
  mail: 'email',
  manager_external_id: 'manager_external_id',
  manager: 'manager_external_id',
  unit_external_id: 'unit_external_id',
  unit_id: 'unit_external_id',
  unit_name: 'unit_name',
  unit: 'unit_name',
  unit_parent_external_id: 'unit_parent_external_id',
  unit_parent_id: 'unit_parent_external_id',
  unit_path: 'unit_path',
  path: 'unit_path',
  dn: 'unit_path',
  enabled: 'enabled',
};

export function parseDirectoryCsv(text: string, provider = 'csv'): DirectorySnapshot {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new DirectoryError('the CSV is empty');

  const header = rows[0]!.map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')] ?? '');
  if (!header.includes('unit_external_id') && !header.includes('unit_name')) {
    throw new DirectoryError(
      'the CSV needs at least a unit_external_id or unit_name column; found: ' + rows[0]!.join(', '),
    );
  }
  const col = (row: string[], key: string): string => {
    const at = header.indexOf(key);
    return at >= 0 ? (row[at] ?? '').trim() : '';
  };

  const units = new Map<string, DirectoryUnit>();
  const people: DirectoryPerson[] = [];

  for (const row of rows.slice(1)) {
    if (row.every((c) => c.trim() === '')) continue;

    const unitId = col(row, 'unit_external_id') || col(row, 'unit_name');
    if (unitId && !units.has(unitId)) {
      units.set(unitId, {
        externalId: unitId,
        name: col(row, 'unit_name') || unitId,
        parentExternalId: col(row, 'unit_parent_external_id') || null,
        leadExternalId: null,
        path: col(row, 'unit_path'),
      });
    }

    const personId = col(row, 'external_id');
    if (!personId) continue; // a unit-only row
    const enabledRaw = col(row, 'enabled').toLowerCase();
    people.push({
      externalId: personId,
      displayName: col(row, 'display_name'),
      title: col(row, 'title'),
      email: col(row, 'email') || null,
      managerExternalId: col(row, 'manager_external_id') || null,
      unitExternalId: unitId || null,
      enabled: enabledRaw === '' ? true : !['false', '0', 'no', 'disabled'].includes(enabledRaw),
    });
  }

  // A manager who sits in a unit is taken to lead it — the closest a flat CSV gets to a lead, and
  // it matches what both LDAP and Graph express through manager chains.
  for (const person of people) {
    if (!person.unitExternalId) continue;
    const unit = units.get(person.unitExternalId);
    if (!unit || unit.leadExternalId) continue;
    const managesSomeoneHere = people.some(
      (p) => p.managerExternalId === person.externalId && p.unitExternalId === person.unitExternalId,
    );
    if (managesSomeoneHere) {
      units.set(unit.externalId, { ...unit, leadExternalId: person.externalId });
    }
  }

  return DirectorySnapshot.parse({
    units: [...units.values()],
    people,
    fetchedAt: new Date().toISOString(),
    provider,
  });
}

export class CsvDirectorySource implements DirectorySource {
  readonly name: string;
  constructor(private readonly opts: CsvAdapterOptions) {
    this.name = opts.name ?? 'csv';
  }

  async fetch(): Promise<DirectorySnapshot> {
    return parseDirectoryCsv(this.opts.text, this.name);
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const snap = await this.fetch();
      return { ok: true, detail: `${snap.units.length} units, ${snap.people.length} people` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
