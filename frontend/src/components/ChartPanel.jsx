import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  TickMarkType,
} from 'lightweight-charts'
import { getCandles } from '../api.js'
import {
  fmtNum,
  fmtUsd,
  fmtPrice,
  fmtSignedUsd,
  shortAddr,
  coinLabel,
  tradingViewUrl,
} from '../format.js'
import CoinIcon from './CoinIcon.jsx'
import { loadTrendStore, saveTrendStore, rayPoints, TREND_OPTS } from '../trendlines.js'

const TIMEFRAMES = [
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1D', value: '1d' },
  { label: '3D', value: '3d' },
  { label: '1W', value: '1w' },
  { label: '1M', value: '1M' },
]

// How many candles to LOAD per timeframe (deep history you can scroll back to).
// Hyperliquid serves up to ~5000 bars/request; the default view only shows the
// most recent DEFAULT_VISIBLE bars (below) so loading a lot doesn't zoom out.
const BARS = {
  '5m': 1200, '15m': 1500, '1h': 2000, '4h': 2000, '1d': 2000, '3d': 1500, '1w': 1000, '1M': 240,
}

// Bars shown by default; the rest sit off-screen to the left until you scroll.
const DEFAULT_VISIBLE = 150
// Empty bars reserved to the RIGHT of the last candle, so the chart can scroll
// into the future and trendlines can be drawn out past today (the cursor lands
// on a real time slot). Whitespace = no candle drawn, just a reserved slot.
const FUTURE_ROOM = 300
function withFutureRoom(candles) {
  if (!candles.length) return candles
  const last = candles[candles.length - 1].time
  const step =
    candles.length >= 2 ? last - candles[candles.length - 2].time : 86_400
  const out = candles.slice()
  for (let k = 1; k <= FUTURE_ROOM; k++) out.push({ time: last + k * step })
  return out
}
// Lazy history: when the left edge gets within this many bars, fetch an older
// chunk and prepend it (paginating backwards via `before`).
const HISTORY_CHUNK = 500
const LOAD_MORE_THRESHOLD = 12


// How many trade markers to show per timeframe, and how to pick them:
// zoomed in -> the latest trades; zoomed out -> the biggest by USD value.
const MARKER_BUDGET = {
  '5m': { count: 40, by: 'time' },
  '15m': { count: 30, by: 'time' },
  '1h': { count: 25, by: 'time' },
  '4h': { count: 18, by: 'notional' },
  '1d': { count: 12, by: 'notional' },
  '3d': { count: 10, by: 'notional' },
  '1w': { count: 8, by: 'notional' },
  '1M': { count: 6, by: 'notional' },
}

// How many of YOUR own trades to mark on the chart (most recent on the coin).
const MY_MARKER_BUDGET = 60
// Colours for YOUR trade markers — vivid green up (long / profit) and coral
// down (short / loss), a touch brighter than the candles so they read clearly.
const MY_COLORS = { up: '#22e07a', down: '#ff4d6d' }

// Distinct entry-line colors for the other saved vaults (cycled by index).
const PEER_COLORS = ['#5aa9ff', '#c084fc', '#fbbf24', '#2dd4bf', '#f472b6', '#a3e635']

const peerLabel = (p) => p.vaultName || shortAddr(p.vaultAddress)

// Map a fill timestamp (ms) to the candle bucket it belongs to: the greatest
// candle time <= the fill time (binary search; candle times are ascending).
function snapToCandle(times, fillSec) {
  let lo = 0
  let hi = times.length - 1
  if (!times.length || fillSec < times[0]) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= fillSec) lo = mid
    else hi = mid - 1
  }
  return times[lo]
}

