import { useEffect, useState } from 'react'
import { fmtUsd, fmtSignedUsd } from '../format.js'
import { getCandles } from '../api.js'
import BtcChart from './BtcChart.jsx'
import AccountCard from './AccountCard.jsx'

const fmtBtcPx = (v) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// One-liner that clones the repo, sets up the venv, registers hypervault://
// and starts the backend — for visitors who don't have the backend yet.
const INSTALL_CMD =
  'irm https://raw.githubusercontent.com/fille382/hypervault/master/scripts/install.ps1 | iex'

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
    <svg width={width} height={height} className="btc-spark">
      <path d={d} fill="none" stroke={up ? '#34e2a8' : '#ff5d73'} strokeWidth="1.5" />
    </svg>
  )
}

export default function TopBar({
  health,
  account,
  btc,
  online = true,
  onToggleArm,
  onNewTrade,
  notify,
  refresh,
}) {
  const [confirming, setConfirming] = useState(false)
  const [showBtc, setShowBtc] = useState(false)
  const [spark, setSpark] = useState(null)
  const [acctOpen, setAcctOpen] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyInstallCmd = () => {
    navigator.clipboard
      ?.writeText(INSTALL_CMD)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  // 90 days of BTC daily closes for the chip's sparkline — same Hyperliquid
  // candle feed (and local cache) as the coin chart.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getCandles('BTC', '1d', 90)
        .then((d) => {
          if (cancelled) return
          const points = (d.candles || [])
            .filter((c) => c.close != null)
            .map((c) => ({ time: c.time, value: c.close }))
          setSpark(points)
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 1_800_000) // refresh every 30 min
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
  // The install popup has done its job once the backend answers — close it
  // and confirm, instead of leaving the setup instructions on screen.
  useEffect(() => {
    if (online && showInstall) {
      setShowInstall(false)
      notify('ok', 'Backend connected')
    }
  }, [online, showInstall, notify])

  const armed = !!health?.armed
  const network = health?.network || '…'
  const ms = account?.marginSummary
  const btcUp = (btc?.change24h || 0) >= 0

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
          ● Backend offline — reconnecting…{' '}
          <a
            className="start-backend-link"
            href="hypervault://start"
            title="Launches the backend on this PC. Needs the one-time hypervault:// registration — run scripts/register-backend-protocol.ps1."
          >
            ▶ start backend
          </a>{' '}
          ·{' '}
          <button
            className="start-backend-link install-link"
            title="First time here? One-line install of the backend on this PC."
            onClick={() => setShowInstall(true)}
          >
            ⤓ install
          </button>
        </span>
      )}

      {btc?.price != null && (
        <button
          className="btc-chip"
          title="Bitcoin (90d, Hyperliquid) — click for the full chart"
          onClick={() => setShowBtc(true)}
        >
          <Sparkline points={spark} />
          <div>
            <div className="label">BTC / USD</div>
            <div className="val num">
              {fmtBtcPx(btc.price)}{' '}
              <span className={btcUp ? 'pos' : 'neg'}>
                {btcUp ? '▲' : '▼'}
                {Math.abs(btc.change24h || 0).toFixed(2)}%
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

      {showBtc && <BtcChart onClose={() => setShowBtc(false)} />}

      {showInstall && (
        <div className="overlay" onClick={() => setShowInstall(false)}>
          <div className="modal" style={{ width: 540 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">Install the backend</div>
              <button className="x-btn" onClick={() => setShowInstall(false)}>
                ×
              </button>
            </div>
            <p className="note">
              This site is just the UI — market data and trading run through a small backend on{' '}
              <b>your own PC</b>, so your keys and orders never touch a server. One-time setup:
              paste this into a <b>PowerShell</b> window (Win+R, type <code>powershell</code>,
              Enter):
            </p>
            <div className="cmd-box">
              <code className="num">{INSTALL_CMD}</code>
              <button className="copy-btn" onClick={copyInstallCmd}>
                {copied ? '✓ copied' : 'copy'}
              </button>
            </div>
            <p className="note">
              It installs to <code>%USERPROFILE%\hypervault</code> (needs <b>git</b> and{' '}
              <b>Python 3.11+</b>), starts the backend, and registers the{' '}
              <b>▶ start backend</b> link so next time is one click. This popup closes by
              itself once the backend is running. Trading needs your
              API-wallet key added afterwards — the viewer works without one. Prefer manual
              setup? See the{' '}
              <a
                href="https://github.com/fille382/hypervault#setup"
                target="_blank"
                rel="noreferrer"
              >
                README
              </a>
              .
            </p>
          </div>
        </div>
      )}

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
