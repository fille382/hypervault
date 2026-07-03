import { useState } from 'react'
import { fmtSignedUsd, fmtNum, fmtPct, fmtPrice, coinLabel } from '../format.js'
import { closePosition } from '../api.js'
import CoinIcon from './CoinIcon.jsx'
import ReduceModal from './ReduceModal.jsx'
import AutoCloseModal from './AutoCloseModal.jsx'
import TradeHistory from './TradeHistory.jsx'

// Relative age ("now", "5m", "3h", "2d") so it's obvious at a glance how long
// ago a trade happened. The exact local timestamp is shown on hover.
const fmtFillTime = (ms) => {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

export default function AccountPanel({
  health,
  account,
  notify,
  refresh,
  fills = [],
  selectedCoin,
  onSelectCoin,
  onAddExposure,
  onLoadMoreFills,
  fillsMaxed,
}) {
  const [closing, setClosing] = useState(null)
  const [menuFor, setMenuFor] = useState(null) // coin whose manage menu is open
  const [menuUp, setMenuUp] = useState(false) // open the menu upward near the viewport bottom
  const [reduceFor, setReduceFor] = useState(null) // position being reduced
  const [autoFor, setAutoFor] = useState(null) // position whose auto-close is open
  const configured = !!health?.tradingConfigured
  const armed = !!health?.armed
  const positions = account?.positions || []

  const doClose = async (coin) => {
    setClosing(coin)
    try {
      await closePosition(coin)
      notify('ok', `Close order sent for ${coin}`)
      refresh()
    } catch (e) {
      notify('bad', e.message)
    } finally {
      setClosing(null)
    }
  }

  return (
    <aside className="rail">
      {configured && (
        <section className="panel card">
          <h3>My positions</h3>
          {positions.length === 0 ? (
            <div className="empty">No open positions yet. Mirror one from the vault →</div>
          ) : (
            positions.map((p) => {
              const pnlPos = (p.unrealizedPnl || 0) >= 0
              return (
                <div
                  className={`my-pos clickable${p.coin === selectedCoin ? ' selected' : ''}`}
                  key={p.coin}
                  title="Show on chart"
                  onClick={() => onSelectCoin?.(p.coin)}
                >
                  <div className="mp-info">
                    <CoinIcon coin={p.coin} size={26} />
                    <div>
                      <div className="mp-coin">
                        <span className={p.side === 'long' ? 'pos' : 'neg'} title={p.coin}>
                          {coinLabel(p.coin)}
                        </span>{' '}
                        <span className="faint">
                          {p.leverage}x {p.side}
                        </span>
                      </div>
                      <div className="mp-sub num">
                        {fmtNum(p.size)} ·{' '}
                        <span className={pnlPos ? 'pos' : 'neg'}>
                          {fmtSignedUsd(p.unrealizedPnl)} ({fmtPct(p.roe)})
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mp-actions">
                    <button
                      className="manage-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (menuFor !== p.coin) {
                          // Flip the menu upward when there isn't room below it.
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenuUp(window.innerHeight - r.bottom < 260)
                        }
                        setMenuFor((c) => (c === p.coin ? null : p.coin))
                      }}
                    >
                      {closing === p.coin ? '…' : 'Manage ▾'}
                    </button>
                    {menuFor === p.coin && (
                      <>
                        <div
                          className="dd-backdrop"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuFor(null)
                          }}
                        />
                        <div
                          className={`manage-menu${menuUp ? ' up' : ''}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="manage-item"
                            onClick={() => {
                              setMenuFor(null)
                              onAddExposure?.(p)
                            }}
                          >
                            <span className="mi-ic">+</span>
                            <span className="mi-text">
                              <span className="mi-t">Add exposure</span>
                              <span className="mi-d">Increase your {p.side} position</span>
                            </span>
                          </button>
                          <button
                            className="manage-item"
                            onClick={() => {
                              setMenuFor(null)
                              setReduceFor(p)
                            }}
                          >
                            <span className="mi-ic">−</span>
                            <span className="mi-text">
                              <span className="mi-t">Reduce exposure</span>
                              <span className="mi-d">Partially close the position</span>
                            </span>
                          </button>
                          <button
                            className="manage-item"
                            onClick={() => {
                              setMenuFor(null)
                              setAutoFor(p)
                            }}
                          >
                            <span className="mi-ic">◷</span>
                            <span className="mi-text">
                              <span className="mi-t">Auto close</span>
                              <span className="mi-d">Set take-profit / stop-loss</span>
                            </span>
                          </button>
                          <button
                            className="manage-item danger"
                            disabled={!armed || closing === p.coin}
                            onClick={() => {
                              setMenuFor(null)
                              doClose(p.coin)
                            }}
                          >
                            <span className="mi-ic">×</span>
                            <span className="mi-text">
                              <span className="mi-t">Close position</span>
                              <span className="mi-d">
                                {armed ? 'Market close everything' : 'Arm to enable closing'}
                              </span>
                            </span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </section>
      )}

      <TradeHistory
        configured={configured}
        address={account?.address}
        selectedCoin={selectedCoin}
        onSelectCoin={onSelectCoin}
      />

      <section className="panel card">
        <div className="card-head">
          <h3>Activity</h3>
          <span className="activity-window">all saved vaults · scroll for older</span>
        </div>
        {fills.length === 0 ? (
          <div className="activity-empty">
            No trades in the last 3 days from your saved vaults. New fills show up here (and as a
            toast) within ~20s.
          </div>
        ) : (
          <div
            className="activity-list"
            onScroll={(e) => {
              const el = e.currentTarget
              // Near the bottom — pull in older history.
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) onLoadMoreFills?.()
            }}
          >
            {fills.map((f) => (
              <div
                key={`${f.address}-${f.hash}-${f.time}-${f.sz}`}
                className={`activity-row clickable${f.coin === selectedCoin ? ' selected' : ''}`}
                title={`Show ${f.coin} on chart`}
                onClick={() => onSelectCoin?.(f.coin)}
              >
                <span className="act-time num" title={new Date(f.time).toLocaleString()}>
                  {fmtFillTime(f.time)}
                </span>
                <CoinIcon coin={f.coin} size={20} className="act-icon" />
                <div className="act-body">
                  <span className="act-vault" title={f.address}>
                    {f.vault}
                  </span>
                  <span className={`act-text ${f.side === 'buy' ? 'act-buy' : 'act-sell'}`}>
                    {f.dir || (f.side === 'buy' ? 'Buy' : 'Sell')} {fmtNum(f.sz)} {coinLabel(f.coin)}{' '}
                    @ {fmtPrice(f.px)}
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
            {fillsMaxed && <div className="activity-foot">— showing the last 30 days —</div>}
          </div>
        )}
      </section>

      {reduceFor && (
        <ReduceModal
          position={reduceFor}
          health={health}
          notify={notify}
          refresh={refresh}
          onClose={() => setReduceFor(null)}
        />
      )}
      {autoFor && (
        <AutoCloseModal
          position={autoFor}
          health={health}
          notify={notify}
          refresh={refresh}
          onClose={() => setAutoFor(null)}
        />
      )}
    </aside>
  )
}
