import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createChart, AreaSeries, LineSeries } from 'lightweight-charts'
import { getMcapHistory } from '../api.js'
import { loadTrendStore, saveTrendStore, rayPoints, TREND_OPTS } from '../trendlines.js'

const MCAP_KEY = '__MCAP__' // trendline-store key for this chart
const RANGES = [
  { label: '90D', value: '90' },
  { label: '1Y', value: '365' },
  { label: 'Max', value: 'max' },
]

const fmtCap = (v) => {
  if (v == null || Number.isNaN(v)) return ''
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(0)}B`
  return `$${(v / 1e6).toFixed(0)}M`
}

// Fullscreen total-crypto-market-cap chart with the same trendline tools as
// the coin chart (draw, per-line delete, persistence).
export default function McapChart({ onClose }) {
  const bodyRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const timesRef = useRef([])
  const trendSeriesRef = useRef([])
  const draftRef = useRef(null)
  const [range, setRange] = useState('365')
  const [drawMode, setDrawMode] = useState(false)
  const [trendVersion, setTrendVersion] = useState(0)
  const [hasLines, setHasLines] = useState(false)
  const [trashAt, setTrashAt] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const [dataTick, setDataTick] = useState(0)

  // Daily series — rays' future legs are filled at one point per day.
  const dataStep = () => {
    const times = timesRef.current
    return times.length >= 2 ? times[times.length - 1] - times[times.length - 2] : 86_400
  }

  // Create the chart once.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return undefined
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8a9aa0', fontSize: 11 },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      timeScale: { borderColor: '#1a2a2d', timeVisible: false },
      rightPriceScale: { borderColor: '#1a2a2d' },
      crosshair: { mode: 1 },
      localization: { priceFormatter: fmtCap },
    })
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#34e2a8',
      topColor: 'rgba(52, 226, 168, 0.25)',
      bottomColor: 'rgba(52, 226, 168, 0)',
      lineWidth: 2,
      priceLineVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      trendSeriesRef.current = []
      draftRef.current = null
    }
  }, [])

  // Load history for the selected range.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    getMcapHistory(range)
      .then((d) => {
        if (cancelled || !seriesRef.current) return
        const points = d.points || []
        seriesRef.current.setData(points)
        timesRef.current = points.map((p) => p.time)
        setDataTick((t) => t + 1)
        chartRef.current?.timeScale().fitContent()
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  // Mount saved trendlines — each rendered as a +10y ray past its anchor.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    trendSeriesRef.current.forEach((item) => {
      try {
        chart.removeSeries(item.series)
      } catch {
        /* already gone */
      }
    })
    trendSeriesRef.current = []
    const lines = loadTrendStore()[MCAP_KEY] || []
    const step = dataStep()
    for (const ln of lines) {
      const s = chart.addSeries(LineSeries, TREND_OPTS)
      s.setData(rayPoints(ln, step))
      trendSeriesRef.current.push({ series: s, ln })
    }
    setHasLines(lines.length > 0)
  }, [trendVersion, dataTick])

  // Trendline drawing — two clicks, live preview, future extrapolation.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !drawMode) return undefined

    const pointAt = (param) => {
      if (!param?.point) return null
      const price = series.coordinateToPrice(param.point.y)
      if (price == null) return null
      if (param.time != null) return { time: param.time, value: price }
      const times = timesRef.current
      if (times.length < 2) return null
      let logical = param.logical
      if (logical == null) logical = chart.timeScale().coordinateToLogical(param.point.x)
      if (logical == null) return null
      const lastIdx = times.length - 1
      const step = times[lastIdx] - times[lastIdx - 1]
      const offset = Math.round(logical) - lastIdx
      if (offset <= 0) return null
      return { time: times[lastIdx] + offset * step, value: price }
    }

    const onClick = (param) => {
      const pt = pointAt(param)
      if (!pt) return
      if (!draftRef.current) {
        const s = chart.addSeries(LineSeries, TREND_OPTS)
        s.setData([pt])
        draftRef.current = { t1: pt.time, p1: pt.value, series: s, raf: null, pending: null }
        return
      }
      const d = draftRef.current
      if (pt.time === d.t1) return
      if (d.raf) cancelAnimationFrame(d.raf)
      const pts = [{ time: d.t1, value: d.p1 }, pt].sort((x, y) => x.time - y.time)
      const ln = { t1: pts[0].time, p1: pts[0].value, t2: pts[1].time, p2: pts[1].value }
      d.series.setData(rayPoints(ln, dataStep()))
      trendSeriesRef.current.push({ series: d.series, ln })
      draftRef.current = null
      const store = loadTrendStore()
      store[MCAP_KEY] = [...(store[MCAP_KEY] || []), ln]
      saveTrendStore(store)
      setHasLines(true)
      setDrawMode(false)
    }

    const onMove = (param) => {
      const d = draftRef.current
      if (!d) return
      const pt = pointAt(param)
      if (!pt || pt.time === d.t1) return
      d.pending = pt
      if (d.raf) return
      d.raf = requestAnimationFrame(() => {
        const cur = draftRef.current
        if (!cur || !cur.pending) return
        cur.raf = null
        const p = cur.pending
        if (cur.lastT === p.time && cur.lastV === p.value) return
        cur.lastT = p.time
        cur.lastV = p.value
        cur.series.setData([{ time: cur.t1, value: cur.p1 }, p].sort((x, y) => x.time - y.time))
      })
    }

    chart.subscribeClick(onClick)
    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeClick(onClick)
      chart.unsubscribeCrosshairMove(onMove)
      const d = draftRef.current
      if (d) {
        if (d.raf) cancelAnimationFrame(d.raf)
        try {
          chart.removeSeries(d.series)
        } catch {
          /* chart torn down */
        }
        draftRef.current = null
      }
    }
  }, [drawMode])

  // Hover near a line's left anchor -> floating delete button.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || drawMode) {
      setTrashAt(null)
      return undefined
    }
    const onMove = (param) => {
      if (!param?.point) return
      const lines = loadTrendStore()[MCAP_KEY] || []
      const ts = chart.timeScale()
      let best = null
      lines.forEach((ln, index) => {
        const x = ts.timeToCoordinate(ln.t1)
        const y = series.priceToCoordinate(ln.p1)
        if (x == null || y == null) return
        const dx = param.point.x - x
        const dy = param.point.y - y
        const d2 = dx * dx + dy * dy
        if (d2 <= 16 * 16 && (!best || d2 < best.d2)) best = { x, y, index, d2 }
      })
      setTrashAt((prev) => {
        if (!best) return prev ? null : prev
        if (prev && prev.index === best.index && prev.x === best.x && prev.y === best.y) return prev
        return { x: best.x, y: best.y, index: best.index }
      })
    }
    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
    }
  }, [drawMode, trendVersion])

  // Esc: cancel drawing first, then close the modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (drawMode) setDrawMode(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawMode, onClose])

  const deleteTrendline = (index) => {
    const store = loadTrendStore()
    const lines = store[MCAP_KEY] || []
    lines.splice(index, 1)
    if (lines.length) store[MCAP_KEY] = lines
    else delete store[MCAP_KEY]
    saveTrendStore(store)
    setTrendVersion((v) => v + 1)
    setTrashAt(null)
  }

  const clearTrendlines = () => {
    const store = loadTrendStore()
    delete store[MCAP_KEY]
    saveTrendStore(store)
    setTrendVersion((v) => v + 1)
    setTrashAt(null)
  }

  // Portal to <body>: the top bar's backdrop-filter would otherwise trap this
  // fixed-position overlay inside the bar.
  return createPortal(
    <div className="mcap-modal">
      <div className="chart-head">
        <div className="chart-title">
          <span className="ct-coin">Total crypto market cap</span>
          <span className="ct-sub">· CoinGecko · top-coin sum scaled to global total</span>
        </div>
        <div className="chart-intervals">
          {RANGES.map((r) => (
            <button
              key={r.value}
              className={`iv ${range === r.value ? 'active' : ''}`}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
          <span className="tool-sep" />
          <button
            className={`iv ${drawMode ? 'active' : ''}`}
            title="Draw a trendline: click two points (Esc cancels)"
            onClick={() => setDrawMode((o) => !o)}
          >
            ✏ Line
          </button>
          {hasLines && (
            <button className="iv" title="Remove all trendlines" onClick={clearTrendlines}>
              ✕ Lines
            </button>
          )}
          <button className="iv" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>
      <div className="chart-wrap mcap-body">
        <div className="chart-body" style={{ height: '100%' }} ref={bodyRef} />
        {loading && <div className="chart-status">loading…</div>}
        {err && <div className="chart-status err">chart error: {err}</div>}
        {trashAt && !drawMode && (
          <button
            className="trend-trash"
            style={{ left: trashAt.x, top: trashAt.y }}
            title="Delete this trendline"
            onClick={() => deleteTrendline(trashAt.index)}
          >
            🗑
          </button>
        )}
        {drawMode && (
          <div className="draw-hint">
            {draftRef.current ? 'click the second point' : 'click two points to draw a trendline'}{' '}
            · Esc cancels
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
