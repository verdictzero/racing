/**
 * Org references: what a party actually points at, and how two of them relate.
 *
 * A responsibility is assigned to an OrgRef — either a unit somewhere in the roster tree
 * (directorate › division › branch › team) or a flat entity from the registry. Almost every screen
 * needs the same three answers about one:
 *
 *   what is it called          `orgLabel`
 *   where does it sit          `orgRefPath`
 *   does it fall under X       `scopeRelation`
 *
 * In `index.html` these are `partyLabel`, `orgRefPath` and `scopeRelation`, defined near the roster
 * renderer and reached from six other places. Here they are pure functions over the workspace.
 *
 * A REF TO SOMETHING DELETED RESOLVES, IT DOES NOT VANISH. A division that was removed by a
 * directory sync still reads "(missing unit)" wherever it was named, because a row that silently
 * lost its assignment looks identical to a row that never had one — and the second is a much
 * smaller problem than the first.
 */

import { ACTOR_LABELS_DEFAULT, ACTORS, type Actor } from './constants.js';
import { ancestorsOf, type NodeMap } from './tree.js';
import type { Branch, Division, OrgRef, Team, Workspace } from './schema.js';

/** How specific a ref is. The array's length IS the tier. */
export type OrgTier = 'entity' | 'directorate' | 'division' | 'branch' | 'team';

export interface OrgLabel {
  /** The full path, for a tooltip: "Cyber › Threat Ops › SOC". */
  readonly full: string;
  /** The deepest named unit, for a badge. */
  readonly short: string;
  readonly tier: OrgTier;
  /** True when some part of the path no longer resolves. */
  readonly missing: boolean;
}

const isEntityRef = (ref: OrgRef): ref is { entityId: string } => 'entityId' in ref;

/**
 * A ref as a path of ids, root first.
 *
 * The comparison key for everything else here. An entity is a one-element path in its own
 * namespace, so it can never accidentally compare equal to a roster unit.
 */
export function orgRefPath(ref: OrgRef | null | undefined): string[] {
  if (!ref) return [];
  if (isEntityRef(ref)) return [`entity:${ref.entityId}`];
  const path = [`actor:${ref.actor}`];
  if (ref.divisionId) path.push(ref.divisionId);
  if (ref.branchId) path.push(ref.branchId);
  if (ref.teamId) path.push(ref.teamId);
  return path;
}

export function orgTier(ref: OrgRef | null | undefined): OrgTier | null {
  if (!ref) return null;
  if (isEntityRef(ref)) return 'entity';
  if (ref.teamId) return 'team';
  if (ref.branchId) return 'branch';
  if (ref.divisionId) return 'division';
  return 'directorate';
}

/**
 * How `ref` relates to `scope`.
 *
 *   'direct'    — ref IS the scope, or sits inside it. The work is the unit's own.
 *   'inherited' — ref is an ANCESTOR of the scope. Assigned to the parent org with no deeper unit
 *                 named, so it lands on everyone underneath, including this unit.
 *   null        — unrelated, or either side is unset.
 *
 * The distinction is the entire point of the work lens: "what did someone give my team" and "what
 * does my team pick up because nobody named anyone more specific" are different questions, and a
 * list that merged them would be read as the first and be wrong.
 */
export function scopeRelation(
  scope: OrgRef | null | undefined,
  ref: OrgRef | null | undefined,
): 'direct' | 'inherited' | null {
  const a = orgRefPath(scope);
  const b = orgRefPath(ref);
  if (a.length === 0 || b.length === 0) return null;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return null;
  return b.length >= a.length ? 'direct' : 'inherited';
}

/** True when `ref` is the scope or anything inside it. */
export function isWithinScope(scope: OrgRef | null | undefined, ref: OrgRef | null | undefined): boolean {
  return scopeRelation(scope, ref) === 'direct';
}

