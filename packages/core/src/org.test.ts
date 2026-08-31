import { describe, it, expect } from 'vitest';
import demo from './__fixtures__/demo-workspace.json' with { type: 'json' };
import { importLegacy } from './legacy.js';
import {
  inheritedOrg,
  isWithinScope,
  orgLabel,
  orgRefPath,
  orgScopes,
  orgTier,
  scopeRelation,
} from './org.js';
import { rootsOf, childrenOf } from './tree.js';

const { workspace } = importLegacy(demo);
const chart = Object.values(workspace.charts)[0]!;
const division = workspace.roster.cyber!.divisions[0]!;
const branch = division.branches[0]!;
const team = branch.teams[0]!;

const DIRECTORATE = { actor: 'cyber' } as const;
const DIVISION = { actor: 'cyber', divisionId: division.id } as const;
const BRANCH = { actor: 'cyber', divisionId: division.id, branchId: branch.id } as const;
const TEAM = { ...BRANCH, teamId: team.id } as const;

describe('org ref paths', () => {
  it('reads a ref as a path from the root down', () => {
    expect(orgRefPath(DIRECTORATE)).toEqual(['actor:cyber']);
    expect(orgRefPath(TEAM)).toEqual(['actor:cyber', division.id, branch.id, team.id]);
  });

  it('puts an entity in its own namespace, so it cannot collide with a unit', () => {
    // Both are OrgRefs and both are compared by path. Without the prefix an entity whose id
    // happened to match a division id would silently be treated as that division.
    expect(orgRefPath({ entityId: 'x' })).toEqual(['entity:x']);
    expect(scopeRelation({ entityId: 'cyber' }, { actor: 'cyber' })).toBeNull();
  });

  it('names the tier a ref stops at', () => {
    expect(orgTier(DIRECTORATE)).toBe('directorate');
    expect(orgTier(DIVISION)).toBe('division');
    expect(orgTier(BRANCH)).toBe('branch');
    expect(orgTier(TEAM)).toBe('team');
    expect(orgTier({ entityId: 'e' })).toBe('entity');
    expect(orgTier(null)).toBeNull();
  });
});

describe('scope relations', () => {
  it('calls a unit inside the scope direct', () => {
    expect(scopeRelation(DIVISION, BRANCH)).toBe('direct');
    expect(scopeRelation(DIVISION, TEAM)).toBe('direct');
    expect(scopeRelation(DIVISION, DIVISION)).toBe('direct');
  });

  it('calls a unit ABOVE the scope inherited', () => {
    // Assigned to the whole directorate with nothing more specific named, so it lands on every
    // division under it — including this one. A different question from "given to us", and the
    // work lens shows them apart for exactly that reason.
    expect(scopeRelation(DIVISION, DIRECTORATE)).toBe('inherited');
    expect(scopeRelation(TEAM, BRANCH)).toBe('inherited');
  });

  it('calls a sibling nothing', () => {
    const other = division.branches[1];
    if (!other) return;
    expect(scopeRelation(BRANCH, { ...BRANCH, branchId: other.id })).toBeNull();
  });

  it('calls a different directorate nothing, however deep either goes', () => {
    expect(scopeRelation(TEAM, { actor: 'sw' })).toBeNull();
    expect(scopeRelation({ actor: 'sw' }, TEAM)).toBeNull();
  });

  it('is null when either side is unset — an unassigned row belongs to nobody', () => {
    expect(scopeRelation(null, TEAM)).toBeNull();
    expect(scopeRelation(TEAM, null)).toBeNull();
    expect(scopeRelation(null, null)).toBeNull();
  });

  it('isWithinScope is the direct half, and excludes an ancestor', () => {
    expect(isWithinScope(DIVISION, TEAM)).toBe(true);
    expect(isWithinScope(TEAM, DIVISION)).toBe(false);
  });
});

