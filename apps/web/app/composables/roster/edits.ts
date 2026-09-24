/**
 * Every edit the Roster screen makes, and the in-place text editing it makes them with.
 *
 * index.html's roster mutations (addDivision, deleteBranch, setLead, commitRosterEdit, the entity
 * setters…) ported one for one: same default names, same confirms, same toast, same "only if it
 * changed" guards. What differs is only where the write lands — a per-unit, per-field CRDT write
 * through @raci/crdt instead of a splice into a nested array — so two people editing different
 * corners of one directorate never overwrite each other, and each write is one step of undo.
 *
 * Shared by the page and its components (LeadSlot, PersonRow, the Full-hierarchy panels, the entity
 * cards) so each can be the source's render function it stands for without threading a dozen
 * callbacks through props.
 *
 * In a subfolder on purpose: Nuxt auto-imports every export of a top-level composables/ file into
 * every file of the app, and names like `deriveShort`, `entityName` or `ROLE_LABELS` would collide
 * with whatever another screen calls its own. The roster's files import this one explicitly.
 */

import { nextTick, type Directive } from 'vue';
import type { WorkspaceSession } from '~/composables/useWorkspaceSession';
import type { ShellBridge } from '~/composables/useShell';
import {
  ACTOR_LABELS_DEFAULT,
  ENTITY_KINDS,
  entityUsesInOrder,
  newId,
  type Actor,
  type Entity,
} from '@raci/core';
import {
  addEntity as addEntityRecord,
  addRosterUnit,
  deleteEntity as deleteEntityRecord,
  deleteRosterUnit,
  ensureDirectorateUnit,
  maps,
  setActorLabel,
  setEntityField,
  setRosterLead,
  setRosterUnitField,
} from '@raci/crdt';

/** A lead's role, as the source's lead slots name it. */
export type LeadRole = 'AD' | 'DC' | 'BC' | 'TL';

export const ROLE_LABELS: Record<LeadRole, string> = {
  AD: 'Associate Director',
  DC: 'Division Chief',
  BC: 'Branch Chief',
  TL: 'Team Lead',
};
export const ROLE_ADD_LABELS: Record<LeadRole, string> = {
  AD: '+ Set Associate Director',
  DC: '+ Set Division Chief',
  BC: '+ Set Branch Chief',
  TL: '+ Set Team Lead',
};

/**
 * Not in the source, which has no directory behind it. A unit or person the directory sync brought
 * in says so on hover — a `title`, so the layout is the source's — because a rename made here lasts
 * only until the next sync re-asserts the directory's name.
 */
export const FROM_DIRECTORY = 'From the directory — the next sync will re-assert this name';

/** index.html's entityName: what an unnamed entity is called wherever it is listed. */
export function entityName(e: Pick<Entity, 'name'> | null | undefined): string {
  return (e && e.name && e.name.trim()) || 'Untitled entity';
}

/** index.html's deriveShort: the abbreviation a label falls back to when it has no short form. */
export function deriveShort(label: string): string {
  const words = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 5);
  return words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 4);
}

// ---- in-place text ---------------------------------------------------------------------------------

/** What a contenteditable field shows, and what to do with an edit to it. */
export interface EditableText {
  /** What the document holds. The field shows exactly this whenever nobody is typing in it. */
  readonly text: string;
  /** Receives the trimmed text on blur — only when the person actually changed something. */
  readonly commit: (value: string) => void;
}

interface Live {
  binding: EditableText;
  /** The text when the field took focus; null while it does not have focus. */
  start: string | null;
}
const live = new WeakMap<HTMLElement, Live>();

/**
 * Whether the element holds exactly `text` and nothing else. Comparing textContent is not enough:
 * clearing a field leaves the browser's own `<br>` behind, which reads as '' but is not `:empty`,
 * so the field's placeholder would never come back.
 */
function holds(el: HTMLElement, text: string): boolean {
  if (!text) return el.childNodes.length === 0;
  const only = el.firstChild;
  return el.childNodes.length === 1 && only instanceof Text && only.data === text;
}

function show(el: HTMLElement, text: string): void {
  // Never under someone's caret: a colleague's edit to the same field lands when this person
  // leaves it, rather than yanking the text out from under their typing.
  if (document.activeElement !== el && !holds(el, text)) el.textContent = text;
}

/**
 * `v-editable-text` — the source's `contenteditable` spans and their delegated handlers, per field.
 *
 * The text is set on the element rather than rendered as a child, so the browser owns the element's
 * contents while someone types and the framework never patches a text node the caret is sitting in.
 * Otherwise it is index.html's contract: Enter (without Shift) ends the edit, blur commits the
 * trimmed text, and afterwards the field shows what the document now holds — the source repaints
 * after a commit, which is how an emptied directorate name comes back as its default.
 *
 * Unlike the source it commits only a CHANGED field. Here every commit is a shared write and an
 * undo step, and clicking through a field is not an edit.
 */
