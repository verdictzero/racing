/**
 * What a screen can ask of the workspace shell.
 *
 * index.html keeps a handful of pieces of chrome OUTSIDE #ws-main — the toast tray, the Details
 * overlay, the warnings pill — and any screen's code can reach them because everything is one
 * script. Here the shell owns them and screens reach them through this seam, so no screen has to
 * know how the shell is built, and the shell never has to import a screen.
 */

export const SHELL_KEY = 'raci:shell';

export type ToastType = 'suggest' | 'error';

export interface ShellBridge {
  /**
   * Open the Details overlay (index.html's `#meta-overlay`): description, customer, priority,
   * budget and tags for the active chart, or for a flow when `kind` is 'flow'.
   */
  openMeta(kind: 'chart' | 'flow', id?: string): void;
  /**
   * index.html's `showToast`. 'suggest' (💡, the default) stays up 5.2s; 'error' (⛔) 3.2s — an
   * error is a refusal the person already caused, a suggestion is something they may not have seen.
   */
  toast(message: string, type?: ToastType): void;
}

const NOOP: ShellBridge = { openMeta: () => {}, toast: () => {} };

/**
 * The shell's bridge. Falls back to a no-op outside a workspace route, so a screen mounted somewhere
 * without the shell renders rather than throws.
 */
export function useShell(): ShellBridge {
  return inject<ShellBridge>(SHELL_KEY, NOOP);
}

/**
 * Which flow is open on the flow screen. Shared state rather than a screen-local ref because the
 * shell needs it too: in the flow view the warnings pill lints the open flow, exactly as
 * index.html's recomputeViolations lints `abc()`.
 */
export function useActiveFlowId(): Ref<string | null> {
  return useState<string | null>('raci:activeFlowId', () => null);
}

/** Which chart tab is open. Owned by the shell, read by every screen that is chart-scoped. */
export function useActiveChartId(): Ref<string | null> {
  return useState<string | null>('raci:activeChartId', () => null);
}
