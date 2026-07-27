// Trade dots — a lightweight-charts series primitive that draws a small dot at
// the EXACT fill price, nudged just to the right of the candle so it never
// hides behind the bar (the built-in marker plugin can only anchor above/below/
// inside a bar, centered on it). Used as the default trade-marker style; the
// classic arrows remain available behind a toggle.
//
// A dot: { time, price, r, color, ring?, label?, labelColor? }
//   time  — candle bucket time (seconds, must exist in the series data)
//   price — exact y anchor (avg fill price of the bucket)
//   r     — radius in px
//   ring  — outline color (white ring = your own trades)
//   label — optional text drawn to the right of the dot

const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Ubuntu, sans-serif"

class TradeDotsPaneRenderer {
  constructor(points) {
    this._points = points
  }

  draw(target) {
    const pts = this._points
    if (!pts.length) return
    target.useBitmapCoordinateSpace(
      ({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        ctx.save()
        for (const p of pts) {
          const x = p.x * hr
          const y = p.y * vr
          const r = p.r * hr
          ctx.beginPath()
          ctx.arc(x, y, r, 0, Math.PI * 2)
          ctx.fillStyle = p.color
          ctx.fill()
          // Outline for contrast against candle bodies of the same hue.
          ctx.lineWidth = Math.max(1, (p.ring ? 1.5 : 1) * hr)
          ctx.strokeStyle = p.ring || 'rgba(8, 12, 14, 0.9)'
          ctx.stroke()
          if (p.label) {
            const tx = x + r + 5 * hr
            ctx.font = `${Math.round(10 * hr)}px ${FONT_FAMILY}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            // Dark halo so the text stays readable over candles.
            ctx.lineWidth = 3 * hr
            ctx.strokeStyle = 'rgba(8, 12, 14, 0.85)'
            ctx.strokeText(p.label, tx, y)
            ctx.fillStyle = p.labelColor || p.color
            ctx.fillText(p.label, tx, y)
          }
        }
        ctx.restore()
      },
    )
  }
}

class TradeDotsPaneView {
  constructor(source) {
    this._source = source
    this._points = []
  }

  update() {
    const src = this._source
    this._points = []
    if (!src._chart || !src._series) return
    const ts = src._chart.timeScale()
    const spacing = ts.options().barSpacing || 6
    for (const d of src._dots) {
      const x = ts.timeToCoordinate(d.time)
      const y = src._series.priceToCoordinate(d.price)
      if (x == null || y == null) continue
      // Sit just past the candle's slot: half the bar spacing clears the bar
      // itself, plus the dot's own radius so its left edge starts at the gap.
      const offset = Math.max(spacing * 0.5, 2) + d.r + 1
      this._points.push({ ...d, x: x + offset, y })
    }
  }

  renderer() {
    return new TradeDotsPaneRenderer(this._points)
  }
}

export class TradeDotsPrimitive {
  constructor() {
    this._chart = null
    this._series = null
    this._requestUpdate = null
    this._dots = []
    this._paneViews = [new TradeDotsPaneView(this)]
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._requestUpdate = requestUpdate
  }

  detached() {
    this._chart = null
    this._series = null
    this._requestUpdate = null
  }

  setDots(dots) {
    this._dots = dots
    this._requestUpdate?.()
  }

  updateAllViews() {
    this._paneViews.forEach((v) => v.update())
  }

  paneViews() {
    return this._paneViews
  }

  // Dots anchor to fill prices inside the candle range, so they shouldn't
  // influence the price axis' auto-scale.
  autoscaleInfo() {
    return null
  }
}