export const vEditableText: Directive<HTMLElement, EditableText> = {
  mounted(el, { value }) {
    const state: Live = { binding: value, start: null };
    live.set(el, state);
    el.textContent = value.text;
    el.addEventListener('focus', () => {
      state.start = el.textContent ?? '';
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && el.isContentEditable) {
        e.preventDefault();
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      const typed = el.textContent ?? '';
      const started = state.start;
      state.start = null;
      if (started !== null && typed !== started && el.isContentEditable) state.binding.commit(typed.trim());
      // The commit re-renders on the next tick; show the result then, or the old text if the
      // write turned out to change nothing.
      void nextTick(() => show(el, state.binding.text));
    });
  },
  updated(el, { value }) {
    const state = live.get(el);
    if (state) state.binding = value;
    show(el, value.text);
  },
  unmounted(el) {
    live.delete(el);
  },
};

// ---- the edits ---------------------------------------------------------------------------------------

/**
 * One set of edits per workspace session, shared by every component that asks: the Full hierarchy
 * mounts a component per unit and per person — several hundred on the demo — and each of them
 * building its own copy of these closures would be work for nothing.
 */
const perSession = new WeakMap<WorkspaceSession, RosterEdits>();

export type RosterEdits = ReturnType<typeof createRosterEdits>;

export function useRosterEdits(): RosterEdits {
  const session = useWorkspaceSession();
  let edits = perSession.get(session);
  if (!edits) {
    edits = createRosterEdits(session, useShell(), inject<Ref<boolean>>('raci:canEdit', ref(false)));
    perSession.set(session, edits);
  }
  return edits;
}