// lightweight-charts renders the time axis in UTC by default. We format both
// the axis ticks and the crosshair label in the viewer's LOCAL timezone so the
// chart lines up with the activity feed and the wall clock. Candle/marker data
// stays in real UTC seconds, so trade markers still snap to the right candle.
const localTickFormatter = (time, tickMarkType, locale) => {
  const d = new Date(time * 1000)
  switch (tickMarkType) {
    case TickMarkType.Year:
      return d.toLocaleDateString(locale, { year: 'numeric' })
    case TickMarkType.Month:
      return d.toLocaleDateString(locale, { month: 'short', year: 'numeric' })
    case TickMarkType.DayOfMonth:
      return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    case TickMarkType.Time:
      return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    default:
      return d.toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
  }
}
const localTimeFormatter = (time) =>
  new Date(time * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// TradingView-style candlestick chart fed by Hyperliquid's own candle data.
export default function ChartPanel({
  coin,
  position,
  myPosition,
  peers = [],
  fills = [],
  myFills = [],
  onTimeframe,
  onSelectVault,
}) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const linesRef = useRef([])
  const peerLinesRef = useRef([])
  const myLinesRef = useRef([])
  const markersRef = useRef(null)
  const candleTimesRef = useRef([])
  const [timeframe, setTimeframe] = useState('3d')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [candleTick, setCandleTick] = useState(0) // bumps when new candles land
  const [hiddenVaults, setHiddenVaults] = useState(() => new Set()) // addr(lower) with markers off
  const [fullscreen, setFullscreen] = useState(false)
  const [showMyTrades, setShowMyTrades] = useState(true) // your own trade markers
  const hasMyTrades = useMemo(() => myFills.some((f) => f.coin === coin), [myFills, coin])
  // Tell the app the timeframe so it can scale its live-data poll cadence.
  useEffect(() => onTimeframe?.(timeframe), [timeframe, onTimeframe])
  const [drawMode, setDrawMode] = useState(false)
  const [measureMode, setMeasureMode] = useState(false) // drag to measure % change
  const [measureBox, setMeasureBox] = useState(null) // {x1,y1,x2,y2,pct,diff,up} in px
  const [trendVersion, setTrendVersion] = useState(0) // bumps when lines change
  const [hasTrendlines, setHasTrendlines] = useState(false)
  const [trashAt, setTrashAt] = useState(null) // {x, y, index} near a line's left anchor
  const trendSeriesRef = useRef([]) // [{ series, ln }] for the current coin
  const draftRef = useRef(null) // { t1, p1, series } while drawing
  // Lazy history loading (scroll to the left edge to fetch older candles).
  const candlesRef = useRef([]) // the full loaded candle array, oldest-first
  const loadingMoreRef = useRef(false) // guard against overlapping history fetches
  const noMoreHistoryRef = useRef(false) // Hyperliquid has nothing older
  const loadMoreRef = useRef(null) // current loadMoreHistory fn (fresh per coin/timeframe)
  const [loadingMore, setLoadingMore] = useState(false)

  // The chart's bar interval in seconds — used to fill the rays' future leg.
  const candleStep = () => {
    const times = candleTimesRef.current
    return times.length >= 2 ? times[times.length - 1] - times[times.length - 2] : 86_400
  }

  // Vaults that traded the charted coin recently — drives the marker toggles.
  const fillVaults = useMemo(() => {
    const seen = new Map()
    for (const f of fills) {
      if (f.coin !== coin) continue
      const key = f.address.toLowerCase()
      if (!seen.has(key)) seen.set(key, { address: key, name: f.vault || shortAddr(f.address) })
    }
    return [...seen.values()]
  }, [fills, coin])

  const toggleVaultMarkers = (addr) => {
    setHiddenVaults((prev) => {
      const next = new Set(prev)
      if (next.has(addr)) next.delete(addr)
      else next.add(addr)
      return next
    })
  }

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8a9aa0',
        fontSize: 11,
        attributionLogo: false, // replaced by our own coin-specific TradingView link
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: {
        borderColor: '#1a2a2d',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6, // breathing room so the latest bars/markers aren't jammed at the edge
        tickMarkFormatter: localTickFormatter,
      },
      rightPriceScale: { borderColor: '#1a2a2d' },
      crosshair: { mode: 1 },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#34e2a8',
      downColor: '#ff5d73',
      wickUpColor: '#34e2a8',
      wickDownColor: '#ff5d73',
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    markersRef.current = createSeriesMarkers(series, [])
    // Lazy-load older history once the user scrolls near the left edge.
    const onRange = (range) => {
      if (range && range.from < LOAD_MORE_THRESHOLD) loadMoreRef.current?.()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
      linesRef.current = []
      peerLinesRef.current = []
      myLinesRef.current = []
      candleTimesRef.current = []
    }
  }, [])

  // Load candles whenever the coin or timeframe changes.
  useEffect(() => {
    if (!coin || !seriesRef.current) return undefined
    let cancelled = false
    setLoading(true)
    setErr(null)
    noMoreHistoryRef.current = false
    loadingMoreRef.current = false
    getCandles(coin, timeframe, BARS[timeframe] || 300)
      .then((data) => {
        if (cancelled || !seriesRef.current) return
        const candles = data.candles || []
        candlesRef.current = candles
        seriesRef.current.setData(withFutureRoom(candles))
        candleTimesRef.current = candles.map((c) => c.time)
        setCandleTick((t) => t + 1)
        // Default to the most recent DEFAULT_VISIBLE bars (with a little right
        // margin) rather than fitting all of history — the rest is loaded and
        // sits off-screen to the left, so you can scroll back for more.
        if (candles.length) {
          const from = Math.max(0, candles.length - DEFAULT_VISIBLE)
          chartRef.current?.timeScale().setVisibleLogicalRange({ from, to: candles.length + 6 })
        }
        // Re-enable price auto-scaling. Dragging/double-clicking the price axis
        // turns it off, and that would otherwise persist across coin switches —
        // leaving the chart stuck on the previous coin's price range.
        chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // Fetch an older chunk (ending at the current oldest bar) and prepend it,
    // keeping the same bars in view so the chart doesn't jump.
    const loadMoreHistory = async () => {
      if (loadingMoreRef.current || noMoreHistoryRef.current) return
      const existing = candlesRef.current
      if (!existing.length) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      try {
        const before = existing[0].time * 1000
        const data = await getCandles(coin, timeframe, HISTORY_CHUNK, before)
        if (cancelled || !seriesRef.current) return
        const older = data.candles || []
        const byTime = new Map()
        for (const c of older) byTime.set(c.time, c)
        for (const c of existing) byTime.set(c.time, c) // existing wins at the overlap bar
        const merged = [...byTime.values()].sort((a, b) => a.time - b.time)
        const added = merged.length - existing.length
        if (added <= 0) {
          noMoreHistoryRef.current = true // reached the start of available history
          return
        }
        const ts = chartRef.current?.timeScale()
        const view = ts?.getVisibleLogicalRange()
        candlesRef.current = merged
        seriesRef.current.setData(withFutureRoom(merged))
        candleTimesRef.current = merged.map((c) => c.time)
        setCandleTick((t) => t + 1)
        // Shift the view right by the number of prepended bars so it stays put.
        if (ts && view) ts.setVisibleLogicalRange({ from: view.from + added, to: view.to + added })
      } catch {
        /* upstream hiccup — leave history as-is, try again on the next scroll */
      } finally {
        loadingMoreRef.current = false
        if (!cancelled) setLoadingMore(false)
      }
    }
    loadMoreRef.current = loadMoreHistory

    return () => {
      cancelled = true
      loadMoreRef.current = null
    }
  }, [coin, timeframe])

  // Entry / liquidation price lines from the selected position.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    linesRef.current.forEach((l) => series.removePriceLine(l))
    linesRef.current = []
    if (!position) return
    if (position.entryPx) {
      linesRef.current.push(
        series.createPriceLine({
          price: position.entryPx,
          color: position.side === 'short' ? '#ff5d73' : '#34e2a8',
          lineStyle: 2,
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${position.side === 'short' ? '▼' : '▲'} Entry`,
        }),
      )
    }
    if (position.liquidationPx) {
      linesRef.current.push(
        series.createPriceLine({
          price: position.liquidationPx,
          color: '#ff5d73',
          lineStyle: 3,
          lineWidth: 1,
          axisLabelVisible: true,
          title: 'Liq',
        }),
      )
    }
  }, [position, coin, timeframe])

  // YOUR OWN position on this coin (from "My positions"): white entry line,
  // orange liquidation line — distinct from the vault's green/red lines.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    myLinesRef.current.forEach((l) => series.removePriceLine(l))
    myLinesRef.current = []
    if (!myPosition) return
    if (myPosition.entryPx) {
      myLinesRef.current.push(
        series.createPriceLine({
          price: myPosition.entryPx,
          color: '#e8eef0',
          lineStyle: 2,
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${myPosition.side === 'short' ? '▼' : '▲'} You`,
        }),
      )
    }
    if (myPosition.liquidationPx) {
      myLinesRef.current.push(
        series.createPriceLine({
          price: myPosition.liquidationPx,
          color: '#ffb020',
          lineStyle: 3,
          lineWidth: 1,
          axisLabelVisible: true,
          title: 'You liq',
        }),
      )
    }
  }, [myPosition, coin, timeframe])

  // Entry lines for the OTHER saved vaults' positions on this coin.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    peerLinesRef.current.forEach((l) => series.removePriceLine(l))
    peerLinesRef.current = []
    peers.forEach((p, i) => {
      if (!p.entryPx) return
      peerLinesRef.current.push(
        series.createPriceLine({
          price: p.entryPx,
          color: PEER_COLORS[i % PEER_COLORS.length],
          lineStyle: 1, // dotted, to stand apart from the followed vault's entry
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${p.side === 'short' ? '▼' : '▲'} ${peerLabel(p).slice(0, 14)}`,
        }),
      )
    })
  }, [peers, coin, timeframe])

  // Trade markers, AGGREGATED per candle: a vault (or you) that fires many
  // trades inside one bar shows a single arrow with the combined total + count,
  // instead of a tower of arrows that instantly exhausts the marker budget.
  //   ▲ below the bar = buy/long · ▼ above the bar = sell/short · ■ = your close
  useEffect(() => {
    const sm = markersRef.current
    if (!sm) return
    const times = candleTimesRef.current
    if (!coin || !times.length) {
      sm.setMarkers([])
      return
    }

    // Followed vaults: collapse fills into one bucket per (candle, vault, side).
    const budget = MARKER_BUDGET[timeframe] || { count: 15, by: 'notional' }
    const vaultBuckets = new Map()
    for (const f of fills) {
      if (f.coin !== coin || !f.time || !f.px) continue
      if (hiddenVaults.has(f.address.toLowerCase())) continue
      const t = snapToCandle(times, Math.floor(f.time / 1000))
      if (t == null) continue
      const key = `${t}|${f.address.toLowerCase()}|${f.side}`
      let b = vaultBuckets.get(key)
      if (!b) {
        b = { time: t, vault: f.vault, side: f.side, notional: 0, count: 0 }
        vaultBuckets.set(key, b)
      }
      b.notional += (f.sz || 0) * (f.px || 0)
      b.count += 1
    }
    const selected = [...vaultBuckets.values()]
      .sort((a, b) => (budget.by === 'time' ? b.time - a.time : b.notional - a.notional))
      .slice(0, budget.count)

    // Scale arrow size by sqrt(total notional) within the selected set.
    const roots = selected.map((b) => Math.sqrt(b.notional))
    const lo = Math.min(...roots)
    const hi = Math.max(...roots)
    const sizeFor = (n) => (hi === lo ? 1.2 : 0.8 + ((Math.sqrt(n) - lo) / (hi - lo)) * 1.6)

    // Label the biggest few, one per candle, so text doesn't stack.
    const labelled = new Set()
    const labelledTimes = new Set()
    for (const b of [...selected].sort((a, b) => b.notional - a.notional)) {
      if (labelled.size >= 3) break
      if (labelledTimes.has(b.time)) continue
      labelledTimes.add(b.time)
      labelled.add(b)
    }

    const vaultMarkers = selected.map((b) => {
      const buy = b.side === 'buy'
      return {
        time: b.time,
        position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? '#34e2a8' : '#ff5d73',
        shape: buy ? 'arrowUp' : 'arrowDown',
        size: sizeFor(b.notional),
        text: labelled.has(b)
          ? `${(b.vault || '').slice(0, 10)} ${buy ? 'Buy' : 'Sell'} ${fmtUsd(b.notional, 0)}${
              b.count > 1 ? ` ×${b.count}` : ''
            }`
          : undefined,
      }
    })

    // YOUR OWN trades, aggregated per (candle, long/short/close):
    //   ▲ up = long open · ▼ down = short open · ■ square = close (P/L coloured)
    // The label is just the amount: an open shows total USD, a close total PnL.
    let myMarkers = []
    if (showMyTrades && myFills.length) {
      const myBuckets = new Map()
      for (const f of myFills) {
        if (f.coin !== coin || !f.time || !f.px) continue
        const t = snapToCandle(times, Math.floor(f.time / 1000))
        if (t == null) continue
        const d = (f.dir || '').toLowerCase()
        const cat = d.includes('close') || d.includes('>') ? 'close' : d.includes('long') ? 'long' : 'short'
        const key = `${t}|${cat}`
        let b = myBuckets.get(key)
        if (!b) {
          b = { time: t, cat, notional: 0, pnl: 0, count: 0 }
          myBuckets.set(key, b)
        }
        b.notional += (f.sz || 0) * (f.px || 0)
        b.pnl += f.closedPnl || 0
        b.count += 1
      }
      const mine = [...myBuckets.values()].sort((a, b) => b.time - a.time).slice(0, MY_MARKER_BUDGET)
      let myLabels = 0
      myMarkers = mine.map((b) => {
        const suffix = b.count > 1 ? ` ×${b.count}` : ''
        const text =
          myLabels++ < 10
            ? b.cat === 'close'
              ? `${fmtSignedUsd(b.pnl)}${suffix}`
              : `${fmtUsd(b.notional, 0)}${suffix}`
            : undefined
        if (b.cat === 'close') {
          const up = b.pnl >= 0
          return { time: b.time, position: 'inBar', shape: 'square', size: 1.4, color: up ? MY_COLORS.up : MY_COLORS.down, text }
        }
        const long = b.cat === 'long'
        return {
          time: b.time,
          position: long ? 'belowBar' : 'aboveBar',
          shape: long ? 'arrowUp' : 'arrowDown',
          size: 2,
          color: long ? MY_COLORS.up : MY_COLORS.down,
          text,
        }
      })
    }

    const markers = [...vaultMarkers, ...myMarkers].sort((a, b) => a.time - b.time)
    sm.setMarkers(markers)
  }, [fills, myFills, coin, candleTick, hiddenVaults, timeframe, showMyTrades])

  // Mount saved trendlines for the current coin — each rendered as a ray
  // extending +10 years past its second anchor.
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
    const lines = coin ? loadTrendStore()[coin] || [] : []
    const step = candleStep()
    for (const ln of lines) {
      const s = chart.addSeries(LineSeries, TREND_OPTS)
      s.setData(rayPoints(ln, step))
      trendSeriesRef.current.push({ series: s, ln })
    }
    setHasTrendlines(lines.length > 0)
  }, [coin, trendVersion, candleTick])

  // Trendline drawing: two clicks define a line; crosshair previews it live.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !drawMode || !coin) return undefined

    // Freeze the chart while drawing so the preview line can't rescale the price
    // axis or auto-scroll when the cursor reaches the right edge. Restored below.
    const priceScale = chart.priceScale('right')
    priceScale.applyOptions({ autoScale: false })
    chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: false })
    chart.applyOptions({ handleScroll: false, handleScale: false })

    const pointAt = (param) => {
      if (!param?.point) return null
      const price = series.coordinateToPrice(param.point.y)
      if (price == null) return null
      if (param.time != null) return { time: param.time, value: price }
      // Beyond the last candle there's no bar time — extrapolate from the
      // logical (bar-index) coordinate so trendlines can project into the future.
      const times = candleTimesRef.current
      if (times.length < 2) return null
      let logical = param.logical
      if (logical == null) logical = chart.timeScale().coordinateToLogical(param.point.x)
      if (logical == null) return null
      const lastIdx = times.length - 1
      const step = times[lastIdx] - times[lastIdx - 1]
      // Clamp into the reserved future room so we never add a brand-new bar
      // (which would shift the chart) while the cursor runs off the right edge.
      const offset = Math.min(Math.round(logical) - lastIdx, FUTURE_ROOM)
      if (offset <= 0) return null
      return { time: times[lastIdx] + offset * step, value: price }
    }

    const onClick = (param) => {
      const pt = pointAt(param)
      if (!pt) return
      if (!draftRef.current) {
        // Single point for now — duplicate times in setData make the lib throw.
        // The crosshair-move preview supplies the second point.
        const s = chart.addSeries(LineSeries, TREND_OPTS)
        s.setData([pt])
        draftRef.current = { t1: pt.time, p1: pt.value, series: s, raf: null, pending: null }
        return
      }
      const d = draftRef.current
      if (pt.time === d.t1) return // need two distinct candles
      if (d.raf) cancelAnimationFrame(d.raf)
      const pts = [{ time: d.t1, value: d.p1 }, pt].sort((x, y) => x.time - y.time)
      const ln = { t1: pts[0].time, p1: pts[0].value, t2: pts[1].time, p2: pts[1].value }
      // Keep the drawn series mounted — rendered as a +10y ray from here on.
      d.series.setData(rayPoints(ln, candleStep()))
      trendSeriesRef.current.push({ series: d.series, ln })
      draftRef.current = null
      const store = loadTrendStore()
      store[coin] = [...(store[coin] || []), ln]
      saveTrendStore(store)
      setHasTrendlines(true)
      setDrawMode(false)
    }

    // Preview throttled to one update per frame, and only when the crosshair
    // actually moved to a new candle/price — unthrottled setData churn lags.
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
      // Unfreeze: restore auto-scaling and scroll/zoom for normal viewing.
      priceScale.applyOptions({ autoScale: true })
      chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: true })
      chart.applyOptions({ handleScroll: true, handleScale: true })
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
  }, [drawMode, coin])

  // Measure tool: drag on the chart to read the % and price change between two
  // points (like TradingView). The chart is frozen during the drag so the box
  // stays anchored and the drag measures instead of scrolling.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const el = containerRef.current
    if (!chart || !series || !el || !measureMode) return undefined

    const priceScale = chart.priceScale('right')
    priceScale.applyOptions({ autoScale: false })
    chart.applyOptions({ handleScroll: false, handleScale: false })

    let start = null
    const local = (e) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onDown = (e) => {
      const { x, y } = local(e)
      const price = series.coordinateToPrice(y)
      if (price == null) return
      start = { x, y, price }
      setMeasureBox(null)
    }
    const onMove = (e) => {
      if (!start) return
      const { x, y } = local(e)
      const price = series.coordinateToPrice(y)
      if (price == null) return
      const diff = price - start.price
      const pct = start.price ? (diff / start.price) * 100 : 0
      setMeasureBox({ x1: start.x, y1: start.y, x2: x, y2: y, pct, diff, up: diff >= 0 })
    }
    const onUp = () => {
      start = null // keep the box visible until the next drag
    }
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      priceScale.applyOptions({ autoScale: true })
      chart.applyOptions({ handleScroll: true, handleScale: true })
      setMeasureBox(null)
    }
  }, [measureMode])

  // Esc exits measure/draw mode first, then fullscreen.
  useEffect(() => {
    if (!fullscreen && !drawMode && !measureMode) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (measureMode) setMeasureMode(false)
      else if (drawMode) setDrawMode(false)
      else setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, drawMode, measureMode])

  const clearTrendlines = () => {
    const store = loadTrendStore()
    delete store[coin]
    saveTrendStore(store)
    setTrendVersion((v) => v + 1)
    setTrashAt(null)
  }

  const deleteTrendline = (index) => {
    const store = loadTrendStore()
    const lines = store[coin] || []
    lines.splice(index, 1)
    if (lines.length) store[coin] = lines
    else delete store[coin]
    saveTrendStore(store)
    setTrendVersion((v) => v + 1)
    setTrashAt(null)
  }

  // Hovering near a trendline's LEFT anchor shows a floating delete button.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !coin || drawMode) {
      setTrashAt(null)
      return undefined
    }
    const onMove = (param) => {
      // No point = cursor left the pane (possibly onto the trash button
      // itself) — keep the current state so the button stays clickable.
      if (!param?.point) return
      const lines = loadTrendStore()[coin] || []
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
  }, [coin, drawMode, trendVersion])

  return (
    <div className={`chart-panel${fullscreen ? ' fullscreen' : ''}`}>
      <div className="chart-head">
        <div className="chart-title">
          {coin ? (
            <>
              <CoinIcon coin={coin} size={22} className="ct-icon" />
              <span className="ct-coin" title={coin}>
                {coinLabel(coin)}
              </span>
              <span className="ct-sub">· Hyperliquid</span>
            </>
          ) : (
            'Select a coin'
          )}
        </div>
        <div className="chart-intervals">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              className={`iv ${timeframe === tf.value ? 'active' : ''}`}
              onClick={() => setTimeframe(tf.value)}
            >
              {tf.label}
            </button>
          ))}
          <span className="tool-sep" />
          <button
            className={`iv ${measureMode ? 'active' : ''}`}
            title="Measure: drag up or down to read the % and price change (Esc exits)"
            disabled={!coin}
            onClick={() => {
              setDrawMode(false)
              setMeasureMode((o) => !o)
            }}
          >
            📐 Measure
          </button>
          <button
            className={`iv ${drawMode ? 'active' : ''}`}
            title="Draw a trendline: click two points (Esc cancels)"
            disabled={!coin}
            onClick={() => {
              setMeasureMode(false)
              setDrawMode((o) => !o)
            }}
          >
            ✏ Line
          </button>
          {hasTrendlines && (
            <button className="iv" title="Remove all trendlines for this coin" onClick={clearTrendlines}>
              ✕ Lines
            </button>
          )}
          <button
            className="iv"
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={() => setFullscreen((f) => !f)}
          >
            ⛶
          </button>
        </div>
      </div>
      {coin && peers.length > 0 && (
        <div className="peer-strip">
          <span className="peer-strip-label">Also in {coinLabel(coin)}:</span>
          {peers.map((p, i) => (
            <button
              key={p.vaultAddress}
              className="peer-chip"
              title={`${peerLabel(p)} — view this vault`}
              onClick={() => onSelectVault?.(p.vaultAddress)}
            >
              <span
                className="peer-dot"
                style={{ background: PEER_COLORS[i % PEER_COLORS.length] }}
              />
              <span className="peer-name">{peerLabel(p)}</span>
              <span className={`peer-side ${p.side}`}>
                {p.side === 'long' ? '▲' : '▼'} {p.side} {p.leverage ? `${p.leverage}x` : ''}
              </span>
              <span className="peer-entry num">@ {fmtPrice(p.entryPx)}</span>
              <span className={`peer-pnl num ${(p.unrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}`}>
                {fmtSignedUsd(p.unrealizedPnl)}
              </span>
            </button>
          ))}
        </div>
      )}
      {coin && (fillVaults.length > 0 || hasMyTrades) && (
        <div className="marker-strip">
          <span className="peer-strip-label">Trades:</span>
          {hasMyTrades && (
            <button
              className={`marker-chip you${showMyTrades ? '' : ' off'}`}
              title={showMyTrades ? 'Hide your trades' : 'Show your trades'}
              onClick={() => setShowMyTrades((s) => !s)}
            >
              {showMyTrades ? '●' : '◌'} You
            </button>
          )}
          {fillVaults.map((v) => {
            const off = hiddenVaults.has(v.address)
            return (
              <button
                key={v.address}
                className={`marker-chip${off ? ' off' : ''}`}
                title={off ? 'Show this vault’s trades' : 'Hide this vault’s trades'}
                onClick={() => toggleVaultMarkers(v.address)}
              >
                {off ? '◌' : '●'} {v.name}
              </button>
            )
          })}
        </div>
      )}
      <div className="chart-wrap">
        <div className="chart-body" ref={containerRef} />
        {measureBox &&
          (() => {
            const left = Math.min(measureBox.x1, measureBox.x2)
            const top = Math.min(measureBox.y1, measureBox.y2)
            const width = Math.abs(measureBox.x2 - measureBox.x1)
            const height = Math.abs(measureBox.y2 - measureBox.y1)
            const centerX = (measureBox.x1 + measureBox.x2) / 2
            // Label sits OUTSIDE the box (above if up, below if down) so it never
            // covers the region you're measuring.
            const labelStyle = measureBox.up
              ? { left: centerX, top, transform: 'translate(-50%, calc(-100% - 6px))' }
              : { left: centerX, top: top + height, transform: 'translate(-50%, 6px)' }
            return (
              <>
                <div
                  className={`measure-box ${measureBox.up ? 'up' : 'down'}`}
                  style={{ left, top, width, height }}
                />
                <div
                  className={`measure-label ${measureBox.up ? 'up' : 'down'}`}
                  style={labelStyle}
                >
                  <span className="measure-pct">
                    {measureBox.pct >= 0 ? '+' : ''}
                    {measureBox.pct.toFixed(2)}%
                  </span>
                  <span className="measure-sub num">
                    {measureBox.diff >= 0 ? '+' : '−'}
                    {fmtPrice(Math.abs(measureBox.diff))}
                  </span>
                </div>
              </>
            )
          })()}
        {measureMode && !measureBox && (
          <div className="draw-hint">drag up or down to measure % change · Esc exits</div>
        )}
        {coin && (
          <a
            className="tv-link"
            href={tradingViewUrl(coin)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${coinLabel(coin)} in TradingView`}
          >
            <CoinIcon coin={coin} size={18} />
            TradingView
          </a>
        )}
        {loading && <div className="chart-status">loading…</div>}
        {loadingMore && !loading && <div className="chart-loading-more">loading history…</div>}
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
            {draftRef.current ? 'click the second point' : 'click two points to draw a trendline'} ·
            Esc cancels
          </div>
        )}
      </div>
    </div>
  )
}
