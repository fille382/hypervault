import { useState } from 'react'
import { fmtUsd, fmtSignedUsd, fmtNum, fmtPct, shortAddr } from '../format.js'
import { closePosition, clearCredentials } from '../api.js'
import ConnectForm from './ConnectForm.jsx'

export default function AccountPanel({ health, account, notify, refresh }) {
  const [closing, setClosing] = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const configured = !!health?.tradingConfigured
  const armed = !!health?.armed
  const ms = account?.marginSummary
  const positions = account?.positions || []
  const spotBalances = account?.spotBalances || []

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

  const doDisconnect = async () => {
    setDisconnecting(true)
    try {
      await clearCredentials()
      notify('ok', 'Disconnected — credentials cleared')
      refresh()
    } catch (e) {
      notify('bad', e.message)
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <aside className="rail">
      <section className="panel card">
        <div className="card-head">
          <h3>My account</h3>
          {configured && (
            <button className="linkish" disabled={disconnecting} onClick={doDisconnect}>
              {disconnecting ? '…' : 'Disconnect'}
            </button>
          )}
        </div>

        {!configured ? (
          <ConnectForm
            network={health?.network}
            onConnected={(r) => {
              notify(
                'ok',
                `Connected ${shortAddr(r.accountAddress)}${r.persisted ? '' : ' (this session only)'}`,
              )
              refresh()
            }}
            onError={(m) => notify('bad', m)}
          />
        ) : (
          <>
            <div className="equity-big num">{fmtUsd(ms?.totalValue ?? ms?.accountValue)}</div>
            <div className="acct-sub">{shortAddr(account?.address)} · total balance</div>
            <div className="acct-grid">
              <div>
                <div className="label">Perp equity</div>
                <div className="val num">{fmtUsd(ms?.perpAccountValue ?? ms?.accountValue)}</div>
              </div>
              <div>
                <div className="label">Spot value</div>
                <div className="val num">{fmtUsd(ms?.spotUsd)}</div>
              </div>
              <div>
                <div className="label">Perp uPnL</div>
                <div className={`val num ${(ms?.totalUnrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}`}>
                  {fmtSignedUsd(ms?.totalUnrealizedPnl)}
                </div>
              </div>
              <div>
                <div className="label">Withdrawable</div>
                <div className="val num">{fmtUsd(ms?.withdrawable)}</div>
              </div>
            </div>
            {spotBalances.length > 0 && (
              <div className="spot-list">
                <div className="spot-head">Spot balances</div>
                {spotBalances.map((b) => (
                  <div className="spot-row" key={b.coin}>
                    <span className="sb-coin">{b.coin}</span>
                    <span className="num faint">{fmtNum(b.total)}</span>
                    <span className="num">{b.usd != null ? fmtUsd(b.usd) : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {configured && (
        <section className="panel card">
          <h3>My positions</h3>
          {positions.length === 0 ? (
            <div className="empty">No open positions yet. Mirror one from the vault →</div>
          ) : (
            positions.map((p) => {
              const pnlPos = (p.unrealizedPnl || 0) >= 0
              return (
                <div className="my-pos" key={p.coin}>
                  <div>
                    <div className="mp-coin">
                      <span className={p.side === 'long' ? 'pos' : 'neg'}>{p.coin}</span>{' '}
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
                  <button
                    className="close-btn"
                    disabled={!armed || closing === p.coin}
                    onClick={() => doClose(p.coin)}
                    title={armed ? 'Market close position' : 'Arm to enable closing'}
                  >
                    {closing === p.coin ? '…' : 'Close'}
                  </button>
                </div>
              )
            })
          )}
        </section>
      )}
    </aside>
  )
}
