/**
 * Where YOU are in a chart, remembered per chart and per browser: the drill path, panes dragged out
 * of the cascade, the zoom, the resized width/height.
 *
 * index.html keeps exactly these on each chart in its state (drillPath, chartPos, chartZoom,
 * chartSize), so switching tabs or reloading puts you back where you were. Here the chart is shared
 * and these are not — one person drilling must not move anyone else's panes — so they live in
 * localStorage, keyed by workspace and chart.
 */

export interface PanePos { x: number; y: number }
export interface ChartCameraState {
  drillPath: string[];
  pos: Record<string, PanePos>;
  zoom: number;
  size: { w: number; h: number } | null;
}

const PREFIX = 'raci-chart-camera-v1:';
const ZOOM_MIN = 0.4, ZOOM_MAX = 2.5;

function blank(): ChartCameraState {
  return { drillPath: [], pos: {}, zoom: 1, size: null };
}

export function useChartCamera(workspaceId: string, chartId: Ref<string | null>) {
  const cams = useState<Record<string, ChartCameraState>>('raci:chartCameras', () => ({}));

  function load(id: string): ChartCameraState {
    if (cams.value[id]) return cams.value[id]!;
    let found = blank();
    if (import.meta.client) {
      try {
        const raw = localStorage.getItem(PREFIX + workspaceId + ':' + id);
        if (raw) found = { ...blank(), ...JSON.parse(raw) as Partial<ChartCameraState> };
      } catch { /* a corrupt or blocked entry is a fresh camera, never an error */ }
    }
    cams.value = { ...cams.value, [id]: found };
    return found;
  }

  const cam = computed<ChartCameraState>(() => (chartId.value ? load(chartId.value) : blank()));

  function update(patch: Partial<ChartCameraState>): void {
    const id = chartId.value;
    if (!id) return;
    const next = { ...load(id), ...patch };
    cams.value = { ...cams.value, [id]: next };
    try { localStorage.setItem(PREFIX + workspaceId + ':' + id, JSON.stringify(next)); } catch { /* session only */ }
  }

  function setZoom(z: number): void {
    update({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100)) });
  }

  return { cam, update, setZoom };
}
