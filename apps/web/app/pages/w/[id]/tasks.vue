<template>
  <div class="wk">
    <div class="wk-head">
      <div>
        <h2>Tasks</h2>
        <p class="meta">
          What one unit actually owns, gathered from every chart and every flow in the workspace.
        </p>
      </div>

      <div class="wk-picker">
        <select v-model="actor" aria-label="Directorate">
          <option value="">— directorate —</option>
          <option v-for="d in directorates" :key="d.key" :value="d.key">{{ d.label }}</option>
        </select>
        <select v-model="divisionId" :disabled="!actor" aria-label="Division">
          <option value="">— whole directorate —</option>
          <option v-for="d in divisions" :key="d.id" :value="d.id">{{ d.name || 'Untitled division' }}</option>
        </select>
        <select v-model="branchId" :disabled="!divisionId" aria-label="Branch">
          <option value="">— whole division —</option>
          <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name || 'Untitled branch' }}</option>
        </select>
        <select v-model="teamId" :disabled="!branchId" aria-label="Team">
          <option value="">— whole branch —</option>
          <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name || 'Unnamed team' }}</option>
        </select>
      </div>
    </div>

    <p v-if="!scope" class="wk-choose">
      Choose a unit above to see what lands on it.
    </p>

    <template v-else>
      <div class="wk-scope">
        <strong>{{ scopeLabel?.full }}</strong>
        <span class="wk-tally">
          {{ summary.total }} item{{ summary.total === 1 ? '' : 's' }}
        </span>
        <span v-for="letter in letters" :key="letter" class="wk-letter" :title="letterTitle(letter)">
          {{ letter }} <b>{{ summary.byLetter[letter] }}</b>
        </span>
      </div>

      <section v-for="group in groups" :key="group.key" class="wk-group">
        <h3>{{ group.title }} <span class="wk-count">{{ group.items.length }}</span></h3>
        <p class="wk-hint">{{ group.hint }}</p>

        <div class="wk-cards">
          <article v-for="item in group.items" :key="item.nodeId ?? item.stepId" class="wk-card">
            <div class="wk-card-head">
              <span class="wk-name">{{ item.name }}</span>
              <span v-if="item.unit" class="wk-unit" :title="'Assigned org unit'">{{ item.unit }}</span>
            </div>
            <div class="wk-meta">{{ item.where }}</div>

            <div v-if="item.roles.length" class="wk-roles">
              <span
                v-for="role in item.roles"
                :key="role.column"
                class="wk-role"
                :class="{ inh: role.inherited }"
                :title="roleTitle(role)"
              >
                <span class="wk-role-col">{{ shortLabel(role.column) }}</span>{{ role.letters }}
              </span>
            </div>

            <p v-if="item.description" class="wk-desc">{{ item.description }}</p>
            <p v-if="item.entry" class="wk-crit"><span class="wk-crit-lbl entry">entry</span>{{ item.entry }}</p>
            <p v-if="item.exit" class="wk-crit"><span class="wk-crit-lbl exit">exit</span>{{ item.exit }}</p>

            <div v-if="item.inputs.length || item.outputs.length" class="wk-io-block">
              <div v-for="(io, i) in item.inputs" :key="`in${i}`" class="wk-io">
                ⇥ <b>{{ io.name }}</b>
                <span v-if="io.counterparts.length" class="wk-io-src">from {{ io.counterparts.join(', ') }}</span>
                <span v-else class="wk-io-src none">no producer</span>
              </div>
              <div v-for="(io, i) in item.outputs" :key="`out${i}`" class="wk-io">
                ↦ <b>{{ io.name }}</b>
                <span v-if="io.counterparts.length" class="wk-io-src">to {{ io.counterparts.join(', ') }}</span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <p v-if="!items.length" class="wk-empty">
        Nothing lands on this unit yet — assign responsible parties on flow steps, or a division or
        branch on chart rows.
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The work lens — PORTING.md slice 5.
 *
 * "What does my unit own" is the question a RACI chart exists to answer and the one it is worst at,
 * because the answer is spread across 800 rows in one document and a dozen steps in another.
 *
 * The two groups are the whole point and must not be merged. DIRECT work was assigned to this unit
 * or to a team inside it — someone chose you. INHERITED work was assigned to a parent org with
 * nothing more specific named, so it lands on everyone underneath. A single list would be read as
 * the first and would be wrong about half of it.
 *
 * All of the walking is `collectWork` in core. Read-only by design: this is a lens over work that
 * is edited where it lives, and an edit box here would be a second place to change a row.
 */
import {
  ACTOR_LABELS_DEFAULT,
  ACTORS,
  COL_LABELS_DEFAULT,
  COL_SHORT_DEFAULT,
  collectWork,
  orgLabel,
  summarizeWork,
  type Actor,
  type OrgRef,
  type WorkRole,
} from '@raci/core';

const session = useWorkspaceSession();

// Camera state, not document state: which unit YOU are looking at is yours alone. Putting it in
// the shared document would mean one person's choice of unit yanking everyone else's screen.
const actor = ref<'' | Actor>('');
const divisionId = ref('');
const branchId = ref('');
const teamId = ref('');

// Clearing a level clears everything under it, or the picker would claim a branch inside a
// division you are no longer looking at.
watch(actor, () => { divisionId.value = ''; });
watch(divisionId, () => { branchId.value = ''; });
watch(branchId, () => { teamId.value = ''; });

