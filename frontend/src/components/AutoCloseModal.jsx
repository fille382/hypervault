import { useState } from 'react'
import { setTpsl } from '../api.js'
import { fmtPx, fmtPrice, coinLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

const TP_PRESETS = [10, 25, 50, 100]
const SL_PRESETS = [5, 10, 25, 50]

const fixPx = (n) => (Number.isFinite(n) ? String(Number(n.toPrecision(6))) : '')
const fixPct = (n) => (Number.isFinite(n) ? String(Number(n.toFixed(2))) : '')

// Auto close: set reduce-only take-profit / stop-loss trigger orders that close
// the position when price crosses the trigger. The % field is gain/loss on
// margin (ROE); the $ field is the trigger price — the two are linked.
export default function AutoCloseModal({ position, health, notify, refresh, onClose }) {
  const isLong = position.side === 'long'
  const entry = position.entryPx
  const lev = position.leverage || 1
  const armed = !!health?.armed

  // ROE% -> trigger price and back, accounting for direction + leverage.
  const roeToPx = (roe) => {
    const frac = roe / 100 / lev
    return isLong ? entry * (1 + frac) : entry * (1 - frac)
  }
  const pxToRoe = (px) => (isLong ? px / entry - 1 : 1 - px / entry) * lev * 100

  const [tpPrice, setTpPrice] = useState('')
  const [tpPct, setTpPct] = useState('')
  const [slPrice, setSlPrice] = useState('')
  const [slPct, setSlPct] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const onTpPrice = (v) => {
    setTpPrice(v)
    const n = parseFloat(v)
    setTpPct(entry && Number.isFinite(n) ? fixPct(pxToRoe(n)) : '')
  }
  const onTpPct = (v) => {
    setTpPct(v)
    const n = parseFloat(v)
    setTpPrice(entry && Number.isFinite(n) ? fixPx(roeToPx(n)) : '')
  }
  const onSlPrice = (v) => {
    setSlPrice(v)
    const n = parseFloat(v)
    setSlPct(entry && Number.isFinite(n) ? fixPct(pxToRoe(n)) : '')
  }
  const onSlPct = (v) => {
    setSlPct(v)
    const n = parseFloat(v)
    setSlPrice(entry && Number.isFinite(n) ? fixPx(roeToPx(n)) : '')
  }

  const tpPx = parseFloat(tpPrice)
  const slPx = parseFloat(slPrice)
  const hasTp = Number.isFinite(tpPx) && tpPx > 0
  const hasSl = Number.isFinite(slPx) && slPx > 0

  // TP must be on the profit side of entry, SL on the loss side.
  const tpWrong = hasTp && (isLong ? tpPx <= entry : tpPx >= entry)
  const slWrong = hasSl && (isLong ? slPx >= entry : slPx <= entry)
  const invalid = (!hasTp && !hasSl) || tpWrong || slWrong

  const submit = async () => {
    setSubmitting(true)
    try {
      await setTpsl({
        coin: position.coin,
        isLong,
        size: position.size,
        takeProfitPx: hasTp ? tpPx : null,
        stopLossPx: hasSl ? slPx : null,
      })
      notify(
        'ok',
        `Auto-close set on ${coinLabel(position.coin)}${hasTp ? ` · TP ${fmtPrice(tpPx)}` : ''}${
          hasSl ? ` · SL ${fmtPrice(slPx)}` : ''
        }`,
      )
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
            <CoinIcon coin={position.coin} size={20} /> Auto close · {coinLabel(position.coin)}
          </div>
          <button className="x-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ac-ref">
          <span>
            Entry <b className="num">{fmtPrice(entry)}</b>
          </span>
          <span>
            Mark <b className="num">{fmtPrice(position.markPx)}</b>
          </span>
          <span>
            {lev}x {position.side}
          </span>
        </div>

        <div className="field">
          <div className="label">
            <span>Take profit</span>
            <span className="faint">gain on margin</span>
          </div>
          <div className="preset-row">
            {TP_PRESETS.map((p) => (
              <button
                key={p}
                className={`preset-opt pos ${tpPct === String(p) ? 'active' : ''}`}
                onClick={() => onTpPct(p)}
              >
                +{p}%
              </button>
            ))}
          </div>
          <div className="ac-inputs">
            <div className="input-prefix">
              <span className="prefix">$</span>
              <input
                className="input num"
                type="number"
                placeholder="0.00"
                value={tpPrice}
                onChange={(e) => onTpPrice(e.target.value)}
              />
            </div>
            <div className="input-suffix">
              <input
                className="input num"
                type="number"
                placeholder="0"
                value={tpPct}
                onChange={(e) => onTpPct(e.target.value)}
              />
              <span className="suffix">%</span>
            </div>
          </div>
          {tpWrong && (
            <div className="note err">
              Take-profit must be {isLong ? 'above' : 'below'} entry ({fmtPrice(entry)}).
            </div>
          )}
        </div>

        <div className="field">
          <div className="label">
            <span>Stop loss</span>
            <span className="faint">loss on margin</span>
          </div>
          <div className="preset-row">
            {SL_PRESETS.map((p) => (
              <button
                key={p}
                className={`preset-opt neg ${slPct === String(-p) ? 'active' : ''}`}
                onClick={() => onSlPct(-p)}
              >
                -{p}%
              </button>
            ))}
          </div>
          <div className="ac-inputs">
            <div className="input-prefix">
              <span className="prefix">$</span>
              <input
                className="input num"
                type="number"
                placeholder="0.00"
                value={slPrice}
                onChange={(e) => onSlPrice(e.target.value)}
              />
            </div>
            <div className="input-suffix">
              <input
                className="input num"
                type="number"
                placeholder="0"
                value={slPct}
                onChange={(e) => onSlPct(e.target.value)}
              />
              <span className="suffix">%</span>
            </div>
          </div>
          {slWrong && (
            <div className="note err">
              Stop-loss must be {isLong ? 'below' : 'above'} entry ({fmtPrice(entry)}).
            </div>
          )}
        </div>

        <button
          className={`submit ${armed ? 'live' : 'safe'}`}
          disabled={invalid || submitting || !armed}
          onClick={submit}
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
        {!armed ? (
          <div className="note warn">Flip ARM in the top bar to place auto-close orders.</div>
        ) : (
          <div className="note">
            Places reduce-only market triggers that close the full position. Re-saving replaces any
            existing ones.
          </div>
        )}
      </div>
    </div>
  )
}
