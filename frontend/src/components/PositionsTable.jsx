import { fmtNum, fmtSignedUsd, fmtPct, fmtUsd, fmtPrice, coinLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '')

// Hyperliquid's expanded positions view: Coin · Size · Position Value · Entry ·
// Mark · PNL (ROE %) · Liq. Price · Margin · Funding, plus a Mirror action.
export default function PositionsTable({ positions, onMirror, selectedCoin, onSelectCoin }) {
  return (
    <div className="table-scroll">
      <div className="table-inner">
        <div className="col-head">
          <span>Coin</span>
          <span>Size</span>
          <span>Position Value</span>
          <span>Entry Price</span>
          <span>Mark Price</span>
          <span>PNL (ROE %)</span>
          <span>Liq. Price</span>
          <span>Margin</span>
          <span>Funding</span>
          <span />
        </div>
        <div className="rows">
          {positions.map((p) => {
            const pnlPos = (p.unrealizedPnl || 0) >= 0
            const fundPos = (p.funding || 0) >= 0
            return (
              <div
                className={`pos-row side-${p.side}${p.coin === selectedCoin ? ' selected' : ''}`}
                key={p.coin}
                onClick={() => onSelectCoin?.(p.coin)}
              >
                <div className={`coin-cell side-${p.side}`}>
                  <CoinIcon coin={p.coin} size={20} />
                  <span className="side-arrow" title={p.side}>
                    {p.side === 'long' ? '▲' : '▼'}
                  </span>
                  <span className="coin-sym" title={p.coin}>
                    {coinLabel(p.coin)}
                  </span>
                  {p.leverage != null && <span className="lev-badge">{p.leverage}x</span>}
                </div>
                <div className={`cell num side-${p.side}`}>
                  {fmtNum(p.size)} <span className="u">{coinLabel(p.coin)}</span>
                </div>
                <div className="cell num">
                  {p.positionValue != null ? `${fmtNum(p.positionValue, 2)} USDC` : '—'}
                </div>
                <div className="cell num">{fmtPrice(p.entryPx)}</div>
                <div className="cell num">{fmtPrice(p.markPx)}</div>
                <div className="cell num pnl-roe">
                  <span className={pnlPos ? 'pos' : 'neg'}>{fmtSignedUsd(p.unrealizedPnl)}</span>
                  <span className={`roe ${pnlPos ? 'pos' : 'neg'}`}>({fmtPct(p.roe)})</span>
                </div>
                <div className="cell num">{fmtPrice(p.liquidationPx)}</div>
                <div className="cell num">
                  {fmtUsd(p.marginUsed)} <span className="u">({cap(p.leverageType)})</span>
                </div>
                <div className={`cell num ${fundPos ? 'pos' : 'neg'}`}>{fmtSignedUsd(p.funding)}</div>
                <div className="row-action">
                  <button
                    className="mirror-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMirror(p)
                    }}
                  >
                    Mirror
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
