/**
 * index.html's orgLabel: a roster ref or entity ref resolved to { short, full } for a badge and its
 * tooltip — with the source's exact wording ("Chief:", "Lead:", "Untitled branch"), and null for a
 * unit that no longer exists, which is what makes a row fall back to its "Assign …" badge.
 *
 * Core's orgLabel serves the exports and the work lens and words things its own way; this is the
 * one the chart's badges and popovers use, so they read as the source's do.
 */
import { entityKindMeta, type OrgRef, type Workspace } from '@raci/core';

export interface LegacyOrgLabel { short: string; full: string }

export function legacyOrgLabel(ws: Workspace, actorLabel: (a: string) => string, org: OrgRef | null | undefined): LegacyOrgLabel | null {
  if (!org) return null;
  if ('entityId' in org) {
    const e = ws.entities[org.entityId];
    if (!e) return { short: '(missing entity)', full: 'This party named an entity that has since been deleted' };
    const name = e.name?.trim() || 'Untitled entity';
    const lead = e.lead?.name ? ` · Lead: ${e.lead.name}` : '';
    return { short: name, full: `${entityKindMeta(e.kind).label}: ${name}${lead}` };
  }
  const dir = ws.roster[org.actor];
  const d = org.divisionId ? dir?.divisions.find((x) => x.id === org.divisionId) : undefined;
  const b = org.branchId ? d?.branches.find((x) => x.id === org.branchId) : undefined;
  if (org.teamId) {
    const tm = b?.teams.find((x) => x.id === org.teamId);
    if (!tm) return null;
    const lead = tm.chief?.name ? ` · Lead: ${tm.chief.name}` : '';
    const tmName = tm.name || 'Unnamed team';
    return { short: tmName, full: `${actorLabel(org.actor)} › ${d?.name || '—'} › ${b?.name || '—'} › ${tmName}${lead}` };
  }
  if (org.branchId) {
    if (!b) return null;
    const chief = b.chief?.name ? ` · Chief: ${b.chief.name}` : '';
    return { short: b.name || 'Untitled branch', full: `${actorLabel(org.actor)} › ${d?.name || '—'} › ${b.name || 'Untitled branch'}${chief}` };
  }
  if (org.divisionId) {
    if (!d) return null;
    const chief = d.chief?.name ? ` · Chief: ${d.chief.name}` : '';
    return { short: d.name || 'Untitled division', full: `${actorLabel(org.actor)} › ${d.name || 'Untitled division'}${chief}` };
  }
  return null;
}
