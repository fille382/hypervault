import { useEffect, useRef, useState } from 'react'
import { getBook, getTrades } from '../api.js'
import { fmtNum, fmtPrice, fmtUsdCompact, coinLabel } from '../format.js'

// The backend serves this from its Hyperliquid websocket cache, so polling
// fast here costs nothing upstream — it's a local read. Fast polls keep the
// book in near-constant small motion instead of one big jump every 2s.
const POLL_MS = 400

// How long the mid-price glides toward a new value (see useGlidingNumber).
const MID_GLIDE_MS = 350

// Price-grouping steps, exchange-style. "min" is the coin's native tick; the
// rest re-subscribe upstream with fewer significant figures (Hyperliquid's
// nSigFigs/mantissa), so the ladder's 20 levels cover a wider price range in
// coarser buckets instead of crowding around the spread.
const GROUPINGS = [
  { key: 'min', sig: 0, mantissa: 0, mult: 1 },
  { key: '2', sig: 5, mantissa: 2, mult: 2 },
  { key: '5', sig: 5, mantissa: 5, mult: 5 },
  { key: '10', sig: 4, mantissa: 0, mult: 10 },
  { key: '100', sig: 3, mantissa: 0, mult: 100 },
  { key: '1000', sig: 2, mantissa: 0, mult: 1000 },
]

// Label a grouping with its actual price step for the coin being shown:
// 5 significant figures at mid 62,400 is a $1 bucket, so ×10 reads "10";
// at mid 0.1234 it's 0.00001, so ×10 reads "0.0001". No mid yet -> "×N".
function groupLabel(g, mid) {
  if (g.mult === 1) return 'min'
  if (!mid) return `×${g.mult}`
  const base = 10 ** Math.floor(Math.log10(mid) - 4)
  return String(Number((base * g.mult).toPrecision(2)))
}

// Depth levels per side scale with the panel's height (which follows the
// chart), so a tall chart gets a deep book instead of dead space below it.
const LEVELS_MIN = 6
const LEVELS_MAX = 20 // Hyperliquid sends up to 20 per side
const ROW_PX = 20.6 // one ladder row: 12px × 1.55 line-height + padding
const CHROME_PX = 280 // header + labels + spread + pressure bar + pulse feed + flow row + padding

// Where the size is concentrated: rows whose share of their side's total is
// outsized get flagged, so big resting walls stand out at a glance.
const WALL_SHARE = 2.5 // × the average level size on that side

// ── Market pulse ─────────────────────────────────────────────────────────
// A quiet event feed under the ladder: only unusually large trades and big
// walls disappearing. Every constant here exists to keep it from spamming.
const TRADES_POLL_MS = 1000
const PULSE_SHOWN = 4 // events visible; older ones just fall away
const PULSE_KEPT = 30
const BURST_WINDOW_MS = 4000 // same-side trades this close merge into one event
const TRADE_FLOOR_USD = 5000 // never flag trades smaller than this
const WALL_MIN_POLLS = 4 // a wall must persist ~1.6s before its removal counts
const WALL_DROP_FRAC = 0.6 // how much of a wall must vanish to count
const WALL_COOLDOWN_MS = 45_000 // max one wall event per price level per this
const WALL_TRADE_LOOKBACK_MS = 15_000 // trades this recent classify eaten vs pulled
// Toasts are a rarer tier on top of the feed: a same-side burst must reach
// TOAST_MULT × the feed threshold, and all pulse toasts share one cooldown.
const TOAST_MULT = 3
const TOAST_COOLDOWN_MS = 2_000
// Taker-flow totals: dollars actually bought vs sold over this rolling window.
const FLOW_WINDOW_MS = 5 * 60_000
const FLOW_GLIDE_MS = 650 // net flow counts toward its new value this long

