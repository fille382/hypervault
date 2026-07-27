import { useMemo, useState } from 'react'
import { coinLabel, dexLabel, fmtPx, fmtPct } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

// The chart-header coin switcher: the coin icon + name is a button that drops
// down a searchable list of every market, biggest first (same open-interest
// ranking as the All-markets list), so you can jump charts without scrolling
// down the page. Enter picks the top match, Esc closes.
export default function CoinPicker({ coin, meta = {}, onSelectCoin }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    if (!open) return []
    const needle = q.trim().toLowerCase()
    const out = []
    for (const [c, m] of Object.entries(meta)) {
      const label = coinLabel(c)
      if (needle && !c.toLowerCase().includes(needle) && !label.toLowerCase().includes(needle)) {
        continue
      }
      const chg = m.markPx && m.prevDayPx ? (m.markPx - m.prevDayPx) / m.prevDayPx : null
      out.push({
        coin: c,
        label,
        dex: m.dex || '',
        markPx: m.markPx,
        chg,
        size: m.oiUsd ?? m.dayNtlVlm ?? 0,
      })
    }
    out.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))
    return out
  }, [meta, q, open])

  const close = () => {
    setOpen(false)
    setQ('')
  }
  const pick = (c) => {
    onSelectCoin?.(c)
    close()
  }

  return (
    <span className="coin-picker">
      <button
        className="coin-picker-btn"
        title="Switch coin"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <CoinIcon coin={coin} size={22} className="ct-icon" />
        <span className="ct-coin" title={coin}>
          {coinLabel(coin)}
        </span>
        <span className="dd-caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <div className="coin-dd-backdrop" onClick={close} />
          <div className="coin-dd">
            <input
              className="market-search"
              autoFocus
              placeholder="Search markets… (BTC, GOLD, SPACEX)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') close()
                if (e.key === 'Enter' && rows.length) pick(rows[0].coin)
              }}
            />
            <div className="coin-dd-scroll">
              {rows.map((r) => (
                <div
                  key={r.coin}
                  className={`market-row${r.coin === coin ? ' active' : ''}`}
                  onClick={() => pick(r.coin)}
                >
                  <span className="m-name">
                    <CoinIcon coin={r.coin} size={18} />
                    {r.label}
                    {r.dex && <span className="m-dex">{dexLabel(r.dex)}</span>}
                  </span>
                  <span className="m-px num">{fmtPx(r.markPx)}</span>
                  <span className={`m-chg num ${(r.chg || 0) >= 0 ? 'pos' : 'neg'}`}>
                    {fmtPct(r.chg)}
                  </span>
                </div>
              ))}
              {!rows.length && <div className="dd-empty">No markets match “{q}”.</div>}
            </div>
          </div>
        </>
      )}
    </span>
  )
}