function createRosterEdits(session: WorkspaceSession, shell: ShellBridge, canEdit: Ref<boolean>) {
  const doc = session.doc;
  const ws = () => session.workspace.value;
  /** A unit a colleague deleted a moment ago is not an error — the source's `if (d)` guards. */
  const exists = (id: string | null | undefined): id is string => !!id && maps(doc).rosterUnits.has(id);

  const actorLabel = (a: Actor) => ws().actorLabels[a] || ACTOR_LABELS_DEFAULT[a];
  const findDivision = (a: Actor, divId: string) => ws().roster[a]?.divisions.find((d) => d.id === divId);
  const findBranch = (a: Actor, divId: string, brId: string) =>
    findDivision(a, divId)?.branches.find((b) => b.id === brId);

  /** Which record holds the lead a slot shows. A directorate's lead lives on the directorate. */
  const leadUnit = (a: Actor, divId: string | null, brId: string | null, teamId: string | null, role: LeadRole) =>
    role === 'AD' ? a : role === 'DC' ? divId : role === 'BC' ? brId : teamId;

  function addDivision(a: Actor) {
    if (!canEdit.value) return;
    const n = ws().roster[a]?.divisions.length ?? 0;
    ensureDirectorateUnit(doc, a);
    addRosterUnit(doc, a, `Division ${n + 1}`);
  }
  function deleteDivision(divId: string) {
    if (!canEdit.value || !exists(divId)) return;
    if (!confirm('Delete this division and all its branches/people?')) return;
    deleteRosterUnit(doc, divId);
  }
  function addBranch(a: Actor, divId: string) {
    if (!canEdit.value || !exists(divId)) return;
    const n = findDivision(a, divId)?.branches.length ?? 0;
    addRosterUnit(doc, divId, `Branch ${n + 1}`);
  }
  function deleteBranch(brId: string) {
    if (!canEdit.value || !exists(brId)) return;
    if (!confirm('Delete this branch and all its people?')) return;
    deleteRosterUnit(doc, brId);
  }
  function addTeam(a: Actor, divId: string, brId: string) {
    if (!canEdit.value || !exists(brId)) return;
    const n = findBranch(a, divId, brId)?.teams.length ?? 0;
    addRosterUnit(doc, brId, `Team ${n + 1}`);
  }
  function deleteTeam(teamId: string) {
    if (!canEdit.value || !exists(teamId)) return;
    if (!confirm('Delete this team and all its people?')) return;
    deleteRosterUnit(doc, teamId);
  }
  function addPerson(teamId: string) {
    if (!canEdit.value || !exists(teamId)) return;
    addRosterUnit(doc, teamId, '');
  }
  function deletePerson(personId: string) {
    if (!canEdit.value || !exists(personId)) return;
    deleteRosterUnit(doc, personId);
  }

  function setLead(a: Actor, divId: string | null, brId: string | null, teamId: string | null, role: LeadRole) {
    if (!canEdit.value) return;
    if (role === 'AD') ensureDirectorateUnit(doc, a);
    const unit = leadUnit(a, divId, brId, teamId, role);
    if (exists(unit)) setRosterLead(doc, unit, { id: newId('person'), name: '' });
  }
  function removeLead(a: Actor, divId: string | null, brId: string | null, teamId: string | null, role: LeadRole) {
    if (!canEdit.value) return;
    const unit = leadUnit(a, divId, brId, teamId, role);
    if (exists(unit)) setRosterLead(doc, unit, null);
  }
  function commitLeadName(
    a: Actor, divId: string | null, brId: string | null, teamId: string | null, role: LeadRole, value: string,
  ) {
    if (!canEdit.value) return;
    const unit = leadUnit(a, divId, brId, teamId, role);
    // No lead, nothing to name — the source's `if (!lead) return`.
    if (!exists(unit) || maps(doc).rosterUnits.get(unit)?.get('leadId') == null) return;
    setRosterUnitField(doc, unit, 'leadName', value);
  }

  /** A division, branch, team or person name (the source's div-name / branch-name / team-name / p-name). */
  function renameUnit(id: string, value: string) {
    if (canEdit.value && exists(id)) setRosterUnitField(doc, id, 'name', value);
  }
  function setPersonTitle(id: string, value: string) {
    if (canEdit.value && exists(id)) setRosterUnitField(doc, id, 'title', value);
  }
  /** A blank name is not a name: it falls back to the directorate's default label. */
  function renameDirectorate(a: Actor, name: string) {
    if (!canEdit.value) return;
    const v = name || ACTOR_LABELS_DEFAULT[a];
    if (v !== actorLabel(a)) setActorLabel(doc, a, v);
  }

  // ---- entities ----
  async function addEntity() {
    if (!canEdit.value) return;
    const id = addEntityRecord(doc, '', 'board');
    await nextTick();
    const el = document.querySelector<HTMLElement>(`.ent-name[data-entity-id="${id}"]`);
    if (el) {
      el.focus();
      document.execCommand?.('selectAll', false);
    }
  }
  function deleteEntity(id: string) {
    if (!canEdit.value) return;
    const e = ws().entities[id];
    if (!e) return;
    // References are not rewritten on delete — they read "(missing entity)" — so the warning names
    // what would be left dangling rather than just how many.
    const uses = entityUsesInOrder(ws(), id);
    if (
      uses.length &&
      !confirm(
        `"${entityName(e)}" is named as a party by ${uses.length} ${uses.length === 1 ? 'thing' : 'things'}:\n\n` +
          uses.slice(0, 8).map((u) => `  • ${u.where} › ${u.name}`).join('\n') +
          (uses.length > 8 ? `\n  … and ${uses.length - 8} more` : '') +
          `\n\nDelete it anyway? Those parties will read "(missing entity)" until they are re-pointed.`,
      )
    ) {
      return;
    }
    deleteEntityRecord(doc, id);
    shell.toast(`Entity "${entityName(e)}" deleted.`);
  }
  function setEntityKind(id: string, kind: string) {
    if (!canEdit.value) return;
    const e = ws().entities[id];
    if (!e || !(ENTITY_KINDS as readonly string[]).includes(kind) || e.kind === kind) return;
    setEntityField(doc, id, 'kind', kind);
  }
  function commitEntityField(id: string, field: 'ent-name' | 'ent-short' | 'ent-desc' | 'ent-lead', v: string) {
    if (!canEdit.value) return;
    const e = ws().entities[id];
    if (!e) return;
    if (field === 'ent-name') {
      if (e.name !== v) setEntityField(doc, id, 'name', v);
    } else if (field === 'ent-short') {
      if (e.short !== v) setEntityField(doc, id, 'short', v);
    } else if (field === 'ent-desc') {
      if (e.description !== v) setEntityField(doc, id, 'description', v);
    } else if ((e.lead?.name ?? '') !== v) {
      setEntityField(doc, id, 'lead', v ? { id: e.lead?.id ?? newId('person'), name: v } : null);
    }
  }

  return {
    canEdit,
    addDivision,
    deleteDivision,
    addBranch,
    deleteBranch,
    addTeam,
    deleteTeam,
    addPerson,
    deletePerson,
    setLead,
    removeLead,
    commitLeadName,
    renameUnit,
    setPersonTitle,
    renameDirectorate,
    addEntity,
    deleteEntity,
    setEntityKind,
    commitEntityField,
  };
}
