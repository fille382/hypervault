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

// Run a trendline series mutation (setData / add / remove) without letting the
// chart scroll. A line anchored past the last candle raises the time scale's
// "base index" (the last bar with real data). lightweight-charts compensates
// the right offset when that index grows, but NOT when it shrinks back — so a
// preview line following the cursor into the future room and then back over
// the candles (e.g. out to the price axis and back) jumps the whole chart left
// by a few bars. Snapshot the visible range and restore it if the mutation
// moved it. Callers freeze user scrolling while drawing, so the snapshot can't
// race a pan.
export function keepView(chart, fn) {
  const ts = chart.timeScale()
  const before = ts.getVisibleLogicalRange()
  fn()
  if (!before) return
  const after = ts.getVisibleLogicalRange()
  if (!after || after.from !== before.from || after.to !== before.to) ts.setVisibleLogicalRange(before)
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