const roster = computed(() => session.workspace.value.roster);

const directorates = computed(() =>
  ACTORS.filter((key) => roster.value[key]).map((key) => ({
    key,
    label: session.workspace.value.actorLabels[key] || ACTOR_LABELS_DEFAULT[key],
  })),
);
const divisions = computed(() => (actor.value ? roster.value[actor.value]?.divisions ?? [] : []));
const branches = computed(
  () => divisions.value.find((d) => d.id === divisionId.value)?.branches ?? [],
);
const teams = computed(() => branches.value.find((b) => b.id === branchId.value)?.teams ?? []);

const scope = computed<OrgRef | null>(() => {
  if (!actor.value) return null;
  if (!divisionId.value) return { actor: actor.value };
  if (!branchId.value) return { actor: actor.value, divisionId: divisionId.value };
  if (!teamId.value) {
    return { actor: actor.value, divisionId: divisionId.value, branchId: branchId.value };
  }
  return {
    actor: actor.value,
    divisionId: divisionId.value,
    branchId: branchId.value,
    teamId: teamId.value,
  };
});

const scopeLabel = computed(() => (scope.value ? orgLabel(session.workspace.value, scope.value) : null));
const items = computed(() => collectWork(session.workspace.value, scope.value));
const summary = computed(() => summarizeWork(items.value));
const letters = computed(() => Object.keys(summary.value.byLetter).sort());

const groups = computed(() => {
  const direct = items.value.filter((i) => i.relation === 'direct');
  const inherited = items.value.filter((i) => i.relation === 'inherited');
  const short = scopeLabel.value?.short ?? 'this unit';
  return [
    {
      key: 'direct',
      title: 'Assigned to your unit',
      hint: `Work assigned to ${short}, or to a team inside it.`,
      items: direct,
    },
    {
      key: 'inherited',
      title: 'From your org',
      hint: 'Assigned to a parent organization with no deeper unit named — it lands on everyone under it, including you.',
      items: inherited,
    },
  ].filter((g) => g.items.length > 0);
});

const shortLabel = (column: string) =>
  session.workspace.value.columnShort[column] ||
  COL_SHORT_DEFAULT[column as keyof typeof COL_SHORT_DEFAULT] ||
  column;

const columnLabel = (column: string) =>
  session.workspace.value.columnLabels[column] ||
  COL_LABELS_DEFAULT[column as keyof typeof COL_LABELS_DEFAULT] ||
  column;

const roleTitle = (role: WorkRole) => {
  const base = `${columnLabel(role.column)}${role.unit ? ` — ${role.unit}` : ''}`;
  return role.inherited ? `${base} (cascaded, not stated on this item)` : base;
};

const letterTitle = (letter: string) =>
  `${summary.value.byLetter[letter]} item(s) where this unit holds ${letter}`;
</script>

<style scoped>
.wk-head { display: flex; align-items: flex-start; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
.wk-head h2 { margin: 0 0 4px; font-size: 16px; }
.wk-head .meta { margin: 0; max-width: 62ch; font-size: 12px; color: var(--text-dim); }
.wk-picker { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.wk-picker select { font: inherit; font-size: 12px; background: var(--bg-2); color: inherit;
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; max-width: 190px; }
.wk-picker select:disabled { opacity: .45; }

.wk-choose, .wk-empty { color: var(--text-dim); font-size: 13px; }
.wk-scope { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 18px; }
.wk-tally { color: var(--text-dim); }
.wk-letter { color: var(--text-dim); border: 1px solid var(--border); border-radius: 10px;
  padding: 1px 8px; font-size: 11px; }
.wk-letter b { color: var(--text); font-weight: 600; }

.wk-group { margin-bottom: 26px; }
.wk-group h3 { margin: 0 0 2px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.wk-count { font-size: 11px; font-weight: 600; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 9px; padding: 0 7px; }
.wk-hint { margin: 0 0 10px; font-size: 11px; color: var(--text-dim); max-width: 70ch; }
.wk-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }

.wk-card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
.wk-card-head { display: flex; align-items: baseline; gap: 8px; }
.wk-name { font-weight: 600; }
.wk-unit { margin-left: auto; font-size: 11px; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 9px; padding: 0 7px; white-space: nowrap; }
.wk-meta { font-size: 11px; color: var(--text-dim); }
.wk-roles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.wk-role { font-size: 11px; font-weight: 600; letter-spacing: .5px;
  border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
.wk-role.inh { border-style: dashed; color: var(--text-dim); }
.wk-role-col { font-weight: 400; color: var(--text-dim); margin-right: 5px; letter-spacing: 0; }
.wk-desc { margin: 2px 0 0; font-size: 12px; color: var(--text-dim); }
.wk-crit { margin: 0; font-size: 11px; color: var(--text-dim); display: flex; gap: 6px; }
.wk-crit-lbl { text-transform: uppercase; letter-spacing: .04em; font-size: 9px;
  border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; align-self: flex-start;
  margin-top: 2px; }
.wk-crit-lbl.entry { color: #4dabf7; }
.wk-crit-lbl.exit { color: #51cf66; }
.wk-io-block { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 6px;
  display: flex; flex-direction: column; gap: 3px; }
.wk-io { font-size: 11px; }
.wk-io-src { color: var(--text-dim); margin-left: 4px; }
.wk-io-src.none { font-style: italic; opacity: .8; }
</style>
