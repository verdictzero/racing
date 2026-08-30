/**
 * The DirectorySource port.
 *
 * One interface, three adapters (LDAP/AD, Microsoft Graph, CSV). The app depends on this and
 * never on a directory product, which is what makes the same build run against a domain
 * controller on a closed network and against EntraID in Azure with nothing but config changing.
 *
 * WHAT A DIRECTORY IS AND IS NOT
 * A directory knows people, the units they belong to, and who manages whom. It does not know
 * anything about RACI. So the sync populates the ROSTER — directorate → division → branch → team →
 * people — and never touches a chart, a flow, or an assignment. Responsibility is authored here;
 * the org structure is authored over there. Keeping that line sharp is what makes a re-sync safe.
 *
 * THE HARD PART IS NOT READING, IT IS RECONCILING
 * Every assignment in every chart points at a roster id. If a sync minted fresh ids each run, the
 * second sync would orphan every assignment in the workspace — a silent, total data loss that
 * would look like the tool "forgetting" everything overnight. So each roster record carries the
 * `externalId` it came from, and reconciliation matches on that. Ids are stable across runs by
 * construction, not by luck. See `reconcile.ts`.
 */

import { z } from 'zod';

/** One person, as the source system has them. */
export const DirectoryPerson = z.object({
  /** Stable, opaque, and unique in the source: AD objectGUID, Entra id. NOT the email. */
  externalId: z.string().min(1),
  displayName: z.string().default(''),
  title: z.string().default(''),
  email: z.string().nullable().default(null),
  /** externalId of this person's manager, when the source exposes one. */
  managerExternalId: z.string().nullable().default(null),
  /** externalId of the unit they sit in. */
  unitExternalId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type DirectoryPerson = z.infer<typeof DirectoryPerson>;

/**
 * One organizational unit. The source's own tree, in the source's own terms — mapping it onto
 * the four ASIC tiers is a separate step, because different sources nest differently and the
 * mapping is a policy decision, not a fact about the directory.
 */
export const DirectoryUnit = z.object({
  externalId: z.string().min(1),
  name: z.string().default(''),
  /** externalId of the parent unit; null at the top of the source tree. */
  parentExternalId: z.string().nullable().default(null),
  /** externalId of the person who leads it, when the source says. */
  leadExternalId: z.string().nullable().default(null),
  /** Distinguished name / path, kept for diagnostics and for depth-based mapping rules. */
  path: z.string().default(''),
});
export type DirectoryUnit = z.infer<typeof DirectoryUnit>;

export const DirectorySnapshot = z.object({
  units: z.array(DirectoryUnit),
  people: z.array(DirectoryPerson),
  /** When the source was read. */
  fetchedAt: z.string(),
  /** Which adapter produced this, for the audit trail. */
  provider: z.string(),
});
export type DirectorySnapshot = z.infer<typeof DirectorySnapshot>;

/**
 * A directory, as far as this application is concerned.
 *
 * Deliberately one method. Incremental sync (AD's DirSync, Graph's delta queries) is a real
 * optimization, but it is an optimization: a full snapshot plus reconciliation is correct on its
 * own, and correctness first is the right order for something whose failure mode is silently
 * orphaning every assignment in the workspace. An adapter that supports delta can implement
 * `fetchDelta` later behind the same reconciliation.
 */
export interface DirectorySource {
  readonly name: string;
  /** Read the whole directory. */
  fetch(): Promise<DirectorySnapshot>;
  /** Cheap reachability check for the health endpoint and for validating config at boot. */
  probe?(): Promise<{ ok: boolean; detail: string }>;
}

export class DirectoryError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DirectoryError';
  }
}

/**
 * How a source tree maps onto the four fixed ASIC tiers.
 *
 * Needed because no directory knows what a "directorate" is. Two strategies cover what real
 * deployments have: match a unit by name/DN to a directorate key, or take the source's depth.
 * Anything more exotic belongs in a bespoke adapter rather than in more configuration.
 */
export const TierMapping = z.object({
  /**
   * Which source unit becomes which directorate. Keys are ACTOR keys; values match a unit's name
   * or path, case-insensitively.
   *   { ocio: 'OU=OCIO', cyber: 'Cyber and EW' }
   */
  directorates: z.record(z.string(), z.string()).default({}),
  /**
   * When a unit matches no directorate rule, fall back to depth below the base:
   * depth 0 → directorate, 1 → division, 2 → branch, 3 → team.
   */
  useDepthFallback: z.boolean().default(true),
  /** Units matching any of these (name or path, case-insensitive) are skipped entirely. */
  exclude: z.array(z.string()).default([]),
  /** Directorate that receives people whose unit maps nowhere. Null drops them, with a warning. */
  fallbackDirectorate: z.string().nullable().default(null),
});
export type TierMapping = z.infer<typeof TierMapping>;

export const DEFAULT_TIER_MAPPING: TierMapping = TierMapping.parse({});
