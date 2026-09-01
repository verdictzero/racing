/**
 * The drill-crumb band.
 *
 * The band is a full-width strip above both rails, so the shell renders it — but only the chart
 * screen knows the drill path, so that screen fills it in. This is the seam between them, kept in
 * one file so neither side has to know the other's shape.
 *
 * Camera state, not document state: where you have drilled to is yours, and pushing it into the
 * shared document would drag every other viewer's screen around with your clicks.
 */

export interface Crumb {
  readonly id: string;
  /** 0-based depth. Drives the capsule's colour through `.crumb.t0`…`.t3`. */
  readonly tier: number;
  /** The tier's own name — "Programs", "Projects" — shown above the row's name. */
  readonly tierName: string;
  readonly name: string;
}

export interface CrumbChannel {
  readonly crumbs: Ref<Crumb[]>;
  /** Called with the index of the crumb clicked. The chart screen decides what that means. */
  readonly crumbNav: Ref<(index: number) => void>;
}

export const CRUMB_KEY = 'raci:crumbs';

/**
 * Used by a screen that wants to publish crumbs.
 *
 * Returns null outside a workspace route rather than throwing: a screen that can render without a
 * crumb band should not fail because it is mounted somewhere that has none.
 */
export function useCrumbChannel(): CrumbChannel | null {
  return inject<CrumbChannel | null>(CRUMB_KEY, null);
}
