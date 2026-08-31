import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Roster } from '@raci/core';
import { parseCsv, parseDirectoryCsv, CsvDirectorySource } from './adapters/csv.js';
import { parentDn, guidToString } from './adapters/ldap.js';
import { directoryConfigFromEnv } from './factory.js';
import { mapUnits, reconcile, summarize } from './reconcile.js';
import { TierMapping, type DirectorySnapshot } from './port.js';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '../../../ops/directory/sample-org.csv'),
  'utf8',
);

const MAPPING = TierMapping.parse({
  directorates: { ocio: 'OU=OCIO', cyber: 'OU=Cyber' },
  useDepthFallback: true,
});

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and doubled quotes', () => {
    const rows = parseCsv('a,b\n"has, comma","says ""hi"""\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['has, comma', 'says "hi"'],
    ]);
  });

  it('accepts CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips the BOM Excel writes', () => {
    const rows = parseCsv('﻿external_id,name\nx,y\n');
    expect(rows[0]![0]).toBe('external_id');
  });

  it('reads the sample org file', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    expect(snap.units.length).toBe(8);
    expect(snap.people.length).toBe(6);
    expect(snap.provider).toBe('csv');
  });

  it('carries a disabled account through as disabled rather than dropping it', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const disabled = snap.people.find((p) => p.externalId === 'p-2003')!;
    expect(disabled.enabled).toBe(false);
    // A quoted title containing a comma survived the parse.
    expect(disabled.title).toBe('Analyst, Tier 2');
  });

  it('infers a unit lead from the manager chain', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const team = snap.units.find((u) => u.externalId === 'ou-cyber-ops-soc-t1')!;
    expect(team.leadExternalId).toBe('p-2001');
  });

  it('rejects a file with no unit column, naming what it found', () => {
    expect(() => parseDirectoryCsv('a,b\n1,2\n')).toThrow(/unit_external_id or unit_name/);
  });

  it('probes', async () => {
    const source = new CsvDirectorySource({ text: SAMPLE });
    await expect(source.probe!()).resolves.toEqual({
      ok: true,
      detail: '8 units, 6 people',
    });
  });
});

describe('tier mapping', () => {
  it('maps a unit matching a directorate rule to that directorate', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const { mapped } = mapUnits(snap.units, MAPPING);
    const ocio = mapped.find((m) => m.unit.externalId === 'ou-ocio')!;
    expect(ocio.tier).toBe('directorate');
    expect(ocio.actor).toBe('ocio');
  });

  it('maps everything else by depth beneath it', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const { mapped } = mapUnits(snap.units, MAPPING);
    const byId = new Map(mapped.map((m) => [m.unit.externalId, m]));
    expect(byId.get('ou-ocio-gov')!.tier).toBe('division');
    expect(byId.get('ou-ocio-gov-pol')!.tier).toBe('branch');
    expect(byId.get('ou-ocio-gov-pol-a')!.tier).toBe('team');
    // Every one of them inherits the directorate from its ancestor.
    expect(byId.get('ou-ocio-gov-pol-a')!.actor).toBe('ocio');
  });

  it('skips excluded units', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const { mapped } = mapUnits(
      snap.units,
      TierMapping.parse({ ...MAPPING, exclude: ['OU=Cyber'] }),
    );
    expect(mapped.some((m) => m.actor === 'cyber')).toBe(false);
  });

  it('warns rather than guessing when a unit maps to no directorate', () => {
    const snap = parseDirectoryCsv(SAMPLE);
    const { mapped, warnings } = mapUnits(snap.units, TierMapping.parse({ directorates: {} }));
    expect(mapped).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/maps to no directorate/);
  });
});

describe('reconcile — a first sync', () => {
  const snap = parseDirectoryCsv(SAMPLE);
  const result = reconcile(snap, { mapping: MAPPING });

  it('builds the roster tree', () => {
    const ocio = result.roster.ocio!;
    expect(ocio.externalId).toBe('ou-ocio');
    expect(ocio.divisions).toHaveLength(1);
    expect(ocio.divisions[0]!.name).toBe('Governance Division');
    expect(ocio.divisions[0]!.branches[0]!.name).toBe('Policy Branch');
    expect(ocio.divisions[0]!.branches[0]!.teams[0]!.name).toBe('Standards Team');
  });

  it('places people in their team', () => {
    const team = result.roster.ocio!.divisions[0]!.branches[0]!.teams[0]!;
    expect(team.people.map((p) => p.name).sort()).toEqual([
      'Dana Whitfield',
      'Marcus Reed',
      'Priya Raman',
    ]);
  });

  it('leaves disabled accounts out of the roster but reports the read', () => {
    const team = result.roster.cyber!.divisions[0]!.branches[0]!.teams[0]!;
    expect(team.people.map((p) => p.name)).not.toContain('Sam Lindqvist');
    expect(result.stats.peopleSeen).toBe(6);
  });

  it('records every externalId, which is what makes the NEXT sync stable', () => {
    const team = result.roster.ocio!.divisions[0]!.branches[0]!.teams[0]!;
    expect(team.externalId).toBe('ou-ocio-gov-pol-a');
    expect(team.people.every((p) => p.externalId !== null)).toBe(true);
  });

  it('counts everything it created', () => {
    expect(result.stats.unitsCreated).toBeGreaterThan(0);
    expect(result.stats.unitsMatched).toBe(0);
    expect(summarize(result)).toContain('units');
  });
});

