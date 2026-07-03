import { useMemo, useState } from 'react'
import { coinLabel, dexLabel, fmtPx, fmtPct } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

// Browsable list of every tradeable market — main-dex coins plus HIP-3 builder
// markets (xyz:GOLD, vntl:SPACEX, …). Click a row to chart it; "Trade" opens
// the order ticket. Collapsed by default to keep the vault panel uncluttered.
export default function MarketList({ meta, selectedCoin, onSelectCoin, onTradeCoin }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const byDex = {}
    for (const [coin, m] of Object.entries(meta)) {
      const label = coinLabel(coin)
      if (needle && !coin.toLowerCase().includes(needle) && !label.toLowerCase().includes(needle)) {
        continue
      }
      const chg = m.markPx && m.prevDayPx ? (m.markPx - m.prevDayPx) / m.prevDayPx : null
      ;(byDex[m.dex || ''] ||= []).push({ coin, label, markPx: m.markPx, chg })
    }
    for (const d in byDex) byDex[d].sort((a, b) => a.label.localeCompare(b.label))
    return Object.entries(byDex).sort(([a], [b]) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
    )
  }, [meta, q])

  const total = Object.keys(meta).length
  if (!total) return null

  return (
    <div className="markets">
      <button className="markets-head" onClick={() => setOpen((o) => !o)}>
        <span>
          All markets <span className="count">({total})</span>
        </span>
        <span className="dd-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <>
          <input
            className="market-search"
            placeholder="Search markets… (BTC, GOLD, SPACEX, TSLA)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="market-scroll">
            {groups.map(([dex, items]) => (
              <div key={dex || 'main'} className="market-group">
                <div className="market-group-head">
                  {dexLabel(dex)} <span className="count">({items.length})</span>
                </div>
                {items.map((r) => (
                  <div
                    key={r.coin}
                    className={`market-row${r.coin === selectedCoin ? ' active' : ''}`}
                    onClick={() => onSelectCoin(r.coin)}
                  >
                    <span className="m-name">
                      <CoinIcon coin={r.coin} size={18} />
                      {r.label}
                    </span>
                    <span className="m-px num">{fmtPx(r.markPx)}</span>
                    <span className={`m-chg num ${(r.chg || 0) >= 0 ? 'pos' : 'neg'}`}>
                      {fmtPct(r.chg)}
                    </span>
                    <button
                      className="m-trade"
                      onClick={(e) => {
                        e.stopPropagation()
                        onTradeCoin(r.coin)
                      }}
                    >
                      Trade
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {!groups.length && <div className="dd-empty">No markets match “{q}”.</div>}
          </div>
        </>
      )}
    </div>
  )
}
