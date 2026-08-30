/**
 * Turning a directory snapshot into a roster, without breaking what points at it.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * Every RACI assignment in every chart, and every responsible party on every flow step, is an
 * `{actor, divisionId, branchId, teamId}` pointing at roster ids. A sync that minted fresh ids on
 * each run would orphan all of them on the second run — every assignment in the workspace
 * silently pointing at nothing, which to a user looks like the tool forgot a year of work
 * overnight. So reconciliation matches an incoming unit to the existing one by `externalId` and
 * KEEPS the local id. Ids are stable across runs by construction.
 *
 * WHAT WINS WHEN THEY DISAGREE
 * The directory owns structure: names, membership, who leads what. A person moving branch in AD
 * moves branch here. But the directory does not own anything the tool added — a hand-entered
 * team, a unit somebody created because AD does not model it. Those survive a sync untouched and
 * are reported, not deleted, because deleting them would destroy assignments the directory never
 * knew about and cannot restore.
 *
 * DELETION IS A REPORT, NOT AN ACTION
 * A unit that vanishes from the directory is marked as missing, not removed. Directories are read
 * through flaky networks and partial permissions; an empty page is far more often a failed query
 * than a reorganization. Wiping a division because one LDAP call came back short is not a
 * recoverable mistake. A human confirms the removal.
 */

import { newId, type Roster } from '@raci/core';
import type { DirectoryPerson, DirectorySnapshot, DirectoryUnit, TierMapping } from './port.js';

export interface ReconcileOptions {
  readonly mapping: TierMapping;
  /** Roster to reconcile against. Omit for a first sync into an empty workspace. */
  readonly existing?: Roster;
}

