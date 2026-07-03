import { useEffect, useRef, useState } from 'react'
import { getBook } from '../api.js'
import { fmtNum, fmtPrice, coinLabel } from '../format.js'

// The backend serves this from its Hyperliquid websocket cache, so polling
// fast here costs nothing upstream — it's a local read.
const POLL_MS = 2000

// Depth levels per side scale with the panel's height (which follows the
// chart), so a tall chart gets a deep book instead of dead space below it.
const LEVELS_MIN = 6
const LEVELS_MAX = 20 // Hyperliquid sends up to 20 per side
const ROW_PX = 20.6 // one ladder row: 12px × 1.55 line-height + padding
const CHROME_PX = 100 // header + column labels + spread row + panel padding

// Where the size is concentrated: rows whose share of their side's total is
// outsized get flagged, so big resting walls stand out at a glance.
const WALL_SHARE = 2.5 // × the average level size on that side

// Book-focus mode: rest the mouse on the book this long and it expands into
// the right sidebar's space. Leaving gets a short grace so brushing the edge
// doesn't snap the layout back mid-read.
const FOCUS_HOVER_MS = 5000
const FOCUS_LEAVE_MS = 600

export default function OrderBookPanel({
  coin,
  collapsed = false,
  onToggle,
  focused = false,
  onFocus,
}) {
  const panelRef = useRef(null)
  const [book, setBook] = useState(null)
  const [stale, setStale] = useState(false)
  const [levels, setLevels] = useState(LEVELS_MIN)
  // Change tracking for the flash effect: which levels' sizes changed in the
  // latest poll, and in which direction. Purely presentational — a changed
  // size cell remounts (keyed by the tick it last changed) and plays a short
  // CSS pulse. No timers, no per-frame work.
  const flashRef = useRef({ sizes: new Map(), marks: new Map(), tick: 0 })
  const hoverTimer = useRef(null)
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus

  // Leave no stuck focus behind: collapsing the book or unmounting (e.g. the
  // selected coin cleared) restores the sidebar.
  useEffect(() => {
    if (collapsed) {
      clearTimeout(hoverTimer.current)
      onFocusRef.current?.(false)
    }
  }, [collapsed])
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current)
      onFocusRef.current?.(false)
    },
    [],
  )

  const onMouseEnter = () => {
    if (collapsed || !onFocus) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => onFocusRef.current?.(true), FOCUS_HOVER_MS)
  }
  const onMouseLeave = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => onFocusRef.current?.(false), FOCUS_LEAVE_MS)
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
    flashRef.current = { sizes: new Map(), marks: new Map(), tick: 0 }
  }, [coin])

  useEffect(() => {
    if (!coin || collapsed) return undefined
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      getBook(coin, levels)
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
  }, [coin, collapsed, levels])

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

  // Cumulative depth per side; bars are scaled to the deeper side so the two
  // ladders are visually comparable.
  const cum = (rows) => {
    let sum = 0
    return rows.map((r) => ({ ...r, cum: (sum += r.sz) }))
  }
  const bidRows = cum(bids)
  const askRows = cum(asks)
  const maxCum = Math.max(bidRows.at(-1)?.cum || 0, askRows.at(-1)?.cum || 0, 1e-12)
  const wallAt = (rows) =>
    (rows.reduce((s, r) => s + r.sz, 0) / (rows.length || 1)) * WALL_SHARE

  const bidWall = wallAt(bids)
  const askWall = wallAt(asks)

  const row = (r, side, wall) => {
    // Remounting the size cell (key = tick of its last change) restarts the
    // one-shot pulse animation exactly when the number changes.
    const mark = flashRef.current.marks.get(`${side}|${r.px}`)
    return (
      <div key={`${side}-${r.px}`} className={`ob-row ${side}${r.sz >= wall ? ' wall' : ''}`}>
        <div className="ob-bar" style={{ width: `${Math.min((r.cum / maxCum) * 100, 100)}%` }} />
        <span className={`ob-px num ${side === 'bid' ? 'pos' : 'neg'}`}>{fmtPrice(r.px)}</span>
        <span
          key={mark ? `f${mark.tick}` : 'sz'}
          className={`ob-sz num${mark ? ` flash-${mark.dir}` : ''}`}
        >
          {fmtNum(r.sz)}
        </span>
        <span className="ob-cum num">{fmtNum(r.cum)}</span>
      </div>
    )
  }

  return (
    <aside
      className={`orderbook${focused ? ' focused' : ''}`}
      ref={panelRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="ob-head">
        <span className="ob-title">Order book</span>
        <span className="ob-head-right">
          {focused && <span className="ob-focus-hint">move away to restore</span>}
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
        <span>Size ({coinLabel(coin)})</span>
        <span>Total</span>
      </div>
      {!book ? (
        <div className="ob-empty">Loading book…</div>
      ) : (
        <>
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
            >
              {fmtPrice(book.mid)}
            </span>
            <span className="ob-spread num" title="Spread (best ask − best bid)">
              {book.spread != null ? `± ${fmtNum(book.spread)}` : ''}
              {book.spreadPct != null ? ` · ${book.spreadPct.toFixed(3)}%` : ''}
            </span>
          </div>
          <div className="ob-side bids">{bidRows.map((r) => row(r, 'bid', bidWall))}</div>
        </>
      )}
    </aside>
  )
}
