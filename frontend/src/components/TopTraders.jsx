import { useEffect, useMemo, useRef, useState } from 'react'
import { getLeaderboard, getTraderProfile } from '../api.js'
import {
  fmtDuration,
  fmtPct,
  fmtUsd,
  fmtUsdCompact,
  shortAddr,
  coinLabel,
} from '../format.js'
import CoinIcon from './CoinIcon.jsx'

// Discovery for the follow feature: Hyperliquid's own leaderboard, ranked by
// window PnL/ROI/volume. Every row is a plain wallet address — following one
// gives it the full vault treatment (positions, fills, chart dots, toasts).
const WINDOWS = [
  { key: 'day', label: '24h' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'allTime', label: 'All' },
]
const SORTS = [
  { key: 'pnl', label: 'PnL' },
  { key: 'roi', label: 'ROI' },
  { key: 'vlm', label: 'Volume' },
]
const MIN_EQUITY = [
  { value: 0, label: 'Any equity' },
  { value: 10_000, label: '≥ $10k' },
  { value: 100_000, label: '≥ $100k' },
  { value: 1_000_000, label: '≥ $1M' },
]

function Sparkline({ points }) {
  // points: [[ms, pnl], ...] — index-spaced x (points are ~evenly timed).
  if (!points || points.length < 2) return null
  const w = 240
  const h = 40
  const vals = points.map((p) => p[1])
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const pts = vals
    .map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`)
    .join(' ')
  const up = vals[vals.length - 1] >= 0
  return (
    <svg className="lb-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={pts}
        fill="none"
        stroke={up ? 'var(--green)' : 'var(--red)'}
        strokeWidth="1.5"
      />
    </svg>
  )
}

function ProfileRow({ address, window: win, profile }) {
  if (profile === 'loading') return <div className="lb-profile spin">Loading trader stats…</div>
  if (!profile || profile === 'error')
    return <div className="lb-profile faint">Couldn’t load stats for this trader.</div>
  const s = profile.stats
  const pf = profile.portfolio?.[win]
  return (
    <div className="lb-profile">
      <div className="lb-profile-stats num">
        <span
          title={
            s?.winRateBasis === 'closes'
              ? 'Share of profitable closing fills — this trader scales in/out without flattening, so full round trips are rare'
              : 'Share of profitable round trips (open → flat)'
          }
        >
          <b>{s?.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : '—'}</b> win rate
          {s?.winRateBasis === 'closes' ? ' (per close)' : ''}
        </span>
        <span>
          <b>{s?.roundTrips ?? '—'}</b> round trips
        </span>
        <span>
          <b>{s?.avgHoldMs != null ? fmtDuration(s.avgHoldMs) : '—'}</b> avg hold
        </span>
        {profile.isVault && <span className="lb-vault-tag">Vault{profile.vaultName ? ` · ${profile.vaultName}` : ''}</span>}
      </div>
      {s?.topCoins?.length > 0 && (
        <div className="lb-top-coins">
          {s.topCoins.map((c) => (
            <span key={c.coin} className="lb-coin-chip" title={`${fmtUsd(c.notional, 0)} traded recently`}>
              <CoinIcon coin={c.coin} size={14} /> {coinLabel(c.coin)}
            </span>
          ))}
        </div>
      )}
      {pf?.pnlHistory?.length > 1 && (
        <div className="lb-spark-wrap" title="PnL over the selected window">
          <Sparkline points={pf.pnlHistory} />
        </div>
      )}
      <div className="lb-profile-note faint">
        Stats from this wallet’s recent fills (up to 2000) · {shortAddr(address)}
      </div>
    </div>
  )
}

export default function TopTraders({
  onClose,
  savedVaults = [],
  activeAddress,
  onFollow,
  onUnfollow,
  onView,
}) {
  const [win, setWin] = useState('week') // MetaMask ranks by 7-day PnL; same default
  const [sort, setSort] = useState('pnl')
  const [minEq, setMinEq] = useState(10_000)
  const [rows, setRows] = useState(null) // null = first load in flight
  const [meta, setMeta] = useState(null) // {updatedAt, stale}
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null) // address | null
  const [profiles, setProfiles] = useState({}) // addr -> profile | 'loading' | 'error'
  const [reload, setReload] = useState(0) // bumped by the retry button
  const [now, setNow] = useState(() => Date.now()) // ticks so "updated Xm ago" stays honest
  const reqRef = useRef(0)
  const pressOnBackdrop = useRef(false) // so a drag that ENDS on the overlay doesn't close it

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const req = ++reqRef.current
    setLoading(true)
    setError(null)
    getLeaderboard(win, sort, 10, minEq)
      .then((r) => {
        if (reqRef.current !== req) return // a newer filter combo superseded this
        setRows(r.traders || [])
        setMeta({ updatedAt: r.updatedAt, stale: r.stale })
        setLoading(false)
      })
      .catch((e) => {
        if (reqRef.current !== req) return
        setError(e.message)
        setLoading(false)
      })
  }, [win, sort, minEq, reload])

  const followed = useMemo(() => {
    const set = new Set(savedVaults.map((s) => s.address.toLowerCase()))
    return set
  }, [savedVaults])

  const toggleExpand = (addr) => {
    const next = expanded === addr ? null : addr
    setExpanded(next)
    // 'error' is retried on the next expand; a loaded profile is kept.
    if (next && (!profiles[addr] || profiles[addr] === 'error')) {
      setProfiles((p) => ({ ...p, [addr]: 'loading' }))
      getTraderProfile(addr)
        .then((prof) => setProfiles((p) => ({ ...p, [addr]: prof })))
        .catch(() => setProfiles((p) => ({ ...p, [addr]: 'error' })))
    }
  }

  const updatedAgo = useMemo(() => {
    if (!meta?.updatedAt) return null
    const mins = Math.max(0, Math.round((now - meta.updatedAt) / 60000))
    return mins < 1 ? 'just now' : `${mins}m ago`
  }, [meta, now])

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        // Close only for a true backdrop click — not a text-selection drag
        // that started inside the modal and released over the backdrop.
        if (pressOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            🏆 Top traders
            <span className="lb-sub faint">Hyperliquid leaderboard</span>
          </div>
          <button className="x-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="lb-controls">
          <div className="lb-chip-group">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                className={`lb-chip${win === w.key ? ' active' : ''}`}
                onClick={() => setWin(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="lb-chip-group">
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={`lb-chip${sort === s.key ? ' active' : ''}`}
                onClick={() => setSort(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <select
            className="select lb-mineq"
            value={minEq}
            onChange={(e) => setMinEq(Number(e.target.value))}
          >
            {MIN_EQUITY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="lb-scroll">
          <div className="lb-table-head num">
            <span className="lb-c-rank">#</span>
            <span className="lb-c-trader">Trader</span>
            <span className="lb-c-num">Equity</span>
            <span className="lb-c-num">PnL ({WINDOWS.find((w) => w.key === win)?.label})</span>
            <span className="lb-c-num">ROI ({WINDOWS.find((w) => w.key === win)?.label})</span>
            <span className="lb-c-num">Volume ({WINDOWS.find((w) => w.key === win)?.label})</span>
            <span className="lb-c-act" />
          </div>

          <div className={`lb-rows${loading && rows ? ' lb-dim' : ''}`}>
          {error ? (
            <div className="lb-msg">
              Couldn’t load the leaderboard — {error}
              <button className="linkish" onClick={() => setReload((n) => n + 1)} style={{ marginLeft: 8 }}>
                retry
              </button>
            </div>
          ) : rows == null ? (
            <div className="lb-msg spin">Loading top traders… the first load can take ~30s.</div>
          ) : rows.length === 0 ? (
            <div className="lb-msg">No traders match these filters.</div>
          ) : (
            rows.map((t) => {
              const isFollowed = followed.has(t.address.toLowerCase())
              const isActive = activeAddress && t.address.toLowerCase() === activeAddress.toLowerCase()
              return (
                <div key={t.address}>
                  <div
                    className={`lb-row num${expanded === t.address ? ' expanded' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded === t.address}
                    onClick={() => toggleExpand(t.address)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleExpand(t.address)
                      }
                    }}
                  >
                    <span className="lb-c-rank faint">{t.rank}</span>
                    <span className="lb-c-trader">
                      <span className="lb-name">{t.name || shortAddr(t.address)}</span>
                      {t.name && <span className="lb-addr">{shortAddr(t.address)}</span>}
                    </span>
                    <span className="lb-c-num" title={fmtUsd(t.accountValue)}>
                      {fmtUsdCompact(t.accountValue)}
                    </span>
                    <span
                      className={`lb-c-num ${t.pnl >= 0 ? 'pos' : 'neg'}`}
                      title={fmtUsd(t.pnl)}
                    >
                      {fmtUsdCompact(t.pnl, true)}
                    </span>
                    <span className={`lb-c-num ${t.roi == null ? '' : t.roi >= 0 ? 'pos' : 'neg'}`}>
                      {fmtPct(t.roi)}
                    </span>
                    <span className="lb-c-num" title={fmtUsd(t.vlm)}>
                      {fmtUsdCompact(t.vlm)}
                    </span>
                    <span className="lb-c-act" onClick={(e) => e.stopPropagation()}>
                      {isFollowed ? (
                        <button
                          className="lb-btn following"
                          disabled={isActive}
                          title={
                            isActive
                              ? 'You’re viewing this trader — switch to another vault to unfollow'
                              : 'Click to unfollow'
                          }
                          onClick={() => onUnfollow(t.address)}
                        >
                          ✓ Following
                        </button>
                      ) : (
                        <button
                          className="lb-btn"
                          onClick={() => onFollow(t.address, t.name)}
                        >
                          Follow
                        </button>
                      )}
                      <button
                        className={`lb-btn view${isActive ? ' active' : ''}`}
                        title="Open this trader in the dashboard"
                        onClick={() => onView(t.address)}
                      >
                        {isActive ? 'Viewing' : 'View'}
                      </button>
                    </span>
                  </div>
                  {expanded === t.address && (
                    <ProfileRow address={t.address} window={win} profile={profiles[t.address]} />
                  )}
                </div>
              )
            })
          )}
          </div>
        </div>

        <div className="lb-foot faint">
          {updatedAgo && <span>Updated {updatedAgo}{meta?.stale ? ' (stale — refresh failing)' : ''} · </span>}
          Follow adds a trader to your feed — trades toast live and show on the chart. Past
          performance doesn’t predict future results.
        </div>
      </div>
    </div>
  )
}
