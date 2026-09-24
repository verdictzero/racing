/**
 * The chart screen's camera — state that belongs to ONE person's screen, never to the document.
 *
 * Which row you have selected, whether your Legend is open, whether you have dragged a pane out of
 * the cascade: all facts about your view. Putting any of them in the shared document would move
 * every collaborator's screen when you click. index.html keeps the same things in its local state
 * (activeNodeId, showLegend, chartPos) for the same reason — it just had only one viewer.
 *
 * Shared between the shell (which owns the Details and Legend panels, the Auto Arrange button and
 * the floating arrange button) and the chart screen (which owns the rows and the panes).
 */

const LEGEND_KEY = 'raci-matrix-show-legend-v1';

export function useChartView() {
  /** The row whose details the Details panel shows. index.html's `_activeNodeId`. */
  const activeNodeId = useState<string | null>('raci:activeNodeId', () => null);
  /** body.show-details — the Details panel. Not persisted, as in index.html. */
  const showDetails = useState<boolean>('raci:showDetails', () => false);
  /** body.show-legend — persisted per browser, as index.html persists `state.showLegend`. */
  const showLegend = useState<boolean>('raci:showLegend', () => false);
  /** True while any pane has been dragged out of the cascade; shows the floating Auto Arrange.
   *  Synced where index.html calls syncArrangeFab — a render, the end of a drag, a snap back, an
   *  arrange — so the button appears when you let go of a pane, not while you drag it. */
  const panesMoved = useState<boolean>('raci:panesMoved', () => false);
  /** #arrange-fab.attention — the three breaths it takes when it first appears. */
  const fabAttention = useState<boolean>('raci:fabAttention', () => false);
  /** Bumped by Auto Arrange (rail button or floating one); the chart screen watches it. */
  const arrangeTick = useState<number>('raci:arrangeTick', () => 0);

  function setLegend(on: boolean): void {
    showLegend.value = on;
    try { localStorage.setItem(LEGEND_KEY, on ? '1' : '0'); } catch { /* storage blocked: session only */ }
  }
  function restoreLegend(): void {
    try { showLegend.value = localStorage.getItem(LEGEND_KEY) === '1'; } catch { /* default off */ }
  }
  /** index.html's openDetailsPanel / closeDetailsPanel. Closing clears the selection. */
  function openDetails(): void { showDetails.value = true; }
  function closeDetails(): void { showDetails.value = false; activeNodeId.value = null; }
  function selectNode(id: string | null): void { activeNodeId.value = id; }
  function arrange(): void { arrangeTick.value++; }
  /** index.html's syncArrangeFab. */
  function syncArrangeFab(moved: boolean): void {
    panesMoved.value = moved;
    if (!moved) fabAttention.value = false;
  }
  /** index.html's breatheArrangeFab: drop the class, reflow, add it back so the animation restarts. */
  function breatheArrangeFab(): void {
    fabAttention.value = false;
    nextTick(() => {
      void document.getElementById('arrange-fab')?.offsetWidth;
      fabAttention.value = true;
    });
  }

  return {
    activeNodeId, showDetails, showLegend, panesMoved, fabAttention, arrangeTick,
    setLegend, restoreLegend, openDetails, closeDetails, selectNode, arrange, syncArrangeFab, breatheArrangeFab,
  };
}