export interface ReconcileChange {
  readonly kind:
    | 'unit-added'
    | 'unit-renamed'
    | 'unit-moved'
    | 'unit-missing'
    | 'person-added'
    | 'person-updated'
    | 'person-moved'
    | 'person-missing'
    | 'lead-changed';
  readonly tier: 'directorate' | 'division' | 'branch' | 'team' | 'person';
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

export interface ReconcileResult {
  readonly roster: Roster;
  readonly changes: ReconcileChange[];
  readonly warnings: string[];
  readonly stats: {
    readonly unitsSeen: number;
    readonly peopleSeen: number;
    readonly unitsMatched: number;
    readonly unitsCreated: number;
    readonly unitsMissing: number;
    readonly peopleMatched: number;
    readonly peopleCreated: number;
    readonly peopleMissing: number;
    /** Local-only records the directory does not know about. Preserved, never deleted. */
    readonly localOnlyKept: number;
  };
}

type Tier = 'directorate' | 'division' | 'branch' | 'team';

interface MappedUnit {
  readonly unit: DirectoryUnit;
  readonly tier: Tier;
  readonly actor: string;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Depth of a unit in the source tree, following parentExternalId. */
function depthOf(unit: DirectoryUnit, byId: Map<string, DirectoryUnit>): number {
  let depth = 0;
  let cur: DirectoryUnit | undefined = unit;
  const seen = new Set<string>();
  while (cur && cur.parentExternalId) {
    if (seen.has(cur.parentExternalId)) break; // a directory CAN contain a loop
    seen.add(cur.parentExternalId);
    cur = byId.get(cur.parentExternalId);
    if (!cur) break;
    depth++;
  }
  return depth;
}

/**
 * A unit's own name, as opposed to its ancestry.
 *
 * A DN nests right-to-left, so "OU=Governance,OU=OCIO,DC=asic" CONTAINS "OU=OCIO" — matching a
 * directorate rule against the whole path would make every descendant of OCIO claim to BE OCIO.
 * Only the leading component identifies the unit itself; the rest is where it sits.
 */
function ownName(unit: DirectoryUnit): string[] {
  const rdn = (unit.path.match(/(?:[^,\\]|\\.)+/) ?? [''])[0]!;
  return [norm(unit.name), norm(rdn)].filter((s) => s.length > 0);
}

/** True when a directorate rule names THIS unit (not one of its ancestors). */
function selfMatches(unit: DirectoryUnit, needle: string): boolean {
  return ownName(unit).some((n) => n.includes(needle));
}

/** Nearest ancestor (or self) that matched a directorate rule. */
function directorateFor(
  unit: DirectoryUnit,
  byId: Map<string, DirectoryUnit>,
  rules: Array<[actor: string, needle: string]>,
): string | null {
  let cur: DirectoryUnit | undefined = unit;
  const seen = new Set<string>();
  while (cur) {
    for (const [actor, needle] of rules) {
      if (selfMatches(cur, needle)) return actor;
    }
    if (!cur.parentExternalId || seen.has(cur.parentExternalId)) break;
    seen.add(cur.parentExternalId);
    cur = byId.get(cur.parentExternalId);
  }
  return null;
}

const TIER_BY_DEPTH: Tier[] = ['directorate', 'division', 'branch', 'team'];

/** Decide which ASIC tier each source unit lands on, and under which directorate. */
export function mapUnits(
  units: DirectoryUnit[],
  mapping: TierMapping,
): { mapped: MappedUnit[]; warnings: string[] } {
  const byId = new Map(units.map((u) => [u.externalId, u]));
  const rules = Object.entries(mapping.directorates).map(
    ([actor, needle]) => [actor, norm(needle)] as [string, string],
  );
  const excludes = mapping.exclude.map(norm);
  const mapped: MappedUnit[] = [];
  const warnings: string[] = [];

  for (const unit of units) {
    // Exclusion DOES look at the whole path on purpose: excluding a branch of the tree should
    // exclude everything under it, which is the opposite of how a directorate rule reads.
    if (excludes.some((e) => norm(unit.name).includes(e) || norm(unit.path).includes(e))) continue;

    const actor = directorateFor(unit, byId, rules) ?? mapping.fallbackDirectorate;
    if (!actor) {
      warnings.push(`unit "${unit.name}" maps to no directorate and was skipped`);
      continue;
    }

    // A unit that matched a directorate rule IS that directorate; everything else takes its
    // depth relative to it.
    const matchedSelf = rules.some(([, needle]) => selfMatches(unit, needle));
    let tier: Tier;
    if (matchedSelf) {
      tier = 'directorate';
    } else if (mapping.useDepthFallback) {
      const depth = Math.min(depthOf(unit, byId), TIER_BY_DEPTH.length - 1);
      tier = TIER_BY_DEPTH[depth]!;
    } else {
      warnings.push(`unit "${unit.name}" matched no rule and depth fallback is off; skipped`);
      continue;
    }
    mapped.push({ unit, tier, actor });
  }

  return { mapped, warnings };
}

interface MutableLead {
  id: string;
  name: string;
}
interface MutablePerson {
  id: string;
  name: string;
  title: string;
  externalId: string | null;
  email: string | null;
}
interface MutableTeam {
  id: string;
  name: string;
  chief: MutableLead | null;
  externalId: string | null;
  people: MutablePerson[];
}
interface MutableBranch {
  id: string;
  name: string;
  chief: MutableLead | null;
  externalId: string | null;
  teams: MutableTeam[];
}
interface MutableDivision {
  id: string;
  name: string;
  chief: MutableLead | null;
  externalId: string | null;
  branches: MutableBranch[];
}
interface MutableDirectorate {
  lead: MutableLead | null;
  externalId: string | null;
  divisions: MutableDivision[];
}

/** Index every existing record by its externalId, so a re-sync can find and keep its local id. */
function indexExisting(roster: Roster | undefined) {
  const units = new Map<string, { id: string; tier: Tier; actor: string }>();
  const people = new Map<string, { id: string }>();
  if (!roster) return { units, people };

  for (const [actor, directorate] of Object.entries(roster)) {
    if (!directorate) continue;
    if (directorate.externalId) {
      units.set(directorate.externalId, { id: actor, tier: 'directorate', actor });
    }
    for (const division of directorate.divisions) {
      if (division.externalId) units.set(division.externalId, { id: division.id, tier: 'division', actor });
      for (const branch of division.branches) {
        if (branch.externalId) units.set(branch.externalId, { id: branch.id, tier: 'branch', actor });
        for (const team of branch.teams) {
          if (team.externalId) units.set(team.externalId, { id: team.id, tier: 'team', actor });
          for (const person of team.people) {
            if (person.externalId) people.set(person.externalId, { id: person.id });
          }
        }
      }
    }
  }
  return { units, people };
}

/**
 * Build the reconciled roster.
 *
 * Local-only records — anything with no externalId — are carried over first, so that a hand-built
 * team is still there after the sync. The directory's units are then merged on top by externalId.
 */
export function reconcile(snapshot: DirectorySnapshot, opts: ReconcileOptions): ReconcileResult {
  const { mapping, existing } = opts;
  const { mapped, warnings } = mapUnits(snapshot.units, mapping);
  const index = indexExisting(existing);
  const changes: ReconcileChange[] = [];

  let unitsMatched = 0;
  let unitsCreated = 0;
  let peopleMatched = 0;
  let peopleCreated = 0;
  let localOnlyKept = 0;

  // Start from the existing roster, keeping ONLY the records the directory does not manage.
  const out: Record<string, MutableDirectorate> = {};
  const actorsSeen = new Set<string>(mapped.map((m) => m.actor));
  for (const actor of new Set([...Object.keys(existing ?? {}), ...actorsSeen])) {
    const prior = existing?.[actor as keyof Roster];
    out[actor] = {
      lead: prior?.lead ? { ...prior.lead } : null,
      externalId: prior?.externalId ?? null,
      divisions: [],
    };
    for (const division of prior?.divisions ?? []) {
      if (division.externalId) continue; // directory-managed; rebuilt below
      localOnlyKept++;
      out[actor]!.divisions.push(JSON.parse(JSON.stringify(division)) as MutableDivision);
    }
  }

  const peopleByUnit = new Map<string, DirectoryPerson[]>();
  for (const person of snapshot.people) {
    if (!person.unitExternalId) continue;
    const list = peopleByUnit.get(person.unitExternalId);
    if (list) list.push(person);
    else peopleByUnit.set(person.unitExternalId, [person]);
  }
  const personByExternalId = new Map(snapshot.people.map((p) => [p.externalId, p]));

  const leadFor = (unit: DirectoryUnit): MutableLead | null => {
    if (!unit.leadExternalId) return null;
    const person = personByExternalId.get(unit.leadExternalId);
    if (!person) return null;
    return { id: newId('person'), name: person.displayName };
  };

  const buildPeople = (unit: DirectoryUnit, unitName: string): MutablePerson[] =>
    (peopleByUnit.get(unit.externalId) ?? [])
      .filter((p) => p.enabled)
      .map((p) => {
        const prior = index.people.get(p.externalId);
        if (prior) {
          peopleMatched++;
          return {
            id: prior.id,
            name: p.displayName,
            title: p.title,
            externalId: p.externalId,
            email: p.email,
          };
        }
        peopleCreated++;
        const id = newId('person');
        changes.push({
          kind: 'person-added',
          tier: 'person',
          id,
          name: p.displayName,
          detail: `joined ${unitName}`,
        });
        return { id, name: p.displayName, title: p.title, externalId: p.externalId, email: p.email };
      });

  /** Find or mint the local id for a unit, recording whether it was matched or created. */
  const idFor = (unit: DirectoryUnit, tier: Tier, kind: 'division' | 'branch' | 'team'): string => {
    const prior = index.units.get(unit.externalId);
    if (prior) {
      unitsMatched++;
      if (prior.tier !== tier) {
        changes.push({
          kind: 'unit-moved',
          tier,
          id: prior.id,
          name: unit.name,
          detail: `moved from ${prior.tier} to ${tier}`,
        });
      }
      return prior.id;
    }
    unitsCreated++;
    const id = newId(kind);
    changes.push({ kind: 'unit-added', tier, id, name: unit.name, detail: unit.path });
    return id;
  };

  // Directorates first, so their externalId is recorded for the next run.
  for (const { unit, tier, actor } of mapped) {
    if (tier !== 'directorate') continue;
    const bucket = (out[actor] ??= { lead: null, externalId: null, divisions: [] });
    if (bucket.externalId && bucket.externalId !== unit.externalId) {
      warnings.push(
        `two source units both map to directorate "${actor}"; keeping ${bucket.externalId}`,
      );
      continue;
    }
    bucket.externalId = unit.externalId;
    const lead = leadFor(unit);
    if (lead && bucket.lead?.name !== lead.name) {
      changes.push({
        kind: 'lead-changed',
        tier: 'directorate',
        id: actor,
        name: unit.name,
        detail: `lead is now ${lead.name}`,
      });
    }
    bucket.lead = lead ?? bucket.lead;
  }

  // Then the three nested tiers, parents before children.
  const byExternalId = new Map(mapped.map((m) => [m.unit.externalId, m]));
  const divisionOf = new Map<string, MutableDivision>();
  const branchOf = new Map<string, MutableBranch>();

  for (const { unit, tier, actor } of mapped) {
    if (tier !== 'division') continue;
    const division: MutableDivision = {
      id: idFor(unit, tier, 'division'),
      name: unit.name,
      chief: leadFor(unit),
      externalId: unit.externalId,
      branches: [],
    };
    divisionOf.set(unit.externalId, division);
    (out[actor] ??= { lead: null, externalId: null, divisions: [] }).divisions.push(division);
  }

  for (const { unit, tier } of mapped) {
    if (tier !== 'branch') continue;
    const branch: MutableBranch = {
      id: idFor(unit, tier, 'branch'),
      name: unit.name,
      chief: leadFor(unit),
      externalId: unit.externalId,
      teams: [],
    };
    branchOf.set(unit.externalId, branch);
    const parent = unit.parentExternalId ? divisionOf.get(unit.parentExternalId) : undefined;
    if (parent) parent.branches.push(branch);
    else {
      // A branch whose division did not map has to go somewhere, or its people vanish.
      const actor = byExternalId.get(unit.externalId)!.actor;
      const bucket = (out[actor] ??= { lead: null, externalId: null, divisions: [] });
      let orphanage = bucket.divisions.find((d) => d.externalId === null && d.name === 'Unassigned');
      if (!orphanage) {
        orphanage = {
          id: newId('division'),
          name: 'Unassigned',
          chief: null,
          externalId: null,
          branches: [],
        };
        bucket.divisions.push(orphanage);
      }
      orphanage.branches.push(branch);
      warnings.push(`branch "${unit.name}" has no mapped division; filed under Unassigned`);
    }
  }

  for (const { unit, tier } of mapped) {
    if (tier !== 'team') continue;
    const team: MutableTeam = {
      id: idFor(unit, tier, 'team'),
      name: unit.name,
      chief: leadFor(unit),
      externalId: unit.externalId,
      people: buildPeople(unit, unit.name),
    };
    const parent = unit.parentExternalId ? branchOf.get(unit.parentExternalId) : undefined;
    if (parent) parent.teams.push(team);
    else warnings.push(`team "${unit.name}" has no mapped branch and was skipped`);
  }

  // Anything the directory used to have and no longer does is REPORTED, never removed. A short
  // read from a flaky LDAP connection must not be able to delete a division.
  let unitsMissing = 0;
  for (const [externalId, prior] of index.units) {
    if (byExternalId.has(externalId)) continue;
    unitsMissing++;
    changes.push({
      kind: 'unit-missing',
      tier: prior.tier,
      id: prior.id,
      name: externalId,
      detail: 'no longer in the directory — confirm before removing',
    });
  }
  let peopleMissing = 0;
  for (const [externalId, prior] of index.people) {
    if (personByExternalId.has(externalId)) continue;
    peopleMissing++;
    changes.push({
      kind: 'person-missing',
      tier: 'person',
      id: prior.id,
      name: externalId,
      detail: 'no longer in the directory — confirm before removing',
    });
  }

  return {
    roster: out as unknown as Roster,
    changes,
    warnings,
    stats: {
      unitsSeen: snapshot.units.length,
      peopleSeen: snapshot.people.length,
      unitsMatched,
      unitsCreated,
      unitsMissing,
      peopleMatched,
      peopleCreated,
      peopleMissing,
      localOnlyKept,
    },
  };
}

/** One-line summary for a log line or a toast. */
export function summarize(result: ReconcileResult): string {
  const s = result.stats;
  return (
    `${s.unitsSeen} units / ${s.peopleSeen} people read · ` +
    `${s.unitsCreated} new units, ${s.peopleCreated} new people, ` +
    `${s.unitsMatched} units matched · ` +
    `${s.unitsMissing + s.peopleMissing} no longer present (kept, needs review)` +
    (result.warnings.length ? ` · ${result.warnings.length} warning(s)` : '')
  );
}