describe('reconcile — a SECOND sync is where the value is', () => {
  const snap = parseDirectoryCsv(SAMPLE);
  const first = reconcile(snap, { mapping: MAPPING });

  it('keeps every local id, so existing RACI assignments still resolve', () => {
    // THE test for this package. If ids churned, every {actor, divisionId, branchId, teamId} in
    // every chart would point at nothing after the second sync — a silent, total loss that looks
    // like the tool forgot a year of work.
    const second = reconcile(snap, { mapping: MAPPING, existing: first.roster });

    const idsOf = (roster: Roster) => {
      const out: string[] = [];
      for (const directorate of Object.values(roster)) {
        for (const division of directorate?.divisions ?? []) {
          out.push(division.id);
          for (const branch of division.branches) {
            out.push(branch.id);
            for (const team of branch.teams) {
              out.push(team.id);
              for (const person of team.people) out.push(person.id);
            }
          }
        }
      }
      return out.sort();
    };

    expect(idsOf(second.roster)).toEqual(idsOf(first.roster));
    expect(second.stats.unitsCreated).toBe(0);
    expect(second.stats.unitsMatched).toBeGreaterThan(0);
  });

  it('applies a rename from the directory while keeping the id', () => {
    const renamed: DirectorySnapshot = {
      ...snap,
      units: snap.units.map((u) =>
        u.externalId === 'ou-ocio-gov' ? { ...u, name: 'Governance & Policy Division' } : u,
      ),
    };
    const second = reconcile(renamed, { mapping: MAPPING, existing: first.roster });
    const division = second.roster.ocio!.divisions.find((d) => d.externalId === 'ou-ocio-gov')!;
    expect(division.name).toBe('Governance & Policy Division');
    expect(division.id).toBe(first.roster.ocio!.divisions[0]!.id);
  });

  it('reports a vanished unit instead of deleting it', () => {
    // A short read from a flaky LDAP connection must never be able to wipe a division.
    const shrunk: DirectorySnapshot = {
      ...snap,
      units: snap.units.filter((u) => !u.externalId.startsWith('ou-cyber')),
      people: snap.people.filter((p) => !p.externalId.startsWith('p-2')),
    };
    const second = reconcile(shrunk, { mapping: MAPPING, existing: first.roster });
    const missing = second.changes.filter((c) => c.kind === 'unit-missing');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]!.detail).toMatch(/confirm before removing/);
    expect(second.stats.unitsMissing).toBeGreaterThan(0);
  });

  it('adds a new person as a reported change', () => {
    const grown: DirectorySnapshot = {
      ...snap,
      people: [
        ...snap.people,
        {
          externalId: 'p-1099',
          displayName: 'New Starter',
          title: 'Analyst',
          email: null,
          managerExternalId: 'p-1001',
          unitExternalId: 'ou-ocio-gov-pol-a',
          enabled: true,
        },
      ],
    };
    const second = reconcile(grown, { mapping: MAPPING, existing: first.roster });
    expect(second.stats.peopleCreated).toBe(1);
    expect(second.changes.some((c) => c.kind === 'person-added' && c.name === 'New Starter')).toBe(
      true,
    );
  });

  it('preserves a hand-built unit the directory has never heard of', () => {
    // A team someone created in the tool because AD does not model it. Deleting it on sync would
    // destroy assignments the directory cannot restore.
    const withLocal: Roster = JSON.parse(JSON.stringify(first.roster));
    withLocal.ocio!.divisions.push({
      id: 'dv_handmade',
      name: 'Standing Working Group',
      chief: null,
      externalId: null,
      branches: [],
    });

    const second = reconcile(snap, { mapping: MAPPING, existing: withLocal });
    expect(second.roster.ocio!.divisions.some((d) => d.id === 'dv_handmade')).toBe(true);
    expect(second.stats.localOnlyKept).toBe(1);
  });
});

describe('LDAP helpers', () => {
  it('derives the parent OU from a DN', () => {
    expect(parentDn('OU=Policy,OU=Governance,DC=asic,DC=army,DC=mil')).toBe(
      'OU=Governance,DC=asic,DC=army,DC=mil',
    );
  });

  it('stops at the domain root rather than returning a DC path', () => {
    expect(parentDn('OU=OCIO,DC=asic,DC=army,DC=mil')).toBeNull();
    expect(parentDn('DC=asic,DC=army,DC=mil')).toBeNull();
  });

  it('handles an escaped comma in an OU name', () => {
    expect(parentDn('OU=Policy\\, Standards,OU=Gov,DC=x,DC=y')).toBe('OU=Gov,DC=x,DC=y');
  });

  it('normalizes objectGUID from a Buffer to stable hex', () => {
    expect(guidToString(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
    expect(guidToString('already-a-string')).toBe('already-a-string');
    expect(guidToString(undefined)).toBeNull();
  });
});

describe('config from the environment', () => {
  it('reads an LDAP config', () => {
    const config = directoryConfigFromEnv({
      DIRECTORY_PROVIDER: 'ldap',
      DIRECTORY_LDAP_URL: 'ldaps://dc.example.mil',
      DIRECTORY_LDAP_BIND_DN: 'cn=svc,dc=example,dc=mil',
      DIRECTORY_LDAP_BIND_PASSWORD: 'secret',
      DIRECTORY_LDAP_BASE_DN: 'dc=example,dc=mil',
    });
    expect(config.provider).toBe('ldap');
  });

  it('names the missing variable rather than failing at 3am', () => {
    expect(() =>
      directoryConfigFromEnv({ DIRECTORY_PROVIDER: 'ldap', DIRECTORY_LDAP_URL: 'ldap://x' }),
    ).toThrow(/DIRECTORY_LDAP_BIND_DN is required/);
  });

  it('defaults to no directory at all', () => {
    expect(directoryConfigFromEnv({})).toEqual({ provider: 'none' });
  });

  it('rejects an unknown provider by listing the real ones', () => {
    expect(() => directoryConfigFromEnv({ DIRECTORY_PROVIDER: 'oracle' })).toThrow(
      /expected one of: none, ldap, graph, csv/,
    );
  });
});
