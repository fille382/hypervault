import { fmtNum, fmtSignedUsd, fmtPct } from '../format.js'

// The vault positions list, styled like Hyperliquid's Positions tab, with a
// "Mirror" action that opens the trade modal prefilled for that coin/side.
export default function PositionsTable({ positions, onMirror }) {
  return (
    <div className="rows">
      {positions.map((p) => {
        const pnlPos = (p.unrealizedPnl || 0) >= 0
        return (
          <div className="pos-row" key={p.coin}>
            <div className={`coin-cell side-${p.side}`}>
              <span className="coin-sym">{p.coin}</span>
              {p.leverage != null && <span className="lev-badge">{p.leverage}x</span>}
              <span className="side-flag">{p.side}</span>
            </div>

            <div className="size-cell num">
              <span className="v">{fmtNum(p.size)}</span>
              <span className="u">{p.coin}</span>
            </div>

            <div className="pnl-cell num">
              <span className={pnlPos ? 'pos' : 'neg'}>{fmtSignedUsd(p.unrealizedPnl)}</span>
              <span className={`roe ${pnlPos ? 'pos' : 'neg'}`}>{fmtPct(p.roe)}</span>
            </div>

            <div className="row-action">
              <button className="mirror-btn" onClick={() => onMirror(p)}>
                Mirror
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
