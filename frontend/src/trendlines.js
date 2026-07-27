// Hand-drawn trendlines, persisted per chart key in localStorage.
// Keys are coin ids ("SOL", "xyz:SP500") or special charts ("__MCAP__").

const TREND_KEY = 'hypervault.trendlines'

export function loadTrendStore() {
  try {
    const obj = JSON.parse(localStorage.getItem(TREND_KEY) || '{}')
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

export function saveTrendStore(store) {
  try {
    localStorage.setItem(TREND_KEY, JSON.stringify(store))
  } catch {
    /* ignore storage errors */
  }
}

// A stored line is a plain segment between its two anchors — it ends exactly
// where you placed the second point. The anchor can sit in the future (the
// chart reserves empty bars to the right), so the line follows your mouse out
// past the last candle. (`step` kept for call-site compatibility.)
export function rayPoints(ln, _step) {
  return [
    { time: ln.t1, value: ln.p1 },
    { time: ln.t2, value: ln.p2 },
  ]
}

export const TREND_OPTS = {
  color: '#ffce5c', // amber, matches the theme
  lineWidth: 2,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
  // Keep trendlines OUT of the price axis' auto-scale. Without this, a steep
  // line's anchors are counted when the axis re-fits (e.g. the moment a drawing
  // completes and auto-scale is re-enabled), so the whole chart suddenly
  // rescales to fit the line — candles squash into a sliver mid-screen.
  autoscaleInfoProvider: () => null,
}
