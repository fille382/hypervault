import { useState } from 'react'
import { fmtUsd, fmtSignedUsd, fmtNum, shortAddr } from '../format.js'
import { clearCredentials } from '../api.js'
import ConnectForm from './ConnectForm.jsx'
import CoinIcon from './CoinIcon.jsx'

// The "My account" card: balances + connect/disconnect. Lives in the top-bar
// balance popover (it used to be the top card of the right sidebar).
export default function AccountCard({ health, account, notify, refresh }) {
  const [disconnecting, setDisconnecting] = useState(false)
  const configured = !!health?.tradingConfigured
  const ms = account?.marginSummary
  const spotBalances = account?.spotBalances || []

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
                  <span className="sb-coin">
                    <CoinIcon coin={b.coin} size={16} />
                    {b.coin}
                  </span>
                  <span className="num faint">{fmtNum(b.total)}</span>
                  <span className="num">{b.usd != null ? fmtUsd(b.usd) : '—'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
