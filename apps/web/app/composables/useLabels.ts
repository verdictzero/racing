/**
 * The workspace's display vocabulary — index.html's COL_LABELS / COL_SHORT / ACTOR_LABELS and
 * columnActorKey / columnPerson, read from the document with the source's defaults underneath.
 *
 * A workbook import can rename the parties workspace-wide, so these are never constants in a
 * screen; every label goes through here.
 */
import {
  ACTORS,
  ACTOR_LABELS_DEFAULT,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  type Actor,
  type Chart,
} from '@raci/core';

export function useLabels() {
  const session = useWorkspaceSession();
  const ws = computed(() => session.workspace.value);

  /** Full column label. A free-form chart's own columns carry their own. */
  function colLabel(key: string, chart?: Pick<Chart, 'custom'> | null): string {
    const own = chart?.custom?.cols.find((c) => c.key === key);
    if (own) return own.label || 'Party';
    return ws.value.columnLabels[key] ?? COL_LABELS_DEFAULT[key as keyof typeof COL_LABELS_DEFAULT] ?? key;
  }
  function colShort(key: string, chart?: Pick<Chart, 'custom'> | null): string {
    const own = chart?.custom?.cols.find((c) => c.key === key);
    if (own) return own.short || own.label || 'Party';
    return ws.value.columnShort[key] ?? COL_SHORT_DEFAULT[key as keyof typeof COL_SHORT_DEFAULT] ?? key;
  }
  function actorLabel(actor: string): string {
    return ws.value.actorLabels[actor] ?? ACTOR_LABELS_DEFAULT[actor as Actor] ?? actor;
  }
  /**
   * The directorate behind a column. index.html's defaultColumnActor self-maps the columns whose
   * key is also a directorate key (mission, infra, cyber, sw) and leaves the rest unmapped; an
   * explicit mapping in the document wins.
   */
  function columnActor(col: string): Actor | null {
    const map = ws.value.columnActor;
    const a = Object.prototype.hasOwnProperty.call(map, col) ? map[col] : (ACTORS as readonly string[]).includes(col) ? col : null;
    return a && (ACTORS as readonly string[]).includes(a) ? (a as Actor) : null;
  }
  /** The named person behind a column: its directorate's lead. null when unmapped. */
  function columnPerson(col: string): { actor: Actor; actorLabel: string; name: string } | null {
    const a = columnActor(col);
    if (!a) return null;
    const lead = ws.value.roster[a]?.lead;
    return { actor: a, actorLabel: actorLabel(a), name: lead?.name?.trim() ?? '' };
  }
  return { colLabel, colShort, actorLabel, columnActor, columnPerson };
}
