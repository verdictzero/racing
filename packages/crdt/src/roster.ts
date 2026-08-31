/**
 * The roster, flattened for merging and re-nested on the way out.
 *
 * `Roster` is a tree of nested arrays: a directorate holds divisions, which hold branches, which
 * hold teams, which hold people. That is the right shape on the wire and the wrong shape in a CRDT,
 * for exactly the reason the chart's rows were flattened — an array splice cannot merge. Two people
 * adding a branch to the same division produce two whole-array writes and one of them is simply
 * lost, and the older storage (one plain JSON value per directorate) lost far more than that: any
 * two edits anywhere under one directorate clobbered each other.
 *
 * So the document stores one record per unit, keyed by id, with a parent pointer and an order key —
 * the same model as `nodes`. `flattenRoster` and `nestRoster` convert at the boundary, which means
 * the `Workspace` type, `legacy.ts`, the exporters and every selector still see the nested tree and
 * none of them had to change.
 *
 * A DIRECTORATE'S ID IS ITS ACTOR KEY. There are exactly six, they cannot be created or deleted,
 * and the ref that points at one already uses the actor key. Giving them synthetic ids would mean
 * a second identifier for a thing that already has a perfectly good one.
 *
 * PEOPLE ARE UNITS TOO. It is one more `kind` through the same code path, and it is what lets two
 * people be added to one team at once — the single most likely concurrent roster edit there is.
 */

import { ACTORS, keysBetween, Roster, type Actor } from '@raci/core';

export type RosterUnitKind = 'directorate' | 'division' | 'branch' | 'team' | 'person';

/** One flattened roster unit, as stored in the document. */
export interface RosterUnitRecord {
  readonly id: string;
  readonly kind: RosterUnitKind;
  /** Which directorate's subtree this belongs to. Lets one actor's units be found without a walk. */
  readonly actor: Actor;
  /** Null for a directorate; otherwise the id of the unit above. */
  readonly parentId: string | null;
  readonly order: string;
  readonly name: string;
  readonly externalId: string | null;
  /**
   * The unit's lead, normalized. A directorate calls it `lead` and everything else calls it
   * `chief`; storing one field and renaming it at the boundary keeps the flat record uniform.
   */
  readonly leadId: string | null;
  readonly leadName: string;
  /** People only. Empty on a unit. */
  readonly title: string;
  readonly email: string | null;
}

/** Every kind except a directorate, which is a root and can never be inside anything. */
export type NestableKind = Exclude<RosterUnitKind, 'directorate'>;

const KINDS: Record<RosterUnitKind, NestableKind | null> = {
  directorate: 'division',
  division: 'branch',
  branch: 'team',
  team: 'person',
  person: null,
};

/**
 * The kind of unit that sits directly inside one of `kind`. Null at the leaf.
 *
 * Returning `NestableKind` rather than `RosterUnitKind` is what makes "nothing contains a
 * directorate" a fact the compiler enforces instead of a comment.
 */
export function childKindOf(kind: RosterUnitKind): NestableKind | null {
  return KINDS[kind];
}

const lead = (value: { id: string; name: string } | null | undefined) => ({
  leadId: value?.id ?? null,
  leadName: value?.name ?? '',
});

/** Flatten a nested roster into one record per unit. */
export function flattenRoster(roster: Roster): Record<string, RosterUnitRecord> {
  const out: Record<string, RosterUnitRecord> = {};

  // Order keys come from the array position, which is the order the tree was written in. Anything
  // inserted later gets a key between its new neighbours and never renumbers the rest.
  const ordered = <T>(items: readonly T[]): Array<[T, string]> => {
    const keys = keysBetween(null, null, items.length);
    return items.map((item, i) => [item, keys[i]!] as [T, string]);
  };

  for (const actor of ACTORS) {
    const directorate = roster[actor];
    if (!directorate) continue;

    out[actor] = {
      id: actor,
      kind: 'directorate',
      actor,
      parentId: null,
      order: actor,
      name: '',
      externalId: directorate.externalId,
      ...lead(directorate.lead),
      title: '',
      email: null,
    };

    for (const [division, divisionOrder] of ordered(directorate.divisions)) {
      out[division.id] = {
        id: division.id,
        kind: 'division',
        actor,
        parentId: actor,
        order: divisionOrder,
        name: division.name,
        externalId: division.externalId,
        ...lead(division.chief),
        title: '',
        email: null,
      };

      for (const [branch, branchOrder] of ordered(division.branches)) {
        out[branch.id] = {
          id: branch.id,
          kind: 'branch',
          actor,
          parentId: division.id,
          order: branchOrder,
          name: branch.name,
          externalId: branch.externalId,
          ...lead(branch.chief),
          title: '',
          email: null,
        };

        for (const [team, teamOrder] of ordered(branch.teams)) {
          out[team.id] = {
            id: team.id,
            kind: 'team',
            actor,
            parentId: branch.id,
            order: teamOrder,
            name: team.name,
            externalId: team.externalId,
            ...lead(team.chief),
            title: '',
            email: null,
          };

          for (const [person, personOrder] of ordered(team.people)) {
            out[person.id] = {
              id: person.id,
              kind: 'person',
              actor,
              parentId: team.id,
              order: personOrder,
              name: person.name,
              externalId: person.externalId,
              leadId: null,
              leadName: '',
              title: person.title,
              email: person.email,
            };
          }
        }
      }
    }
  }

  return out;
}

/**
 * Re-nest flattened units into a `Roster`.
 *
 * Tolerant by necessity: this reads a shared document that any peer can have written, so a unit
 * whose parent is gone, or whose kind does not belong under its parent, is dropped rather than
 * throwing. Dropping is the right answer because the alternative — a `Roster.parse` failure — takes
 * the whole workspace down over one bad record.
 */
export function nestRoster(units: Record<string, RosterUnitRecord>): Roster {
  const byParent = new Map<string, RosterUnitRecord[]>();
  for (const unit of Object.values(units)) {
    if (unit.kind === 'directorate') continue;
    if (!unit.parentId) continue;
    const bucket = byParent.get(unit.parentId);
    if (bucket) bucket.push(unit);
    else byParent.set(unit.parentId, [unit]);
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));

  const childrenOf = (id: string, kind: RosterUnitKind) =>
    (byParent.get(id) ?? []).filter((u) => u.kind === kind && units[u.parentId!]);

  const asLead = (unit: RosterUnitRecord) =>
    unit.leadId ? { id: unit.leadId, name: unit.leadName } : null;

  const roster: Record<string, unknown> = {};
  for (const actor of ACTORS) {
    const directorate = units[actor];
    if (!directorate || directorate.kind !== 'directorate') continue;

    roster[actor] = {
      lead: asLead(directorate),
      externalId: directorate.externalId,
      divisions: childrenOf(actor, 'division').map((division) => ({
        id: division.id,
        name: division.name,
        chief: asLead(division),
        externalId: division.externalId,
        branches: childrenOf(division.id, 'branch').map((branch) => ({
          id: branch.id,
          name: branch.name,
          chief: asLead(branch),
          externalId: branch.externalId,
          teams: childrenOf(branch.id, 'team').map((team) => ({
            id: team.id,
            name: team.name,
            chief: asLead(team),
            externalId: team.externalId,
            people: childrenOf(team.id, 'person').map((person) => ({
              id: person.id,
              name: person.name,
              title: person.title,
              externalId: person.externalId,
              email: person.email,
            })),
          })),
        })),
      })),
    };
  }

  return Roster.parse(roster);
}
