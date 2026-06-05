import { useMemo, useState } from 'react'
import { placeOrder } from '../api.js'
import { fmtNum, fmtPx, fmtUsd } from '../format.js'

export default function TradeModal({ initial, meta, health, onClose, onResult }) {
  const coins = useMemo(() => Object.keys(meta).sort(), [meta])
  const [coin, setCoin] = useState(initial.coin)
  const [side, setSide] = useState(initial.side)
  const [marginMode, setMarginMode] = useState(initial.marginMode)
  const [notional, setNotional] = useState(String(initial.notionalUsd))
  const m = meta[coin] || {}
  const maxLev = m.maxLeverage || 20
  const [leverage, setLeverage] = useState(Math.min(initial.leverage || 5, maxLev))
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  const armed = !!health?.armed
  const maxNotional = health?.maxOrderNotionalUsd ?? 2000
  const notionalNum = parseFloat(notional) || 0
  const markPx = m.markPx
  const estSize = markPx ? notionalNum / markPx : null
  const margin = leverage ? notionalNum / leverage : null

  const tooSmall = notionalNum < 10
  const tooBig = notionalNum > maxNotional
  const invalid = tooSmall || tooBig || !coin

  const pickCoin = (c) => {
    setCoin(c)
    const nm = meta[c] || {}
    setLeverage((lev) => Math.min(lev, nm.maxLeverage || 20))
  }

  const submit = async () => {
    setSubmitting(true)
    setResult(null)
    try {
      const r = await placeOrder({ coin, side, notionalUsd: notionalNum, leverage, marginMode })
      if (r.simulated) {
        setResult({
          ok: true,
          text: `SAFE simulation — would ${side} ${fmtNum(r.would.size)} ${coin} (~${fmtUsd(
            r.would.notionalUsd,
          )}) at ${fmtPx(r.would.markPx)}, ${leverage}x ${marginMode}. Flip ARM to send it live.`,
        })
        onResult('ok', `Simulated ${side} ${coin}`)
      } else {
        setResult({ ok: true, text: `LIVE order sent — ${side} ${coin}. ${extractFill(r)}` })
        onResult('ok', `Live ${side} ${coin} sent`)
      }
    } catch (e) {
      setResult({ ok: false, text: e.message })
      onResult('bad', e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Mirror trade</div>
          <button className="x-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="field">
          <div className="label">
            <span>Coin</span>
            <span>{markPx ? `mark ${fmtPx(markPx)}` : ''}</span>
          </div>
          <select className="select" value={coin} onChange={(e) => pickCoin(e.target.value)}>
            {coins.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <div className="label">Direction</div>
          <div className="side-toggle">
            <button
              className={`side-opt long ${side === 'long' ? 'active' : ''}`}
              onClick={() => setSide('long')}
            >
              Long ▲
            </button>
            <button
              className={`side-opt short ${side === 'short' ? 'active' : ''}`}
              onClick={() => setSide('short')}
            >
              Short ▼
            </button>
          </div>
        </div>

        <div className="field">
          <div className="label">
            <span>Leverage</span>
            <span>max {maxLev}x</span>
          </div>
          <div className="lev-row">
            <input
              className="range"
              type="range"
              min="1"
              max={maxLev}
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
            />
            <span className="lev-val num">{leverage}x</span>
          </div>
        </div>

        <div className="field">
          <div className="label">Margin mode</div>
          <div className="mode-toggle">
            <button
              className={`mode-opt ${marginMode === 'cross' ? 'active' : ''}`}
              onClick={() => setMarginMode('cross')}
            >
              Cross
            </button>
            <button
              className={`mode-opt ${marginMode === 'isolated' ? 'active' : ''}`}
              onClick={() => setMarginMode('isolated')}
            >
              Isolated
            </button>
          </div>
        </div>

        <div className="field">
          <div className="label">
            <span>Amount (USD notional)</span>
            <span>max {fmtUsd(maxNotional, 0)}</span>
          </div>
          <div className="input-suffix">
            <input
              className="input num"
              type="number"
              min="0"
              step="10"
              value={notional}
              onChange={(e) => setNotional(e.target.value)}
            />
            <span className="suffix">USD</span>
          </div>
        </div>

        <div className="summary">
          <div className="line">
            <span className="k">Est. size</span>
            <span className="num">{estSize != null ? `${fmtNum(estSize)} ${coin}` : '—'}</span>
          </div>
          <div className="line">
            <span className="k">Est. margin ({leverage}x)</span>
            <span className="num">{fmtUsd(margin)}</span>
          </div>
          <div className="line">
            <span className="k">Mark price</span>
            <span className="num">{fmtPx(markPx)}</span>
          </div>
        </div>

        {tooSmall && <div className="note err">Minimum order is ~$10 notional.</div>}
        {tooBig && (
          <div className="note err">
            Above the {fmtUsd(maxNotional, 0)} guardrail — lower the amount (or raise
            MAX_ORDER_NOTIONAL_USD in backend/.env).
          </div>
        )}

        <button
          className={`submit ${armed ? 'live' : 'safe'}`}
          disabled={invalid || submitting}
          onClick={submit}
        >
          {submitting
            ? 'Sending…'
            : armed
              ? `Place LIVE ${side} — ${fmtUsd(notionalNum, 0)} ${coin}`
              : `Simulate ${side} (SAFE)`}
        </button>

        {!armed ? (
          <div className="note">
            SAFE mode: this only previews the order. Flip <b>ARM</b> in the top bar to send it live.
          </div>
        ) : (
          <div className="note warn">
            ARMED: clicking sends a real market order on {health?.network}.
          </div>
        )}

        {result && (
          <div className={`result-box ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>
        )}
      </div>
    </div>
  )
}

// Pull a human-readable fill summary out of the Hyperliquid order response.
function extractFill(r) {
  try {
    const statuses = r.orderResult?.response?.data?.statuses || []
    const filled = statuses.find((s) => s.filled)?.filled
    if (filled) return `Filled ${filled.totalSz} @ ${filled.avgPx}.`
    const resting = statuses.find((s) => s.resting)?.resting
    if (resting) return `Resting order (oid ${resting.oid}).`
    const err = statuses.find((s) => s.error)?.error
    if (err) return `Exchange said: ${err}`
    if (r.orderResult?.status === 'err') return `Error: ${r.orderResult.response}`
  } catch {
    /* fall through */
  }
  return 'See the My positions panel for the result.'
}
