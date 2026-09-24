/**
 * The two roster writes the Roster screen needs beyond the per-unit ones in mutations.ts.
 *
 *   - `setActorLabel` renames a directorate. A directorate's display name is not a field of its unit
 *     record: it is the workspace's `actorLabels` override, the same vocabulary the chart's columns
 *     and every org badge read, which is why index.html's rename writes `state.actorLabels`.
 *   - `ensureDirectorateUnit` makes sure a directorate HAS a unit record before anything is written
 *     under it. index.html always holds all six directorates; a workspace started empty here holds
 *     none until something creates them, and every per-unit write needs its parent to exist.
 */

import type * as Y from 'yjs';
import { Roster, type Actor } from '@raci/core';
import { maps, toYMap } from './doc.js';
import { LOCAL_ORIGIN } from './mutations.js';
import { flattenRoster, type RosterUnitRecord } from './roster.js';

/**
 * Set one directorate's display name.
 *
 * `actorLabels` is one plain value in the meta map, so this rewrites the whole set with one entry
 * changed — the same last-writer-wins trade `setColumnLabels` makes. Two people renaming two
 * different directorates in the same instant can lose one rename; a rename is rare and visible
 * enough that this is cheaper than giving six labels a map of their own.
 */
export function setActorLabel(
  doc: Y.Doc,
  actor: Actor,
  label: string,
  origin: unknown = LOCAL_ORIGIN,
): void {
  doc.transact(() => {
    const meta = maps(doc).meta;
    const current = (meta.get('actorLabels') as Record<string, string> | undefined) ?? {};
    meta.set('actorLabels', { ...current, [actor]: label });
  }, origin);
}

/**
 * Create `actor`'s directorate record if the document does not have one yet. A no-op otherwise,
 * so it costs nothing to call before every write under a directorate.
 *
 * A document persisted before the roster was flattened still holds it in the old one-value-per-
 * directorate `roster` map, and `readWorkspace` falls back to that only while `rosterUnits` is
 * EMPTY. Adding a single unit there would silently hide every other directorate, so the first
 * write migrates the whole roster forward in the same transaction.
 */
export function ensureDirectorateUnit(
  doc: Y.Doc,
  actor: Actor,
  origin: unknown = LOCAL_ORIGIN,
): void {
  const m = maps(doc);
  if (m.rosterUnits.has(actor)) return;
  doc.transact(() => {
    if (m.rosterUnits.size === 0 && m.roster.size > 0) {
      const legacy: Record<string, unknown> = {};
      for (const [key, value] of m.roster.entries()) legacy[key] = value;
      for (const [id, unit] of Object.entries(flattenRoster(Roster.parse(legacy)))) {
        m.rosterUnits.set(id, toYMap({ ...unit }));
      }
    }
    if (m.rosterUnits.has(actor)) return;
    const record: RosterUnitRecord = {
      id: actor,
      kind: 'directorate',
      actor,
      parentId: null,
      order: actor,
      name: '',
      externalId: null,
      leadId: null,
      leadName: '',
      title: '',
      email: null,
    };
    m.rosterUnits.set(actor, toYMap({ ...record }));
  }, origin);
}
