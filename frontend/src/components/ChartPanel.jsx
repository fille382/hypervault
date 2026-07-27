import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import CoinPicker from './CoinPicker.jsx'
import { loadTrendStore, saveTrendStore, rayPoints, TREND_OPTS } from '../trendlines.js'
import {
  loadAlertStore,
  addAlert,
  removeAlert,
  lineValueAt,
  ALERTS_EVENT,
  NEAR_PCT,
} from '../alerts.js'
import { TradeDotsPrimitive } from '../tradeDots.js'

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

// Live tail: how often the chart re-fetches its newest bars so the forming
// candle tracks the market between full reloads. Scales with the timeframe —
// a 5m scalping chart needs to feel live, a monthly can relax. The backend
// throttles the upstream fetch, so polling here is mostly a local read.
const LIVE_REFRESH_MS = {
  '5m': 4000,
  '15m': 4000,
  '1h': 5000,
  '4h': 6000,
  '1d': 8000,
  '3d': 8000,
  '1w': 10000,
  '1M': 10000,
}
const LIVE_TAIL_BARS = 3 // the forming bar plus a couple just-closed ones

// A failed initial load retries at this pace until it lands. The failures are
// transient (backend restarting mid-edit, upstream hiccup/rate budget) and the
// live-tail poller can't recover an empty chart, so without this one bad fetch
// would leave the chart dead until you switched coin or timeframe.
const LOAD_RETRY_MS = 4000

// How many of YOUR own trades to mark on the chart (most recent on the coin).
const MY_MARKER_BUDGET = 60