describe('labels', () => {
  it('reads the full path and the badge off the roster', () => {
    const label = orgLabel(workspace, TEAM)!;
    expect(label.full.split(' › ')).toHaveLength(4);
    expect(label.short).toBe(team.name);
    expect(label.missing).toBe(false);
  });

  it('uses the workspace’s own vocabulary for the directorate when it has one', () => {
    const ws = structuredClone(workspace);
    ws.actorLabels['cyber'] = 'Cyber Security Branch';
    expect(orgLabel(ws, DIRECTORATE)!.full).toBe('Cyber Security Branch');
  });

  it('resolves a ref to something deleted rather than dropping it', () => {
    // A row that silently lost its assignment is indistinguishable from one that never had an
    // assignment, and the first is a much bigger problem than the second.
    const label = orgLabel(workspace, { actor: 'cyber', divisionId: 'div_gone' })!;
    expect(label.missing).toBe(true);
    expect(label.short).toBe('(missing unit)');
    expect(label.full).toContain('(missing unit)');
  });

  it('labels an entity ref, and marks a deleted one missing', () => {
    const entity = Object.values(workspace.entities)[0]!;
    const found = orgLabel(workspace, { entityId: entity.id })!;
    expect(found.short).toBe(entity.short || entity.name);
    expect(found.missing).toBe(false);
    expect(orgLabel(workspace, { entityId: 'ent_gone' })!.missing).toBe(true);
  });

  it('returns null for no ref at all', () => {
    expect(orgLabel(workspace, null)).toBeNull();
  });
});

describe('the org cascade on chart rows', () => {
  it('takes a row’s own assignment when it states one', () => {
    const stated = Object.values(chart.nodes).find((n) => n.org)!;
    const found = inheritedOrg(chart.nodes, stated.id);
    expect(found.own).toBe(true);
    expect(found.ref).toEqual(stated.org);
  });

  it('falls to the NEAREST ancestor that states one, not the topmost', () => {
    const ws = structuredClone(workspace);
    const c = Object.values(ws.charts)[0]!;
    const root = rootsOf(c.nodes)[0]!;
    const child = childrenOf(c.nodes, root.id)[0]!;
    const grandchild = childrenOf(c.nodes, child.id)[0]!;

    root.org = { actor: 'sw' };
    child.org = { actor: 'cyber', divisionId: division.id };
    grandchild.org = null;

    const found = inheritedOrg(c.nodes, grandchild.id);
    expect(found.own).toBe(false);
    expect(found.ref).toEqual({ actor: 'cyber', divisionId: division.id });
  });

  it('is null when nothing above states one either', () => {
    const ws = structuredClone(workspace);
    const c = Object.values(ws.charts)[0]!;
    for (const node of Object.values(c.nodes)) node.org = null;
    const any = Object.keys(c.nodes)[0]!;
    expect(inheritedOrg(c.nodes, any)).toEqual({ ref: null, own: false });
  });

  it('is null for a row that does not exist', () => {
    expect(inheritedOrg(chart.nodes, 'n_nope')).toEqual({ ref: null, own: false });
  });
});

describe('the scope picker', () => {
  const scopes = orgScopes(workspace);

  it('offers every unit at every tier', () => {
    const counts = { directorate: 0, division: 0, branch: 0, team: 0, entity: 0 };
    for (const scope of scopes) counts[scope.tier]++;
    expect(counts.directorate).toBe(Object.keys(workspace.roster).length);
    expect(counts.division).toBeGreaterThan(0);
    expect(counts.branch).toBeGreaterThan(0);
    expect(counts.team).toBeGreaterThan(0);
  });

  it('lists each unit under its parent, so the picker reads as a tree', () => {
    const tiers = scopes.map((s) => s.tier);
    expect(tiers[0]).toBe('directorate');
    // A division is never listed before the directorate it belongs to.
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i]!;
      if (scope.tier === 'directorate') continue;
      const parentSeen = scopes.slice(0, i).some((s) => scopeRelation(s.ref, scope.ref) === 'direct');
      expect(parentSeen).toBe(true);
    }
  });

  it('resolves a label for every scope it offers', () => {
    for (const scope of scopes) expect(scope.label.missing).toBe(false);
  });
});
