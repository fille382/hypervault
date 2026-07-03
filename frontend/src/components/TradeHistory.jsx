import { useCallback, useEffect, useRef, useState } from 'react'
import { getMyTrades } from '../api.js'
import { fmtNum, fmtPrice, fmtSignedUsd, shortAddr, coinLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

const POLL_MS = 30000
const PAGE = 80

// Relative age ("now", "5m", "3h", "2d"); exact local time is on hover.
const fmtAge = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

const mergeByTid = (a, b) => {
  const m = new Map()
  for (const t of a) m.set(t.tid, t)
  for (const t of b) if (!m.has(t.tid)) m.set(t.tid, t)
  return [...m.values()].sort((x, y) => y.time - x.time)
}

// Your own trade history, persisted server-side per connected address — a
// durable profile that outlives Hyperliquid's recent-fills window.
export default function TradeHistory({ configured, address, selectedCoin, onSelectCoin }) {
  const [trades, setTrades] = useState([])
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const noMoreRef = useRef(false)
  const busyRef = useRef(false)

  // Initial load + poll the newest fills (the server persists any new ones).
  useEffect(() => {
    if (!configured) {
      setTrades([])
      setTotal(0)
      noMoreRef.current = false
      return undefined
    }
    let cancelled = false
    const load = () =>
      getMyTrades(PAGE, 0)
        .then((r) => {
          if (cancelled) return
          setTotal(r.total || 0)
          setTrades((prev) => mergeByTid(r.trades || [], prev))
        })
        .catch(() => {})
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [configured, address])

  const loadOlder = useCallback(async () => {
    if (busyRef.current || noMoreRef.current || !trades.length) return
    busyRef.current = true
    setLoadingMore(true)
    try {
      const before = trades[trades.length - 1].time
      const r = await getMyTrades(PAGE, before)
      const older = r.trades || []
      setTrades((prev) => {
        const merged = mergeByTid(prev, older)
        if (merged.length === prev.length) noMoreRef.current = true // nothing older saved
        return merged
      })
    } catch {
      /* try again on next scroll */
    } finally {
      busyRef.current = false
      setLoadingMore(false)
    }
  }, [trades])

  if (!configured) return null

  return (
    <section className="panel card">
      <div className="card-head">
        <h3>Trade history</h3>
        <span className="activity-window" title={address}>
          {shortAddr(address)} · {total} saved
        </span>
      </div>
      {trades.length === 0 ? (
        <div className="activity-empty">
          No saved trades yet. Your fills are recorded here as you trade — and kept across sessions.
        </div>
      ) : (
        <div
          className="activity-list"
          onScroll={(e) => {
            const el = e.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) loadOlder()
          }}
        >
          {trades.map((f) => (
            <div
              key={f.tid}
              className={`activity-row clickable${f.coin === selectedCoin ? ' selected' : ''}`}
              title={`Show ${f.coin} on chart`}
              onClick={() => onSelectCoin?.(f.coin)}
            >
              <span className="act-time num" title={new Date(f.time).toLocaleString()}>
                {fmtAge(f.time)}
              </span>
              <CoinIcon coin={f.coin} size={20} className="act-icon" />
              <div className="act-body">
                <span className={`act-text ${f.side === 'buy' ? 'act-buy' : 'act-sell'}`}>
                  {f.dir || (f.side === 'buy' ? 'Buy' : 'Sell')} {fmtNum(f.sz)} {coinLabel(f.coin)} @{' '}
                  {fmtPrice(f.px)}
                  {f.closedPnl != null && Math.abs(f.closedPnl) >= 0.01 && (
                    <span className={f.closedPnl >= 0 ? 'pos' : 'neg'}>
                      {' '}
                      ({fmtSignedUsd(f.closedPnl)})
                    </span>
                  )}
                </span>
              </div>
            </div>
          ))}
          {loadingMore && <div className="activity-foot">loading…</div>}
          {noMoreRef.current && !loadingMore && (
            <div className="activity-foot">— end of saved history —</div>
          )}
        </div>
      )}
    </section>
  )
}
