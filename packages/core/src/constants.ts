/**
 * The vocabulary the whole system shares.
 *
 * These are lifted verbatim from the legacy single-file app (index.html, v0.39) rather than
 * re-derived, because their exact values are baked into every saved workspace file in the wild:
 * an actor key or a column key that changes spelling here silently orphans real data. Where a
 * value is a display label rather than a key, it is a DEFAULT — the workspace may override it,
 * and the override is what a source spreadsheet's own vocabulary lands in.
 */

// ---- Directorates (the roster's six top-level org units) --------------------------------------
// Keys are stable and meaningless to the user; the labels are what they see, and are overridable
// per workspace. Renaming a label must never touch a key.
export const ACTORS = ['ocio', 'mission', 'infra', 'cyber', 'sw', 'vendor'] as const;
export type Actor = (typeof ACTORS)[number];

export const ACTOR_LABELS_DEFAULT: Record<Actor, string> = {
  ocio: 'DIRECTORATE A',
  mission: 'DIRECTORATE B',
  infra: 'DIRECTORATE C',
  cyber: 'DIRECTORATE D',
  sw: 'DIRECTORATE E',
  vendor: 'DIRECTORATE F',
};

// ---- Responsibility columns (the chart's parties) ---------------------------------------------
export const COLS = ['hq', 'cos', 'mission', 'infra', 'cyber', 'sw', 'contacts'] as const;
export type ColKey = (typeof COLS)[number];

export const COL_LABELS_DEFAULT: Record<ColKey, string> = {
  hq: 'Director / HQ',
  cos: 'Chief of Staff',
  mission: 'Mission Mgmt Dir.',
  infra: 'Infrastructure Dir.',
  cyber: 'Cyber & EW Dir.',
  sw: 'Software & Support Dir. (HQ)',
  contacts: 'Contract Management Office',
};

export const COL_SHORT_DEFAULT: Record<ColKey, string> = {
  hq: 'HQ',
  cos: 'CoS',
  mission: 'MMD',
  infra: 'Infra',
  cyber: 'C&EW',
  sw: 'S&S',
  contacts: 'CMO',
};

// ---- Tiers -------------------------------------------------------------------------------------
// An organization chart is exactly four tiers deep. A free-form chart names its own levels and
// nests without limit, which is why depth checks go through chartMaxTier() rather than MAX_TIER.
export const TIER_LABELS = ['Portfolio', 'Program', 'Project', 'Task'] as const;
export const MAX_TIER = TIER_LABELS.length - 1;

// ---- Responsibility frameworks -----------------------------------------------------------------
// `owner` is the letter that must be unique per row (the accountable party). `doer` is the letter
// whose Primary column cascades down to become the next tier's owner.
export interface Framework {
  readonly key: string;
  readonly name: string;
  readonly blurb: string;
  readonly roles: readonly string[];
  readonly owner: string;
  readonly doer: string;
  readonly meta: Readonly<Record<string, { label: string; desc: string }>>;
}

export const FRAMEWORKS: Readonly<Record<string, Framework>> = {
  raci: {
    key: 'raci',
    name: 'RACI',
    blurb: 'Execution — who does the work, who owns the outcome.',
    roles: ['R', 'A', 'C', 'I'],
    owner: 'A',
    doer: 'R',
    meta: {
      R: { label: 'Responsible', desc: 'Does the work' },
      A: { label: 'Accountable', desc: 'Owns the outcome' },
      C: { label: 'Consulted', desc: 'Two-way input' },
      I: { label: 'Informed', desc: 'Kept in the loop' },
    },
  },
  rasci: {
    key: 'rasci',
    name: 'RASCI',
    blurb: 'RACI + Support — for deliverables many teams contribute to.',
    roles: ['R', 'A', 'S', 'C', 'I'],
    owner: 'A',
    doer: 'R',
    meta: {
      R: { label: 'Responsible', desc: 'Does the work' },
      A: { label: 'Accountable', desc: 'Owns the outcome' },
      S: { label: 'Support', desc: 'Assists the Responsible party' },
      C: { label: 'Consulted', desc: 'Two-way input' },
      I: { label: 'Informed', desc: 'Kept in the loop' },
    },
  },
};

export const CHART_FRAMEWORKS = ['raci', 'rasci'] as const;
/** Flows are RACI, full stop (v0.34). A file naming anything else loads as RACI. */
export const FLOW_FRAMEWORKS = ['raci'] as const;

/**
 * Every letter any framework can use, in canonical display order. Normalization keeps only these
 * and orders by this list, so switching a chart's framework never silently drops a cell's letters
 * — an RASCI chart turned RACI keeps its S until someone removes it deliberately.
 */
export const ALL_ROLE_LETTERS = ['R', 'D', 'A', 'S', 'P', 'C', 'I'] as const;

export function framework(key: string | undefined | null): Framework {
  return (key && FRAMEWORKS[key]) || FRAMEWORKS.raci!;
}

// ---- Registries ---------------------------------------------------------------------------------
export const ARTIFACT_TYPES = [
  'document',
  'data',
  'decision',
  'approval',
  'briefing',
  'other',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ENTITY_KINDS = [
  'board',
  'committee',
  'team',
  'vendor',
  'agency',
  'office',
  'other',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

// ---- Lifecycle -----------------------------------------------------------------------------------
export const STATUSES = ['draft', 'final'] as const;
export type Status = (typeof STATUSES)[number];

export const META_PRIORITIES = ['', 'low', 'medium', 'high', 'critical'] as const;

// ---- Flow modes ------------------------------------------------------------------------------------
/** `linked` — every step names the chart row it implements. `free` — RACI authored on the step. */
export const FLOW_MODES = ['free', 'linked'] as const;
export type FlowMode = (typeof FLOW_MODES)[number];
