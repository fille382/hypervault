import { useEffect, useState } from 'react'
import { fmtUsd, fmtSignedUsd } from '../format.js'
import { getMcapHistory } from '../api.js'
import McapChart from './McapChart.jsx'
import AccountCard from './AccountCard.jsx'

const fmtTrillions = (v) =>
  v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${(v / 1e9).toFixed(0)}B`

// Super-basic inline sparkline for the top bar chip.
function Sparkline({ points, width = 110, height = 30 }) {
  if (!points || points.length < 2) return null
  const vals = points.map((p) => p.value)
  const min = Math.min(...vals)
  const span = Math.max(...vals) - min || 1
  const step = width / (vals.length - 1)
  const d = vals
    .map(
      (v, i) =>
        `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`,
    )
    .join(' ')
  const up = vals[vals.length - 1] >= vals[0]
  return (
    <svg width={width} height={height} className="mcap-spark">
      <path d={d} fill="none" stroke={up ? '#34e2a8' : '#ff5d73'} strokeWidth="1.5" />
    </svg>
  )
}

export default function TopBar({
  health,
  account,
  mcap,
  online = true,
  onToggleArm,
  onNewTrade,
  notify,
  refresh,
}) {
  const [confirming, setConfirming] = useState(false)
  const [showMcap, setShowMcap] = useState(false)
  const [spark, setSpark] = useState(null)
  const [acctOpen, setAcctOpen] = useState(false)

  // 90 days of market cap for the chip's sparkline (backend caches upstream).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getMcapHistory('90')
        .then((d) => {
          if (!cancelled) setSpark(d.points || [])
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 1_800_000) // refresh every 30 min
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
  const armed = !!health?.armed
  const network = health?.network || '…'
  const ms = account?.marginSummary
  const capUp = (mcap?.change24h || 0) >= 0

  const handleToggle = () => {
    if (!armed) setConfirming(true) // arming requires confirmation
    else onToggleArm(false) // disarming is instant
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        <div>
          <div className="brand-name">Hypervault</div>
          <div className="brand-sub">Hyperliquid copy-trading</div>
        </div>
      </div>
      <span className={`net-pill ${network === 'testnet' ? 'testnet' : ''}`}>{network}</span>
      {!online && (
        <span className="offline-pill" title="Can't reach the backend (is it running on :8001?)">
          ● Backend offline — reconnecting…
        </span>
      )}

      {mcap?.marketCap != null && (
        <button
          className="mcap-chip"
          title="Total crypto market cap (90d) — click for the full chart"
          onClick={() => setShowMcap(true)}
        >
          <Sparkline points={spark} />
          <div>
            <div className="label">Crypto mkt cap</div>
            <div className="val num">
              {fmtTrillions(mcap.marketCap)}{' '}
              <span className={capUp ? 'pos' : 'neg'}>
                {capUp ? '▲' : '▼'}
                {Math.abs(mcap.change24h || 0).toFixed(2)}%
              </span>
            </div>
          </div>
        </button>
      )}

      <div className="topbar-spacer" />

      {onNewTrade && (
        <button className="mirror-btn" onClick={() => onNewTrade()}>
          + New trade
        </button>
      )}
      {/* Balance chip opens the full account card as a popover. Not connected
          yet? The same popover holds the connect form. */}
      <div className="acct-dd">
        <button
          className="equity-chip chip-btn"
          title={acctOpen ? 'Hide account details' : 'Show account details'}
          onClick={() => setAcctOpen((o) => !o)}
        >
          <div className="label">My balance {acctOpen ? '▴' : '▾'}</div>
          <div className="val num">
            {ms ? fmtUsd(ms.totalValue ?? ms.accountValue) : 'Connect'}
          </div>
        </button>
        {acctOpen && (
          <>
            <div className="dd-backdrop" onClick={() => setAcctOpen(false)} />
            <div className="acct-pop">
              <AccountCard health={health} account={account} notify={notify} refresh={refresh} />
            </div>
          </>
        )}
      </div>
      {ms && (
        <div className="equity-chip">
          <div className="label">Unrealized PnL</div>
          <div className={`val num ${(ms.totalUnrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}`}>
            {fmtSignedUsd(ms.totalUnrealizedPnl)}
          </div>
        </div>
      )}

      <div className={`arm ${armed ? 'live' : 'safe'}`}>
        <span className="arm-state">{armed ? 'ARMED' : 'SAFE'}</span>
        <button
          className={`toggle ${armed ? 'on' : ''}`}
          onClick={handleToggle}
          title={armed ? 'Disarm (back to SAFE)' : 'Arm live trading'}
        >
          <span className="knob" />
        </button>
      </div>

      {showMcap && <McapChart onClose={() => setShowMcap(false)} />}

      {confirming && (
        <div className="overlay" onClick={() => setConfirming(false)}>
          <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">Arm live trading?</div>
              <button className="x-btn" onClick={() => setConfirming(false)}>
                ×
              </button>
            </div>
            <p className="note">
              Orders will be sent to your <b>real {network} account</b> and executed with real
              funds. The size guardrail and per-order confirmation still apply.
            </p>
            <button
              className="submit live"
              onClick={() => {
                setConfirming(false)
                onToggleArm(true)
              }}
            >
              Yes, arm live orders
            </button>
            <button className="linkish" style={{ marginTop: 12 }} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
