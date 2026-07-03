import { useMemo, useState } from 'react'
import { placeOrder } from '../api.js'
import { fmtNum, fmtPx, fmtUsd, coinLabel, dexLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

export default function TradeModal({ initial, meta, health, onClose, onResult }) {
  // Group coins by dex so builder markets (xyz:GOLD, vntl:SPACEX, …) sit under
  // their own headings instead of being lost in one giant alphabetical list.
  const coinGroups = useMemo(() => {
    const byDex = {}
    for (const [name, info] of Object.entries(meta)) {
      const d = info.dex || ''
      ;(byDex[d] ||= []).push(name)
    }
    for (const d in byDex) byDex[d].sort()
    return Object.entries(byDex).sort(([a], [b]) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
    )
  }, [meta])
  const [coin, setCoin] = useState(initial.coin)
  const [side, setSide] = useState(initial.side)
  const m = meta[coin] || {}
  const onlyIsolated = !!m.onlyIsolated
  const [marginMode, setMarginMode] = useState(
    onlyIsolated ? 'isolated' : initial.marginMode || 'isolated',
  )
  const [notional, setNotional] = useState(String(initial.notionalUsd))
  const maxLev = m.maxLeverage || 20
  const [leverage, setLeverage] = useState(Math.min(initial.leverage || 5, maxLev))
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  // Markets that can't be cross-margined force isolated mode.
  const effMode = onlyIsolated ? 'isolated' : marginMode

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
    if (nm.onlyIsolated) setMarginMode('isolated')
  }

  const submit = async () => {
    setSubmitting(true)
    setResult(null)
    try {
      const r = await placeOrder({
        coin,
        side,
        notionalUsd: notionalNum,
        leverage,
        marginMode: effMode,
      })
      const label = coinLabel(coin)
      if (r.simulated) {
        setResult({
          ok: true,
          text: `SAFE simulation — would ${side} ${fmtNum(r.would.size)} ${label} (~${fmtUsd(
            r.would.notionalUsd,
          )}) at ${fmtPx(r.would.markPx)}, ${leverage}x ${effMode}. Flip ARM to send it live.`,
        })
        onResult('ok', `Simulated ${side} ${label}`)
      } else {
        setResult({ ok: true, text: `LIVE order sent — ${side} ${label}. ${extractFill(r)}` })
        onResult('ok', `Live ${side} ${label} sent`)
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
          <div className="modal-title">{initial.title || 'Mirror trade'}</div>
          <button className="x-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="field">
          <div className="label">
            <span className="coin-field-label">
              <CoinIcon coin={coin} size={16} /> Coin
            </span>
            <span>{markPx ? `mark ${fmtPx(markPx)}` : ''}</span>
          </div>
          <select className="select" value={coin} onChange={(e) => pickCoin(e.target.value)}>
            {coinGroups.map(([dex, names]) => (
              <optgroup key={dex || 'main'} label={dexLabel(dex)}>
                {names.map((c) => (
                  <option key={c} value={c}>
                    {coinLabel(c)}
                  </option>
                ))}
              </optgroup>
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
              className={`mode-opt ${effMode === 'isolated' ? 'active' : ''}`}
              onClick={() => setMarginMode('isolated')}
            >
              Isolated
            </button>
            <button
              className={`mode-opt ${effMode === 'cross' ? 'active' : ''}`}
              onClick={() => setMarginMode('cross')}
              disabled={onlyIsolated}
              title={onlyIsolated ? 'This market is isolated-only' : ''}
            >
              Cross
            </button>
          </div>
          <div className="note" style={{ marginTop: 4 }}>
            {onlyIsolated
              ? `${coinLabel(coin)} is isolated-only — cross margin isn’t available.`
              : 'Isolated caps your loss at the margin assigned to this position.'}
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
            <span className="num">{estSize != null ? `${fmtNum(estSize)} ${coinLabel(coin)}` : '—'}</span>
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
              ? `Place LIVE ${side} — ${fmtUsd(notionalNum, 0)} ${coinLabel(coin)}`
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