// Rolls a number smoothly toward its latest target (ease-out), so the
// mid-price glides between polls instead of stepping. Snaps instantly when
// there is no previous value (first load, coin switch) or when the viewer
// prefers reduced motion.
function useGlidingNumber(target, duration) {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  displayRef.current = display
  useEffect(() => {
    const from = displayRef.current
    if (
      target == null ||
      from == null ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(target)
      return undefined
    }
    if (from === target) return undefined
    let raf = null
    const start = performance.now()
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - (1 - t) ** 3
      setDisplay(t < 1 ? from + (target - from) * eased : target)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return display
}

// One Market-pulse event as a compact row with a plain-English tooltip.
// Rows are keyed by event id, so a genuinely new event mounts a new node and
// plays its one-shot highlight; a growing burst updates in place, no re-flash.
function pulseRow(ev, lbl) {
  const age = (Date.now() - ev.ts) / 1000
  const ageTxt = age < 60 ? `${Math.max(0, Math.round(age))}s` : `${Math.round(age / 60)}m`
  let tag
  let text
  let hint
  if (ev.kind === 'trade') {
    const verb = ev.side === 'buy' ? 'bought' : 'sold'
    tag = (
      <span className={`pulse-tag num ${ev.side === 'buy' ? 'pos' : 'neg'}`}>
        {ev.side === 'buy' ? '▲' : '▼'} {fmtUsdCompact(ev.notional)} {verb}
      </span>
    )
    text = <span className="pulse-text num">@ {fmtPrice(ev.px)}</span>
    hint = `${ev.count > 1 ? `A burst of ${ev.count} market ${ev.side} orders` : `A single market ${ev.side} order`} totalling ${fmtNum(ev.sz)} ${lbl} (≈${fmtUsdCompact(ev.notional)}) around ${fmtPrice(ev.px)} — unusually large for this market's recent flow.`
  } else {
    const sideWord = ev.side === 'bid' ? 'buy' : 'sell'
    const pulled = ev.kind === 'wall-pulled'
    tag = (
      <span className={`pulse-tag num ${ev.side === 'bid' ? 'pos' : 'neg'}`}>
        {sideWord} wall
      </span>
    )
    text = (
      <span className="pulse-text num">
        {pulled ? 'pulled' : 'eaten'} @ {fmtPrice(ev.px)}
      </span>
    )
    hint = pulled
      ? `The big ${sideWord} wall at ${fmtPrice(ev.px)} (~${fmtNum(ev.sz)} ${lbl}, ≈${fmtUsdCompact(ev.notional)}) disappeared without matching trades — most likely cancelled. It may have been for show (spoofing); that ${ev.side === 'bid' ? 'support' : 'resistance'} was not real.`
      : `The big ${sideWord} wall at ${fmtPrice(ev.px)} was traded through — real orders absorbed ~${fmtNum(ev.sz)} ${lbl} (≈${fmtUsdCompact(ev.notional)}). Watch whether price keeps moving through that level.`
  }
  return (
    <div key={ev.id} className="ob-pulse-row" title={hint}>
      {tag}
      {text}
      <span className="pulse-age num">{ageTxt}</span>
    </div>
  )
}

export default function OrderBookPanel({ coin, collapsed = false, onToggle, notify }) {
  const panelRef = useRef(null)
  const [book, setBook] = useState(null)
  const [stale, setStale] = useState(false)
  const [levels, setLevels] = useState(LEVELS_MIN)
  const [grouping, setGrouping] = useState(0) // index into GROUPINGS
  // Show sizes in coin units or their dollar value. Dollars are the easier
  // mental model ("$85M for sale at 64k" vs "1,333 BTC"), so the Size column
  // header toggles between the two.
  const [inUsd, setInUsd] = useState(false)
  // Change tracking for the flash effect: which levels' sizes changed in the
  // latest poll, and in which direction. Purely presentational — a changed
  // size cell remounts (keyed by the tick it last changed) and plays a short
  // CSS pulse. No timers, no per-frame work.
  const flashRef = useRef({ sizes: new Map(), marks: new Map(), tick: 0 })
  const glidingMid = useGlidingNumber(book?.mid ?? null, MID_GLIDE_MS)
  // Market pulse state: significant events (newest first) plus the working
  // memory behind them — trade cursor + recent tape (for classifying wall
  // moves), size stats, tracked walls, and per-level event cooldowns.
  const [events, setEvents] = useState([])
  const pulseRef = useRef({
    id: 0,
    since: 0,
    primed: false, // first poll returns the whole buffer — cursor only, no events
    recent: [], // trades from the last ~30s
    stats: null,
    walls: new Map(), // `side|px` -> {side, px, sz, lastSz, polls}
    cooldown: new Map(), // `side|px` -> last wall-event time
    burst: null, // rolling same-side taker burst, for the toast tier
    lastToast: 0,
    flow: [], // {time, side, notional} per trade, kept for FLOW_WINDOW_MS
  })

  // Flag unusually large taker flow. "Large" is relative to this market's own
  // recent trades (median / p95 from the backend buffer), so BTC doesn't spam
  // and small markets aren't permanently silent. Same-side prints close in
  // time merge into the newest event instead of stacking rows.
  const flagBigTrades = (fresh) => {
    const stats = pulseRef.current.stats || {}
    const threshold = Math.max(
      3 * (stats.p95Notional || 0),
      12 * (stats.medianNotional || 0),
      TRADE_FLOOR_USD,
    )
    for (const side of ['buy', 'sell']) {
      const group = fresh.filter((t) => t.side === side)
      if (!group.length) continue
      const notional = group.reduce((s, t) => s + t.px * t.sz, 0)
      const sz = group.reduce((s, t) => s + t.sz, 0)
      const ts = Math.max(...group.map((t) => t.time))
      // Toast tier: a same-side burst (accumulated across polls) must reach
      // TOAST_MULT × the feed threshold. One toast per burst, plus a global
      // cooldown shared with wall toasts, so the toast slot stays rare.
      if (notify) {
        const pr = pulseRef.current
        const b = pr.burst
        pr.burst =
          b && b.side === side && ts - b.ts < BURST_WINDOW_MS
            ? { side, notional: b.notional + notional, sz: b.sz + sz, ts, toasted: b.toasted }
            : { side, notional, sz, ts, toasted: false }
        if (
          !pr.burst.toasted &&
          pr.burst.notional >= threshold * TOAST_MULT &&
          Date.now() - pr.lastToast > TOAST_COOLDOWN_MS
        ) {
          pr.burst.toasted = true
          pr.lastToast = Date.now()
          notify(
            side === 'buy' ? 'ok' : 'bad',
            `🐋 ${fmtUsdCompact(pr.burst.notional)} of ${coinLabel(coin)} market-${
              side === 'buy' ? 'bought' : 'sold'
            } @ ${fmtPrice(pr.burst.notional / (pr.burst.sz || 1))}`,
          )
        }
      }
      setEvents((prev) => {
        const head = prev[0]
        if (head && head.kind === 'trade' && head.side === side && ts - head.ts < BURST_WINDOW_MS) {
          const merged = {
            ...head,
            notional: head.notional + notional,
            sz: head.sz + sz,
            px: (head.notional + notional) / (head.sz + sz),
            ts,
            count: head.count + group.length,
          }
          return [merged, ...prev.slice(1)]
        }
        if (notional < threshold) return prev
        const ev = {
          id: ++pulseRef.current.id,
          kind: 'trade',
          side,
          px: notional / (sz || 1),
          sz,
          notional,
          ts,
          count: group.length,
        }
        return [ev, ...prev].slice(0, PULSE_KEPT)
      })
    }
  }

  // Watch the book's walls between polls. When an established wall mostly
  // vanishes, the recent tape at that price decides the verdict: traded
  // volume covering the drop means it was eaten (real orders pushed through);
  // no matching trades means it was pulled (cancelled — possibly spoofed).
  const trackWalls = (b) => {
    const pr = pulseRef.current
    const now = Date.now()
    for (const [side, rows] of [['ask', b.asks || []], ['bid', b.bids || []]]) {
      if (!rows.length) continue
      const avg = rows.reduce((s, r) => s + r.sz, 0) / rows.length
      const wallMin = avg * WALL_SHARE
      const step = rows.length > 1 ? Math.abs(rows[1].px - rows[0].px) : 0
      const present = new Set()
      for (const r of rows) {
        const key = `${side}|${r.px}`
        present.add(key)
        const w = pr.walls.get(key)
        if (r.sz >= wallMin) {
          if (w) {
            w.polls += 1
            w.sz = Math.max(w.sz, r.sz)
            w.lastSz = r.sz
          } else {
            pr.walls.set(key, { side, px: r.px, sz: r.sz, lastSz: r.sz, polls: 1 })
          }
        } else if (w) {
          wallEvent(w, r.sz, key, step, now)
          pr.walls.delete(key)
        }
      }
      // Walls whose level left the book entirely. Levels beyond the window's
      // far edge just scrolled out of the visible ladder (the book only sends
      // its top slice) — drop those silently, they're still resting upstream.
      const farPx = rows.at(-1).px
      for (const [key, w] of pr.walls) {
        if (w.side !== side || present.has(key)) continue
        pr.walls.delete(key)
        const scrolledOut = side === 'ask' ? w.px > farPx : w.px < farPx
        if (!scrolledOut) wallEvent(w, 0, key, step, now)
      }
    }
  }

  const wallEvent = (w, curSz, key, step, now) => {
    const pr = pulseRef.current
    if (w.polls < WALL_MIN_POLLS) return
    const drop = w.sz - curSz
    if (drop < w.sz * WALL_DROP_FRAC) return
    if (now - (pr.cooldown.get(key) || 0) < WALL_COOLDOWN_MS) return
    pr.cooldown.set(key, now)
    const traded = pr.recent
      .filter(
        (t) => Math.abs(t.px - w.px) <= (step || 0) / 2 && now - t.time < WALL_TRADE_LOOKBACK_MS,
      )
      .reduce((s, t) => s + t.sz, 0)
    const ev = {
      id: ++pr.id,
      kind: traded >= drop * 0.5 ? 'wall-eaten' : 'wall-pulled',
      side: w.side,
      px: w.px,
      sz: drop,
      notional: drop * w.px,
      ts: now,
      count: 1,
    }
    setEvents((prev) => [ev, ...prev].slice(0, PULSE_KEPT))
    if (notify && now - pr.lastToast > TOAST_COOLDOWN_MS) {
      pr.lastToast = now
      const sideWord = w.side === 'bid' ? 'Buy' : 'Sell'
      notify(
        'info',
        ev.kind === 'wall-pulled'
          ? `🧱 ${sideWord} wall @ ${fmtPrice(w.px)} pulled (${coinLabel(coin)}) — cancelled, not traded through`
          : `🧱 ${sideWord} wall @ ${fmtPrice(w.px)} eaten — ≈${fmtUsdCompact(ev.notional)} traded through (${coinLabel(coin)})`,
      )
    }
  }

  // How many levels fit: measure the panel (its height tracks the chart's)
  // and fill it. Re-measured on any resize, including the chart's vh-based
  // height changing with the window.
  useEffect(() => {
    const el = panelRef.current
    if (!el || collapsed) return undefined
    const compute = () => {
      const perSide = Math.floor((el.clientHeight - CHROME_PX) / 2 / ROW_PX)
      setLevels(Math.max(LEVELS_MIN, Math.min(perSide, LEVELS_MAX)))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [collapsed, coin])

  useEffect(() => {
    setBook(null)
    setStale(false)
    setGrouping(0) // grouping steps are price-magnitude specific
    flashRef.current = { sizes: new Map(), marks: new Map(), tick: 0 }
    setEvents([])
    pulseRef.current = {
      id: 0,
      since: 0,
      primed: false,
      recent: [],
      stats: null,
      walls: new Map(),
      cooldown: new Map(),
      burst: null,
      lastToast: pulseRef.current.lastToast, // cooldown survives coin switches
      flow: [],
    }
  }, [coin])

  // Changing grouping rescales every level, so old size diffs are meaningless.
  // The previous book stays on screen until the regrouped one lands (fast —
  // the backend answers a grouping switch with a REST snapshot).
  useEffect(() => {
    flashRef.current = { sizes: new Map(), marks: new Map(), tick: 0 }
    // Wall tracking is bucketed by the grouping's price steps too.
    pulseRef.current.walls = new Map()
    pulseRef.current.cooldown = new Map()
  }, [grouping])

  // The tape poll behind Market pulse. Cheap: the backend buffers trades from
  // its websocket, and `since` makes each poll a small delta.
  useEffect(() => {
    if (!coin || collapsed) return undefined
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      getTrades(coin, pulseRef.current.since)
        .then((t) => {
          if (cancelled) return
          const pr = pulseRef.current
          pr.stats = t.stats || pr.stats
          const fresh = t.trades || []
          if (fresh.length) {
            pr.since = Math.max(pr.since, ...fresh.map((x) => x.time))
            const now = Date.now()
            pr.recent = [...pr.recent, ...fresh].filter((x) => now - x.time < 30_000)
            // Taker-flow totals: every trade counts, including the first
            // poll's backlog — those are real trades inside the window.
            pr.flow = [
              ...pr.flow,
              ...fresh.map((x) => ({ time: x.time, side: x.side, notional: x.px * x.sz })),
            ].filter((x) => now - x.time < FLOW_WINDOW_MS)
            // The first poll returns the backlog buffer — set the cursor but
            // don't announce history as if it just happened.
            if (pr.primed) flagBigTrades(fresh)
          }
          pr.primed = true
        })
        .catch(() => {}) // pulse is garnish — never surface its errors
    }
    load()
    const id = setInterval(load, TRADES_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [coin, collapsed])

  useEffect(() => {
    if (!coin || collapsed) return undefined
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      const g = GROUPINGS[grouping]
      getBook(coin, levels, g.sig, g.mantissa)
        .then((b) => {
          if (cancelled) return
          // Diff sizes against the previous snapshot so changed cells pulse.
          const fr = flashRef.current
          fr.tick += 1
          const next = new Map()
          for (const [side, rows] of [['ask', b.asks || []], ['bid', b.bids || []]]) {
            for (const r of rows) {
              const key = `${side}|${r.px}`
              next.set(key, r.sz)
              const old = fr.sizes.get(key)
              if (old != null && old !== r.sz) {
                fr.marks.set(key, { tick: fr.tick, dir: r.sz > old ? 'up' : 'down' })
              }
            }
          }
          // Drop marks for levels that left the book so the map can't grow.
          for (const key of fr.marks.keys()) if (!next.has(key)) fr.marks.delete(key)
          fr.sizes = next
          // Mid-price tick direction — tints the spread row like an exchange.
          if (fr.mid != null && b.mid != null && b.mid !== fr.mid) {
            fr.midDir = b.mid > fr.mid ? 'up' : 'down'
          }
          fr.mid = b.mid
          trackWalls(b)
          setBook(b)
          setStale(false)
        })
        .catch(() => !cancelled && setStale(true))
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [coin, collapsed, levels, grouping])

  // Executed taker flow over the rolling window — the "action" counterpart to
  // the resting-depth balance. Recomputed per render; the book poll keeps
  // renders coming, so the window slides even between trades. Lives above the
  // early returns because the gliding hook below must run unconditionally.
  const flowCut = Date.now() - FLOW_WINDOW_MS
  let buyFlow = 0
  let sellFlow = 0
  for (const t of pulseRef.current.flow) {
    if (t.time < flowCut) continue
    if (t.side === 'buy') buyFlow += t.notional
    else sellFlow += t.notional
  }
  const netFlow = buyFlow - sellFlow
  // The displayed number counts toward its new value instead of stepping.
  const glidingFlow = useGlidingNumber(netFlow, FLOW_GLIDE_MS)

  if (!coin) return null

  if (collapsed) {
    return (
      <aside className="orderbook collapsed">
        <button className="ob-reopen" onClick={onToggle} title="Show order book">
          Order book
        </button>
      </aside>
    )
  }

  const bids = book?.bids || []
  const asks = book?.asks || []

  // Cumulative depth per side (coin units and dollar value); bars are scaled
  // to the deeper side so the two ladders are visually comparable.
  const cum = (rows) => {
    let sum = 0
    let sumUsd = 0
    return rows.map((r) => ({ ...r, cum: (sum += r.sz), cumUsd: (sumUsd += r.sz * r.px) }))
  }
  const bidRows = cum(bids)
  const askRows = cum(asks)
  const maxCum = Math.max(bidRows.at(-1)?.cum || 0, askRows.at(-1)?.cum || 0, 1e-12)
  const wallAt = (rows) =>
    (rows.reduce((s, r) => s + r.sz, 0) / (rows.length || 1)) * WALL_SHARE

  const bidWall = wallAt(bids)
  const askWall = wallAt(asks)

  // Depth balance across the visible book — which side has more resting
  // orders right now. Feeds the pressure bar under the ladder.
  const bidDepth = bidRows.at(-1)?.cum || 0
  const askDepth = askRows.at(-1)?.cum || 0
  const bidShare = bidDepth + askDepth > 0 ? (bidDepth / (bidDepth + askDepth)) * 100 : 50


  const lbl = coinLabel(coin)

  const row = (r, side, wall) => {
    // Remounting the size cell (key = tick of its last change) restarts the
    // one-shot pulse animation exactly when the number changes.
    const mark = flashRef.current.marks.get(`${side}|${r.px}`)
    const isWall = r.sz >= wall
    // Plain-English hover explanation of what this level means.
    const usd = fmtUsdCompact(r.sz * r.px)
    const hint =
      side === 'ask'
        ? `${isWall ? 'Big sell wall: ' : ''}sellers are offering ${fmtNum(r.sz)} ${lbl} (≈${usd}) at ${fmtPrice(r.px)}. Everything for sale between here and the market price: ${fmtNum(r.cum)} ${lbl} (≈${fmtUsdCompact(r.cumUsd)}).`
        : `${isWall ? 'Big buy wall: ' : ''}buyers want ${fmtNum(r.sz)} ${lbl} (≈${usd}) at ${fmtPrice(r.px)}. Everything wanted between here and the market price: ${fmtNum(r.cum)} ${lbl} (≈${fmtUsdCompact(r.cumUsd)}).`
    return (
      <div key={`${side}-${r.px}`} className={`ob-row ${side}${isWall ? ' wall' : ''}`} title={hint}>
        <div className="ob-bar" style={{ width: `${Math.min((r.cum / maxCum) * 100, 100)}%` }} />
        <span className={`ob-px num ${side === 'bid' ? 'pos' : 'neg'}`}>{fmtPrice(r.px)}</span>
        <span
          key={mark ? `f${mark.tick}` : 'sz'}
          className={`ob-sz num${mark ? ` flash-${mark.dir}` : ''}`}
        >
          {inUsd ? fmtUsdCompact(r.sz * r.px) : fmtNum(r.sz)}
        </span>
        <span className="ob-cum num">{inUsd ? fmtUsdCompact(r.cumUsd) : fmtNum(r.cum)}</span>
      </div>
    )
  }

  return (
    <aside className="orderbook" ref={panelRef}>
      <div className="ob-head">
        <span className="ob-title">Order book</span>
        <span className="ob-head-right">
          <select
            className="ob-group"
            value={grouping}
            onChange={(e) => setGrouping(Number(e.target.value))}
            title="Price grouping — bucket the ladder into larger price steps"
          >
            {GROUPINGS.map((g, i) => (
              <option key={g.key} value={i}>
                {groupLabel(g, book?.mid)}
              </option>
            ))}
          </select>
          <span className="ob-sub">
            {stale ? 'reconnecting…' : book && !book.live ? 'snapshot' : 'live'}
          </span>
          <button className="ob-collapse" onClick={onToggle} title="Hide order book — the chart takes the full width">
            »
          </button>
        </span>
      </div>
      <div className="ob-cols">
        <span>Price</span>
        <button
          className="ob-denom"
          onClick={() => setInUsd((v) => !v)}
          title={`Showing sizes in ${inUsd ? 'dollars' : lbl} — click to switch to ${inUsd ? lbl : 'dollars'}`}
        >
          Size ({inUsd ? 'USD' : lbl}) ⇄
        </button>
        <span title="Running total from the middle outward — everything for sale (or wanted) between that price and the market">
          Total
        </span>
      </div>
      {!book ? (
        <div className="ob-empty">Loading book…</div>
      ) : (
        <>
          <div
            className="ob-side-label sell"
            title="Sell orders (asks) — people waiting to sell at these prices. The lowest one is what you'd pay to buy right now."
          >
            Sellers · asks
          </div>
          <div className="ob-side asks">
            {/* best ask nearest the spread row, worst at the top */}
            {[...askRows].reverse().map((r) => row(r, 'ask', askWall))}
          </div>
          <div className="ob-mid">
            <span
              className={`ob-mid-px num${
                flashRef.current.midDir === 'up'
                  ? ' pos'
                  : flashRef.current.midDir === 'down'
                    ? ' neg'
                    : ''
              }`}
              title="Mid price — halfway between the cheapest seller and the highest buyer"
            >
              {fmtPrice(glidingMid ?? book.mid)}
            </span>
            <span
              className="ob-spread num"
              title="Spread — the gap between the cheapest seller and the highest buyer. Crossing it is the cost of trading instantly."
            >
              {book.spread != null ? `± ${fmtNum(book.spread)}` : ''}
              {book.spreadPct != null ? ` · ${book.spreadPct.toFixed(3)}%` : ''}
            </span>
          </div>
          <div
            className="ob-side-label buy"
            title="Buy orders (bids) — people waiting to buy at these prices. The highest one is what you'd get selling right now."
          >
            Buyers · bids
          </div>
          <div className="ob-side bids">{bidRows.map((r) => row(r, 'bid', bidWall))}</div>
          <div
            className="ob-pressure"
            title="Depth balance — how the waiting orders split between buyers and sellers. More green means more buying interest resting in the book (it can shift in seconds)."
          >
            <span className="num pos">Buyers {bidShare.toFixed(0)}%</span>
            <div className="ob-pressure-track">
              <div className="ob-pressure-fill" style={{ width: `${bidShare}%` }} />
            </div>
            <span className="num neg">{(100 - bidShare).toFixed(0)}% Sellers</span>
          </div>
          <div className="ob-pulse">
            <div
              className="ob-pulse-head"
              title="Only significant events show here: trades that are unusually large for this market's recent activity, and big walls disappearing — either eaten by real trading or pulled (cancelled)."
            >
              Market pulse
            </div>
            <div
              className="ob-flow"
              title={`Market buys minus market sells over the last 5 minutes (bought ${fmtUsdCompact(buyFlow)}, sold ${fmtUsdCompact(sellFlow)}). Green = more dollars aggressively buying than selling; red = the opposite. This is executed action — the depth bar above only shows orders waiting.`}
            >
              <span className="ob-flow-label">Net flow</span>
              <span className={`ob-flow-val num ${glidingFlow >= 0 ? 'pos' : 'neg'}`}>
                {glidingFlow >= 0 ? '▲' : '▼'} {fmtUsdCompact(glidingFlow, true)}
              </span>
              <span className="ob-flow-win">5m</span>
            </div>
            {events.length === 0 ? (
              <div className="ob-pulse-empty">Quiet — watching for big trades and wall moves…</div>
            ) : (
              events.slice(0, PULSE_SHOWN).map((ev) => pulseRow(ev, lbl))
            )}
          </div>
        </>
      )}
    </aside>
  )
}