// Trade-marker style: 'dots' draws a small dot at the exact fill price just
// right of the candle (easy to read where you actually sold); 'arrows' is the
// classic above/below-bar arrow look. Persisted across sessions.
const MARKER_STYLE_KEY = 'hypervault.markerStyle'
const loadMarkerStyle = () => {
  try {
    const v = localStorage.getItem(MARKER_STYLE_KEY)
    return v === 'arrows' ? 'arrows' : 'dots'
  } catch {
    return 'dots'
  }
}
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
  meta = {},
  onSelectCoin,
}) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const linesRef = useRef([])
  const peerLinesRef = useRef([])
  const myLinesRef = useRef([])
  const markersRef = useRef(null)
  const tradeDotsRef = useRef(null)
  const candleTimesRef = useRef([])
  const [timeframe, setTimeframe] = useState('3d')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [candleTick, setCandleTick] = useState(0) // bumps when new candles land
  const [hiddenVaults, setHiddenVaults] = useState(() => new Set()) // addr(lower) with markers off
  const [fullscreen, setFullscreen] = useState(false)
  const [showMyTrades, setShowMyTrades] = useState(true) // your own trade markers
  const [markerStyle, setMarkerStyle] = useState(loadMarkerStyle) // 'dots' | 'arrows'
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
  // Price alerts: click a price to get notified when the market closes in on
  // it. Lines live in localStorage (see alerts.js); App.jsx does the checking.
  const [alertMode, setAlertMode] = useState(false)
  const [alertsVersion, setAlertsVersion] = useState(0) // bumps when alerts change
  const [alertTrashAt, setAlertTrashAt] = useState(null) // {x, y, id} near an alert line
  const alertLinesRef = useRef([]) // createPriceLine handles for the current coin
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
    const tradeDots = new TradeDotsPrimitive()
    series.attachPrimitive(tradeDots)
    tradeDotsRef.current = tradeDots
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
      tradeDotsRef.current = null
      linesRef.current = []
      peerLinesRef.current = []
      myLinesRef.current = []
      candleTimesRef.current = []
    }
  }, [])

  // Load candles whenever the coin or timeframe changes. Failures schedule a
  // retry (see LOAD_RETRY_MS) — the error banner stays up until a retry lands.
  useEffect(() => {
    if (!coin || !seriesRef.current) return undefined
    let cancelled = false
    let retryTimer = null
    setLoading(true)
    setErr(null)
    noMoreHistoryRef.current = false
    loadingMoreRef.current = false
    // Drop the previous coin/timeframe's candles NOW, not on fetch success:
    // the live-tail poller merges into whatever this holds, and while the load
    // is in flight it would otherwise splice the new coin's tail bars into the
    // old coin's series (same 3d/1d time buckets, wildly different prices).
    candlesRef.current = []
    candleTimesRef.current = []
    const load = () =>
      getCandles(coin, timeframe, BARS[timeframe] || 300)
        .then((data) => {
          if (cancelled || !seriesRef.current) return
          setErr(null)
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
          if (cancelled) return
          setErr(e.message)
          retryTimer = setTimeout(load, LOAD_RETRY_MS)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    load()

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
      clearTimeout(retryTimer)
      loadMoreRef.current = null
    }
  }, [coin, timeframe])

  // Live tail: keep the forming bar (and any bar that just closed) current,
  // so the chart's last price tracks the market instead of freezing at
  // whatever it was when the coin/timeframe last loaded.
  useEffect(() => {
    if (!coin) return undefined
    let cancelled = false
    const refresh = async () => {
      if (document.hidden || loadingMoreRef.current) return
      const existing = candlesRef.current
      if (!seriesRef.current || !existing.length) return
      try {
        const data = await getCandles(coin, timeframe, LIVE_TAIL_BARS)
        // Bail if the coin switched or a history load replaced the data
        // while we were in flight — merging into the old array would be wrong.
        if (cancelled || !seriesRef.current || candlesRef.current !== existing) return
        const last = existing.at(-1)
        const fresh = (data.candles || []).filter((c) => c.time >= last.time)
        if (!fresh.length) return
        const grew = fresh.at(-1).time > last.time
        if (!grew) {
          const c = fresh.at(-1)
          if (
            c.open === last.open &&
            c.high === last.high &&
            c.low === last.low &&
            c.close === last.close
          )
            return // nothing moved since the previous tick
        }
        const byTime = new Map(existing.map((c) => [c.time, c]))
        for (const c of fresh) byTime.set(c.time, c)
        const merged = [...byTime.values()].sort((a, b) => a.time - b.time)
        const ts = chartRef.current?.timeScale()
        const view = ts?.getVisibleLogicalRange()
        candlesRef.current = merged
        seriesRef.current.setData(withFutureRoom(merged))
        // Bars only changed at the right edge, so logical indices are stable —
        // restoring the exact range keeps the user's scroll/zoom untouched.
        if (ts && view) ts.setVisibleLogicalRange(view)
        if (grew) {
          candleTimesRef.current = merged.map((c) => c.time)
          setCandleTick((t) => t + 1) // markers/trendlines re-snap to the new bar
        }
      } catch {
        /* transient — the next tick retries */
      }
    }
    const id = setInterval(refresh, LIVE_REFRESH_MS[timeframe] || 8000)
    return () => {
      cancelled = true
      clearInterval(id)
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
  // trades inside one bar shows a single marker with the combined total + count,
  // instead of a tower of markers that instantly exhausts the marker budget.
  // Two styles (toggle in the marker strip):
  //   dots   — a dot at the exact (size-weighted) fill price, just right of the
  //            candle: green = buy/long, red = sell/short, white ring = you
  //   arrows — ▲ below = buy/long · ▼ above = sell/short · ■ = your close
  useEffect(() => {
    const sm = markersRef.current
    const dots = tradeDotsRef.current
    if (!sm || !dots) return
    const times = candleTimesRef.current
    if (!coin || !times.length) {
      sm.setMarkers([])
      dots.setDots([])
      return
    }
    const asDots = markerStyle === 'dots'

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
        b = { time: t, vault: f.vault, side: f.side, notional: 0, size: 0, count: 0 }
        vaultBuckets.set(key, b)
      }
      b.notional += (f.sz || 0) * (f.px || 0)
      b.size += f.sz || 0
      b.count += 1
    }
    const selected = [...vaultBuckets.values()]
      .sort((a, b) => (budget.by === 'time' ? b.time - a.time : b.notional - a.notional))
      .slice(0, budget.count)

    // Scale marker size by sqrt(total notional) within the selected set.
    const roots = selected.map((b) => Math.sqrt(b.notional))
    const lo = Math.min(...roots)
    const hi = Math.max(...roots)
    const frac = (n) => (hi === lo ? 0.5 : (Math.sqrt(n) - lo) / (hi - lo))
    const sizeFor = (n) => 0.8 + frac(n) * 1.6 // arrow size 0.8..2.4
    const radiusFor = (n) => 3 + frac(n) * 4 // dot radius 3..7 px

    // Label the biggest few, one per candle, so text doesn't stack.
    const labelled = new Set()
    const labelledTimes = new Set()
    for (const b of [...selected].sort((a, b) => b.notional - a.notional)) {
      if (labelled.size >= 3) break
      if (labelledTimes.has(b.time)) continue
      labelledTimes.add(b.time)
      labelled.add(b)
    }
    const vaultText = (b, buy) =>
      `${(b.vault || '').slice(0, 10)} ${buy ? 'Buy' : 'Sell'} ${fmtUsd(b.notional, 0)}${
        b.count > 1 ? ` ×${b.count}` : ''
      }`

    // The bucket's size-weighted average fill price — where the dot sits.
    const avgPx = (b) => (b.size > 0 ? b.notional / b.size : 0)

    const vaultMarkers = []
    const vaultDots = []
    for (const b of selected) {
      const buy = b.side === 'buy'
      const text = labelled.has(b) ? vaultText(b, buy) : undefined
      if (asDots) {
        const price = avgPx(b)
        if (price > 0)
          vaultDots.push({
            time: b.time,
            price,
            r: radiusFor(b.notional),
            color: buy ? '#34e2a8' : '#ff5d73',
            label: text,
          })
      } else {
        vaultMarkers.push({
          time: b.time,
          position: buy ? 'belowBar' : 'aboveBar',
          color: buy ? '#34e2a8' : '#ff5d73',
          shape: buy ? 'arrowUp' : 'arrowDown',
          size: sizeFor(b.notional),
          text,
        })
      }
    }

    // YOUR OWN trades, aggregated per (candle, long/short/close). Dots get a
    // white ring so your fills stand apart from the vaults'; closes are
    // coloured by P/L. The label is just the amount: an open shows total USD,
    // a close total PnL.
    const myMarkers = []
    const myDots = []
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
          b = { time: t, cat, notional: 0, size: 0, pnl: 0, count: 0 }
          myBuckets.set(key, b)
        }
        b.notional += (f.sz || 0) * (f.px || 0)
        b.size += f.sz || 0
        b.pnl += f.closedPnl || 0
        b.count += 1
      }
      const mine = [...myBuckets.values()].sort((a, b) => b.time - a.time).slice(0, MY_MARKER_BUDGET)
      let myLabels = 0
      for (const b of mine) {
        const suffix = b.count > 1 ? ` ×${b.count}` : ''
        const text =
          myLabels++ < 10
            ? b.cat === 'close'
              ? `${fmtSignedUsd(b.pnl)}${suffix}`
              : `${fmtUsd(b.notional, 0)}${suffix}`
            : undefined
        const close = b.cat === 'close'
        const up = close ? b.pnl >= 0 : b.cat === 'long'
        const color = up ? MY_COLORS.up : MY_COLORS.down
        if (asDots) {
          const price = avgPx(b)
          if (price > 0)
            myDots.push({ time: b.time, price, r: 4.5, color, ring: '#e8eef0', label: text })
        } else if (close) {
          myMarkers.push({ time: b.time, position: 'inBar', shape: 'square', size: 1.4, color, text })
        } else {
          myMarkers.push({
            time: b.time,
            position: b.cat === 'long' ? 'belowBar' : 'aboveBar',
            shape: b.cat === 'long' ? 'arrowUp' : 'arrowDown',
            size: 2,
            color,
            text,
          })
        }
      }
    }

    sm.setMarkers([...vaultMarkers, ...myMarkers].sort((a, b) => a.time - b.time))
    dots.setDots([...vaultDots, ...myDots])
  }, [fills, myFills, coin, candleTick, hiddenVaults, timeframe, showMyTrades, markerStyle])

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

  // Re-render alert lines whenever the store changes — from this component's
  // own tool, or externally (App.jsx removes an alert once it's hit).
  useEffect(() => {
    const bump = () => setAlertsVersion((v) => v + 1)
    window.addEventListener(ALERTS_EVENT, bump)
    return () => window.removeEventListener(ALERTS_EVENT, bump)
  }, [])

  // Mount the current coin's price alerts as dashed horizontal lines.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    alertLinesRef.current.forEach((l) => {
      try {
        series.removePriceLine(l)
      } catch {
        /* already gone */
      }
    })
    alertLinesRef.current = []
    const alerts = coin ? loadAlertStore()[coin] || [] : []
    for (const a of alerts) {
      alertLinesRef.current.push(
        series.createPriceLine({
          price: a.px,
          color: '#ffce5c', // amber — same family as your drawn trendlines
          lineStyle: 2,
          lineWidth: 1,
          axisLabelVisible: true,
          title: '🔔 alert',
        }),
      )
    }
  }, [coin, alertsVersion])

  // Alert placement: one click on the chart sets the level; the market side
  // it's approached from (the current mark price) is captured with it.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !alertMode || !coin) return undefined
    const onClick = (param) => {
      if (!param?.point) return
      const price = series.coordinateToPrice(param.point.y)
      if (price == null || price <= 0) return
      const markPx = meta[coin]?.markPx || candlesRef.current.at(-1)?.close || price
      addAlert(coin, price, markPx)
      setAlertMode(false)
    }
    chart.subscribeClick(onClick)
    return () => chart.unsubscribeClick(onClick)
  }, [alertMode, coin, meta])

  // Hovering near an alert line shows a floating delete button. It keeps the
  // x where it first appeared so it doesn't chase the cursor along the line.
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || !coin || alertMode || drawMode) {
      setAlertTrashAt(null)
      return undefined
    }
    const alerts = loadAlertStore()[coin] || []
    if (!alerts.length) {
      setAlertTrashAt(null)
      return undefined
    }
    const onMove = (param) => {
      // No point = cursor left the pane (possibly onto the trash button
      // itself) — keep the current state so the button stays clickable.
      if (!param?.point) return
      let best = null
      for (const a of alerts) {
        const y = series.priceToCoordinate(a.px)
        if (y == null) continue
        const dy = Math.abs(param.point.y - y)
        if (dy <= 8 && (!best || dy < best.dy)) best = { y, dy, id: a.id }
      }
      setAlertTrashAt((prev) => {
        if (!best) return prev ? null : prev
        if (prev && prev.id === best.id) return prev.y === best.y ? prev : { ...prev, y: best.y }
        return { x: param.point.x, y: best.y, id: best.id }
      })
    }
    chart.subscribeCrosshairMove(onMove)
    return () => chart.unsubscribeCrosshairMove(onMove)
  }, [coin, alertMode, drawMode, alertsVersion])

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
      // Record which side of the line the market is on right now, so the
      // cross-alert (see alerts.js) fires even for a cross that happens
      // while the app is closed.
      const markPx = candlesRef.current.at(-1)?.close
      const lv = markPx ? lineValueAt(ln, Date.now() / 1000) : null
      if (lv != null && lv > 0) ln.alertSide = markPx > lv ? 1 : markPx < lv ? -1 : 0
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

  // Esc exits measure/draw/alert mode first, then fullscreen.
  useEffect(() => {
    if (!fullscreen && !drawMode && !measureMode && !alertMode) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (measureMode) setMeasureMode(false)
      else if (drawMode) setDrawMode(false)
      else if (alertMode) setAlertMode(false)
      else setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen, drawMode, measureMode, alertMode])

  // The floating 🗑 buttons sit ON TOP of the chart, so a wheel gesture over
  // one isn't caught by the chart's canvas — nothing preventDefaults it and
  // the browser zooms/scrolls the PAGE instead. Forward the gesture to the
  // chart (so zooming continues seamlessly) and duck out of the way.
  const trashWheelRef = useCallback((el) => {
    if (!el) return
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        containerRef.current?.querySelector('canvas')?.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            ctrlKey: e.ctrlKey,
          }),
        )
        // You're zooming, not deleting — hide the buttons so the rest of the
        // gesture hits the chart directly. They re-appear on the next hover.
        setTrashAt(null)
        setAlertTrashAt(null)
      },
      { passive: false },
    )
  }, [])

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
              <CoinPicker coin={coin} meta={meta} onSelectCoin={onSelectCoin} />
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
              setAlertMode(false)
              setMeasureMode((o) => !o)
            }}
          >
            📐 Measure
          </button>
          <button
            className={`iv ${drawMode ? 'active' : ''}`}
            title="Draw a trendline: click two points — you're notified when the price closes in on it or crosses it (Esc cancels)"
            disabled={!coin}
            onClick={() => {
              setMeasureMode(false)
              setAlertMode(false)
              setDrawMode((o) => !o)
            }}
          >
            ✏ Line
          </button>
          <button
            className={`iv ${alertMode ? 'active' : ''}`}
            title={`Price alert: click a price on the chart — you're notified when the market closes in (within ${NEAR_PCT}%) and when it hits (Esc cancels)`}
            disabled={!coin}
            onClick={() => {
              setMeasureMode(false)
              setDrawMode(false)
              setAlertMode((o) => !o)
            }}
          >
            🔔 Alert
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
          <button
            className="marker-chip style-toggle"
            title={
              markerStyle === 'dots'
                ? 'Dots at the exact fill price — click for the classic arrows'
                : 'Classic arrows — click for dots at the exact fill price'
            }
            onClick={() =>
              setMarkerStyle((s) => {
                const next = s === 'dots' ? 'arrows' : 'dots'
                try {
                  localStorage.setItem(MARKER_STYLE_KEY, next)
                } catch {
                  /* ignore storage errors */
                }
                return next
              })
            }
          >
            {markerStyle === 'dots' ? '◉ Dots' : '⬆ Arrows'}
          </button>
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
            ref={trashWheelRef}
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
        {alertMode && (
          <div className="draw-hint">
            click a price to set an alert — notices land in Trade history · Esc cancels
          </div>
        )}
        {alertTrashAt && !drawMode && !alertMode && (
          <button
            ref={trashWheelRef}
            className="trend-trash"
            style={{ left: alertTrashAt.x, top: alertTrashAt.y }}
            title="Remove this price alert"
            onClick={() => {
              removeAlert(coin, alertTrashAt.id)
              setAlertTrashAt(null)
            }}
          >
            🗑
          </button>
        )}
      </div>
    </div>
  )
}