function findDivision(ws: Workspace, actor: Actor, divisionId: string): Division | null {
  return ws.roster[actor]?.divisions.find((d) => d.id === divisionId) ?? null;
}
function findBranch(ws: Workspace, actor: Actor, divisionId: string, branchId: string): Branch | null {
  return findDivision(ws, actor, divisionId)?.branches.find((b) => b.id === branchId) ?? null;
}
function findTeam(
  ws: Workspace,
  actor: Actor,
  divisionId: string,
  branchId: string,
  teamId: string,
): Team | null {
  return findBranch(ws, actor, divisionId, branchId)?.teams.find((t) => t.id === teamId) ?? null;
}

const MISSING = '(missing unit)';

/** Resolve a ref against the roster and the entity registry. Never returns null for a real ref. */
export function orgLabel(ws: Workspace, ref: OrgRef | null | undefined): OrgLabel | null {
  if (!ref) return null;

  if (isEntityRef(ref)) {
    const entity = ws.entities[ref.entityId];
    const name = entity?.name || '(missing entity)';
    return {
      full: name,
      short: entity?.short || name,
      tier: 'entity',
      missing: !entity,
    };
  }

  if (!ACTORS.includes(ref.actor)) return null;
  const parts: string[] = [ws.actorLabels[ref.actor] || ACTOR_LABELS_DEFAULT[ref.actor]];
  let missing = false;

  if (ref.divisionId) {
    const division = findDivision(ws, ref.actor, ref.divisionId);
    parts.push(division?.name || MISSING);
    missing ||= !division;

    if (ref.branchId) {
      const branch = findBranch(ws, ref.actor, ref.divisionId, ref.branchId);
      parts.push(branch?.name || MISSING);
      missing ||= !branch;

      if (ref.teamId) {
        const team = findTeam(ws, ref.actor, ref.divisionId, ref.branchId, ref.teamId);
        parts.push(team?.name || MISSING);
        missing ||= !team;
      }
    }
  }

  return {
    full: parts.join(' › '),
    short: parts[parts.length - 1] ?? '',
    tier: orgTier(ref) ?? 'directorate',
    missing,
  };
}

/**
 * The org a chart row belongs to, its own if it states one and its nearest ancestor's otherwise.
 *
 * The same cascade the org badges read: a Project under a Program assigned to a division belongs to
 * that division until it says otherwise. Returns the ref AND whether it was stated here, because
 * the work lens shows an inherited assignment differently from a stated one.
 */
export function inheritedOrg(
  nodes: NodeMap,
  nodeId: string,
): { ref: OrgRef | null; own: boolean } {
  const node = nodes[nodeId];
  if (!node) return { ref: null, own: false };
  if (node.org) return { ref: node.org, own: true };
  // `ancestorsOf` is already nearest-first, which is the order this needs: the closest ancestor
  // that states an org wins, so a Project under a Program assigned to a division belongs to that
  // division and not to whatever the Portfolio at the top says.
  for (const ancestor of ancestorsOf(nodes, nodeId)) {
    if (ancestor.org) return { ref: ancestor.org, own: false };
  }
  return { ref: null, own: false };
}

/** Every unit in the roster, as pickable scopes. What the work lens's scope picker lists. */
export function orgScopes(ws: Workspace): Array<{ ref: OrgRef; label: OrgLabel; tier: OrgTier }> {
  const out: Array<{ ref: OrgRef; label: OrgLabel; tier: OrgTier }> = [];
  const push = (ref: OrgRef) => {
    const label = orgLabel(ws, ref);
    if (label) out.push({ ref, label, tier: label.tier });
  };

  for (const actor of ACTORS) {
    if (!ws.roster[actor]) continue;
    push({ actor });
    for (const division of ws.roster[actor]?.divisions ?? []) {
      push({ actor, divisionId: division.id });
      for (const branch of division.branches) {
        push({ actor, divisionId: division.id, branchId: branch.id });
        for (const team of branch.teams) {
          push({ actor, divisionId: division.id, branchId: branch.id, teamId: team.id });
        }
      }
    }
  }
  return out;
}
