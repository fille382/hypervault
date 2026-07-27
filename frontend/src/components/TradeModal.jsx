import { useEffect, useMemo, useState } from 'react'
import { getSpotMeta, placeOrder, placeSpotOrder } from '../api.js'
import { fmtNum, fmtPx, fmtUsd, coinLabel, dexLabel } from '../format.js'
import CoinIcon from './CoinIcon.jsx'

// Spot pair for a perp coin: the direct USDC pair, or the Unit-bridged
// "U"-prefixed version the majors trade under (BTC -> UBTC/USDC).
const spotPairFor = (perpCoin, pairs) => {
  if (!pairs) return null
  const label = coinLabel(perpCoin)
  for (const name of [`${label}/USDC`, `U${label}/USDC`]) {
    if (pairs[name]) return name
  }
  return null
}

export default function TradeModal({ initial, meta, health, account, onClose, onResult }) {
  // Perp (leveraged long/short) vs Spot (plain buy/sell — you own the tokens).
  const [market, setMarket] = useState(initial.market || 'perp')

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

  // Spot pairs ("HYPE/USDC" …) load on demand the first time the Spot tab is
  // opened, then refresh while the ticket stays open so mark prices are live.
  const [spotMeta, setSpotMeta] = useState(null)
  const [spotCoin, setSpotCoin] = useState(null)
  const [spotError, setSpotError] = useState(null)
  useEffect(() => {
    if (market !== 'spot') return undefined
    let cancelled = false
    const load = () =>
      getSpotMeta()
        .then((r) => {
          if (cancelled) return
          setSpotMeta(r)
          setSpotError(null)
        })
        .catch((e) => !cancelled && setSpotError(e.message))
    load()
    const id = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [market])

  // When the pairs land (or the tab is opened), default to the USDC pair of
  // the perp coin being viewed. No match → stay unselected: silently jumping
  // to an unrelated market invites trading the wrong coin.
  useEffect(() => {
    if (market !== 'spot' || !spotMeta) return
    if (spotCoin && spotMeta[spotCoin]) return
    setSpotCoin(spotPairFor(coin, spotMeta))
  }, [market, spotMeta, spotCoin, coin])

  const spotNames = useMemo(() => (spotMeta ? Object.keys(spotMeta).sort() : []), [spotMeta])
  const sm = (spotMeta && spotCoin && spotMeta[spotCoin]) || {}

  const isSpot = market === 'spot'
  const isSell = isSpot && side === 'sell'
  const isBuy = isSpot && side === 'buy'

  // Your spot wallet: selling needs the tokens, buying needs spot USDC.
  // (`available` excludes amounts locked in open orders.)
  const spotBalances = account?.spotBalances || []
  const balancesKnown = !!account
  const availOf = (token) => {
    const b = spotBalances.find((x) => x.coin === token)
    return b ? (b.available ?? b.total ?? 0) : 0
  }
  const baseAvail = isSpot && sm.base ? availOf(sm.base) : 0
  const usdcAvail = balancesKnown ? availOf('USDC') : null
  const availUsd = isSpot && sm.markPx != null ? baseAvail * sm.markPx : null

  // Pairs you can actually sell (base token held), largest holding first.
  const heldNames = useMemo(() => {
    if (!spotMeta) return []
    return Object.keys(spotMeta)
      .filter((n) => spotMeta[n].base !== 'USDC' && availOf(spotMeta[n].base) > 0)
      .sort(
        (a, b) =>
          availOf(spotMeta[b].base) * (spotMeta[b].markPx || 0) -
          availOf(spotMeta[a].base) * (spotMeta[a].markPx || 0),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotMeta, account])
  const unheldNames = useMemo(
    () => spotNames.filter((n) => !heldNames.includes(n)),
    [spotNames, heldNames],
  )

  // Each market keeps its own side vocabulary; translate when switching tabs.
  const pickMarket = (mk) => {
    if (mk === market) return
    setMarket(mk)
    setResult(null)
    setSide((s) =>
      mk === 'spot' ? (s === 'short' ? 'sell' : 'buy') : s === 'sell' ? 'short' : 'long',
    )
    // Clicking Spot follows the coin you're trading: preselect its USDC pair
    // when one exists (the async default effect covers the pairs-still-loading case).
    if (mk === 'spot' && spotMeta) {
      const match = spotPairFor(coin, spotMeta)
      if (match) setSpotCoin(match)
    }
  }

  // Switching to Sell jumps to your largest holding if the current pair isn't
  // one you own — you can only sell coins that are actually in your wallet.
  const pickSide = (s) => {
    setSide(s)
    if (s === 'sell' && heldNames.length && !heldNames.includes(spotCoin)) {
      setSpotCoin(heldNames[0])
    }
  }

  // Markets that can't be cross-margined force isolated mode.
  const effMode = onlyIsolated ? 'isolated' : marginMode

  const armed = !!health?.armed
  const maxNotional = health?.maxOrderNotionalUsd ?? 2000
  const notionalNum = parseFloat(notional) || 0
  const markPx = isSpot ? sm.markPx : m.markPx
  const activeCoin = isSpot ? spotCoin : coin
  const activeLabel = isSpot ? (sm.base || spotCoin || '') : coinLabel(coin)
  const estSize = markPx ? notionalNum / markPx : null
  const margin = leverage ? notionalNum / leverage : null

  const tooSmall = notionalNum < 10
  const tooBig = notionalNum > maxNotional
  // Spot reality checks (only when we know your balances): can't sell tokens
  // you don't hold, can't spend USDC you don't have. Small tolerance for the
  // mark price moving between polls.
  const insufficientSell =
    isSell && balancesKnown && availUsd != null && notionalNum > availUsd + 0.01
  const insufficientBuy =
    isBuy && balancesKnown && usdcAvail != null && notionalNum > usdcAvail + 0.01
  const invalid = tooSmall || tooBig || !activeCoin || insufficientSell || insufficientBuy
  // "Sell all" targets the full available holding, rounded down a cent so the
  // backend's size never exceeds the balance.
  const sellAllUsd = availUsd != null ? Math.floor(availUsd * 100) / 100 : null

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
      const r = isSpot
        ? await placeSpotOrder({ coin: spotCoin, side, notionalUsd: notionalNum })
        : await placeOrder({
            coin,
            side,
            notionalUsd: notionalNum,
            leverage,
            marginMode: effMode,
          })
      const label = activeLabel
      const detail = isSpot ? '' : `, ${leverage}x ${effMode}`
      if (r.simulated) {
        setResult({
          ok: true,
          text: `SAFE simulation — would ${side} ${fmtNum(r.would.size)} ${label} (~${fmtUsd(
            r.would.notionalUsd,
          )}) at ${fmtPx(r.would.markPx)}${detail}. Flip ARM to send it live.`,
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
          <div className="label">Market</div>
          <div className="mode-toggle">
            <button
              className={`mode-opt ${!isSpot ? 'active' : ''}`}
              onClick={() => pickMarket('perp')}
            >
              Perp
            </button>
            <button
              className={`mode-opt ${isSpot ? 'active' : ''}`}
              onClick={() => pickMarket('spot')}
            >
              Spot
            </button>
          </div>
          <div className="note" style={{ marginTop: 4 }}>
            {isSpot
              ? 'Spot: buy or sell the actual tokens with your USDC — no leverage, no liquidation.'
              : 'Perp: leveraged long/short position — you never hold the tokens.'}
          </div>
        </div>

        {isSpot ? (
          <div className="field">
            <div className="label">
              <span className="coin-field-label">
                <CoinIcon coin={sm.base || ''} size={16} /> Pair
              </span>
              <span>{sm.markPx ? `mark ${fmtPx(sm.markPx)}` : ''}</span>
            </div>
            {spotMeta ? (
              <select
                className="select"
                value={spotCoin || ''}
                onChange={(e) => setSpotCoin(e.target.value)}
              >
                {!spotCoin && (
                  <option value="" disabled>
                    Select a pair…
                  </option>
                )}
                {isSell && heldNames.length > 0 ? (
                  <>
                    <optgroup label="Your holdings">
                      {heldNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="All pairs">
                      {unheldNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </optgroup>
                  </>
                ) : (
                  spotNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <div className="note">
                {spotError
                  ? `Couldn't load spot pairs (${spotError}) — restart the backend so it serves the new /api/spot endpoints.`
                  : 'Loading spot pairs…'}
              </div>
            )}
            {spotMeta && !spotPairFor(coin, spotMeta) && (
              <div className="note" style={{ marginTop: 4 }}>
                {coinLabel(coin)} has no spot market on Hyperliquid — only HL-native tokens
                and the Unit-bridged majors (UBTC, UETH, USOL…) trade spot.
              </div>
            )}
            {spotMeta && spotCoin && sm.base === `U${coinLabel(coin)}` && (
              <div className="note" style={{ marginTop: 4 }}>
                {sm.base} is Unit-bridged {coinLabel(coin)} — spot-buying it means owning
                real {coinLabel(coin)} on Hyperliquid.
              </div>
            )}
          </div>
        ) : (
          <div className="field">
            <div className="label">
              <span className="coin-field-label">
                <CoinIcon coin={coin} size={16} /> Coin
              </span>
              <span>{m.markPx ? `mark ${fmtPx(m.markPx)}` : ''}</span>
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
        )}

        <div className="field">
          <div className="label">{isSpot ? 'Action' : 'Direction'}</div>
          <div className="side-toggle">
            <button
              className={`side-opt long ${side === 'long' || side === 'buy' ? 'active' : ''}`}
              onClick={() => pickSide(isSpot ? 'buy' : 'long')}
            >
              {isSpot ? 'Buy' : 'Long ▲'}
            </button>
            <button
              className={`side-opt short ${side === 'short' || side === 'sell' ? 'active' : ''}`}
              onClick={() => pickSide(isSpot ? 'sell' : 'short')}
            >
              {isSpot ? 'Sell' : 'Short ▼'}
            </button>
          </div>
        </div>

        {!isSpot && (
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
        )}

        {!isSpot && (
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
        )}

        <div className="field">
          <div className="label">
            <span>Amount (USD {isSpot ? 'value' : 'notional'})</span>
            {isSell && sellAllUsd != null && sellAllUsd > 0 ? (
              <button
                className="chip-btn"
                onClick={() => setNotional(sellAllUsd.toFixed(2))}
                title={`Sell your whole ${sm.base} holding`}
              >
                Sell all ≈ {fmtUsd(sellAllUsd)}
              </button>
            ) : (
              <span>max {fmtUsd(maxNotional, 0)}</span>
            )}
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
          {isSell && balancesKnown && sm.base && (
            <div className={`note ${baseAvail > 0 ? '' : 'err'}`} style={{ marginTop: 4 }}>
              {baseAvail > 0
                ? `You hold ${fmtNum(baseAvail)} ${sm.base}${
                    availUsd != null ? ` (~${fmtUsd(availUsd)})` : ''
                  } available to sell.`
                : `You don't hold any ${sm.base} — you can only sell coins already in your spot wallet.`}
            </div>
          )}
          {isBuy && balancesKnown && usdcAvail != null && (
            <div className="note" style={{ marginTop: 4 }}>
              Spot USDC available: {fmtUsd(usdcAvail)}
            </div>
          )}
        </div>

        <div className="summary">
          <div className="line">
            <span className="k">Est. size</span>
            <span className="num">{estSize != null ? `${fmtNum(estSize)} ${activeLabel}` : '—'}</span>
          </div>
          {!isSpot && (
            <div className="line">
              <span className="k">Est. margin ({leverage}x)</span>
              <span className="num">{fmtUsd(margin)}</span>
            </div>
          )}
          <div className="line">
            <span className="k">Mark price</span>
            <span className="num">{fmtPx(markPx)}</span>
          </div>
        </div>

        {tooSmall && <div className="note err">Minimum order is ~$10 notional.</div>}
        {insufficientSell && (
          <div className="note err">
            That's more than your {sm.base} holding — use “Sell all” for the maximum.
          </div>
        )}
        {insufficientBuy && (
          <div className="note err">
            Not enough spot USDC ({fmtUsd(usdcAvail)}) — transfer funds to your spot wallet first.
          </div>
        )}
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
              ? `Place LIVE ${side} — ${fmtUsd(notionalNum, 0)} ${activeLabel}`
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
