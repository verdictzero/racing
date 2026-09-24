/**
 * The Final lock's voice — index.html's refuseLockedEdit / guardChartEdit.
 *
 * A Final chart or flow is signed off, and every write to it is refused with a toast saying how to
 * reopen it. Throttled like the source's, so a drag across a locked chart says it once, not fifty
 * times.
 */
let lastToast = 0;

export function useLock() {
  const shell = useShell();

  function refuseLockedEdit(kind: 'chart' | 'flow', msg?: string): false {
    const now = Date.now();
    if (now - lastToast > 1200) {
      lastToast = now;
      shell.toast(msg || `This ${kind} is Final — click “↺ Reopen as draft” above to edit it.`, 'error');
    }
    return false;
  }
  /** True when the edit may go ahead; otherwise says why and returns false. */
  function guardEdit(kind: 'chart' | 'flow', subject: { status?: string } | null | undefined): boolean {
    return subject?.status === 'final' ? refuseLockedEdit(kind) : true;
  }
  return { refuseLockedEdit, guardEdit };
}
