import { useState } from 'react'
import { reducePosition, closePosition } from '../api.js'
import { fmtNum, fmtUsd, fmtPx, coinLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

const PCTS = [25, 50, 75, 100]

// Reduce (partially close) an open position by a percentage of its size.
export default function ReduceModal({ position, health, notify, refresh, onClose }) {
  const [pct, setPct] = useState(50)
  const [submitting, setSubmitting] = useState(false)
  const armed = !!health?.armed
  const size = position.size || 0
  const markPx = position.markPx
  const reduceSize = (size * pct) / 100
  const reduceUsd = markPx ? reduceSize * markPx : null

  const submit = async () => {
    setSubmitting(true)
    try {
      // 100% is a plain full close (avoids rounding leaving dust behind).
      if (pct >= 100) await closePosition(position.coin)
      else await reducePosition(position.coin, reduceSize)
      notify('ok', `Reduced ${coinLabel(position.coin)} by ${pct}%`)
      refresh()
      onClose()
    } catch (e) {
      notify('bad', e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <CoinIcon coin={position.coin} size={20} /> Reduce {coinLabel(position.coin)}
          </div>
          <button className="x-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="field">
          <div className="label">
            <span>Amount to close</span>
            <span>
              {position.leverage}x {position.side}
            </span>
          </div>
          <div className="pct-row">
            {PCTS.map((p) => (
              <button
                key={p}
                className={`pct-opt ${pct === p ? 'active' : ''}`}
                onClick={() => setPct(p)}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
          </div>
          <input
            className="range"
            type="range"
            min="1"
            max="100"
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
          />
        </div>

        <div className="summary">
          <div className="line">
            <span className="k">Closing</span>
            <span className="num">
              {fmtNum(reduceSize)} {coinLabel(position.coin)} ({pct}%)
            </span>
          </div>
          <div className="line">
            <span className="k">Est. value</span>
            <span className="num">{reduceUsd != null ? fmtUsd(reduceUsd) : '—'}</span>
          </div>
          <div className="line">
            <span className="k">Mark price</span>
            <span className="num">{fmtPx(markPx)}</span>
          </div>
        </div>

        <button
          className={`submit ${armed ? 'live' : 'safe'}`}
          disabled={!armed || submitting}
          onClick={submit}
        >
          {submitting
            ? 'Sending…'
            : pct >= 100
              ? `Close all ${coinLabel(position.coin)}`
              : `Reduce ${pct}% — market sell`}
        </button>
        {!armed && (
          <div className="note warn">Flip ARM in the top bar to reduce or close positions.</div>
        )}
      </div>
    </div>
  )
}
