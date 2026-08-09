import { useState } from 'react'
import PositionsTable from './PositionsTable.jsx'
import ChartPanel from './ChartPanel.jsx'
import OrderBookPanel from './OrderBookPanel.jsx'
import MarketList from './MarketList.jsx'
import { fmtUsd, fmtSignedUsd, fmtUsdCompact, shortAddr } from '../format.js'

// Whether the order book column is open — remembered across sessions so
// chart-first users aren't re-collapsing it every visit.
const BOOK_KEY = 'hypervault.bookOpen'

export default function VaultPanel({
  vault,
  vaultError,
  meta,
  addressInput,
  setAddressInput,
  onSubmitAddress,
  savedVaults = [],
  onRemoveVault,
  onMirror,
  onTradeCoin,
  selectedCoin,
  onSelectCoin,
  selectedPosition,
  myPosition,
  peersOnCoin = [],
  fills = [],
  myFills = [],
  onTimeframe,
  notify,
  onOpenTopTraders,
}) {
  const [editing, setEditing] = useState(false)
  const [ddOpen, setDdOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(() => {
    try {
      return localStorage.getItem(BOOK_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggleBook = () =>
    setBookOpen((open) => {
      const next = !open
      try {
        localStorage.setItem(BOOK_KEY, next ? '1' : '0')
      } catch {
        /* ignore storage errors */
      }
      return next
    })
  const ms = vault?.marginSummary
  const name = vault?.details?.name
  const positions = vault?.positions || []
  const spotBalances = vault?.spotBalances || []

  return (
    <section className="panel">
      {/* Chart first — it's what you're here to look at. The vault header
          sits below, right above the positions it describes. */}
      <div className={`chart-row${bookOpen ? '' : ' book-hidden'}`}>
        <ChartPanel
          coin={selectedCoin}
          position={selectedPosition}
          myPosition={myPosition}
          peers={peersOnCoin}
          fills={fills}
          myFills={myFills}
          onTimeframe={onTimeframe}
          onSelectVault={onSubmitAddress}
          meta={meta}
          onSelectCoin={onSelectCoin}
        />
        <OrderBookPanel
          coin={selectedCoin}
          collapsed={!bookOpen}
          onToggle={toggleBook}
          notify={notify}
        />
      </div>

      <div className="vault-head">
        <div className="vault-title-row">
          {editing ? (
            <input
              className="addr-input"
              autoFocus
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onSubmitAddress(addressInput)
                  setEditing(false)
                }
              }}
              onBlur={() => {
                onSubmitAddress(addressInput)
                setEditing(false)
              }}
              placeholder="0x… vault or wallet address"
            />
          ) : (
            <>
              <div className="vault-dd">
                <button className="vault-name-btn" onClick={() => setDdOpen((o) => !o)}>
                  <span className="vault-name">{name || 'Wallet'}</span>
                  <span className="dd-caret">▾</span>
                </button>
                {ddOpen && (
                  <>
                    <div className="dd-backdrop" onClick={() => setDdOpen(false)} />
                    <div className="dd-menu">
                      {savedVaults.length === 0 && (
                        <div className="dd-empty">No saved vaults yet</div>
                      )}
                      {savedVaults.map((s) => (
                        <div
                          key={s.address}
                          className={`dd-item${
                            s.address.toLowerCase() === vault?.address?.toLowerCase()
                              ? ' active'
                              : ''
                          }`}
                          onClick={() => {
                            onSubmitAddress(s.address)
                            setDdOpen(false)
                          }}
                        >
                          <div className="dd-item-main">
                            <span className="dd-name">{s.name || 'Wallet'}</span>
                            <span className="dd-addr">{shortAddr(s.address)}</span>
                          </div>
                          <button
                            className="dd-x"
                            title="Remove"
                            onClick={(e) => {
                              e.stopPropagation()
                              onRemoveVault(s.address)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <div className="dd-sep" />
                      <button
                        className="dd-add"
                        onClick={() => {
                          setEditing(true)
                          setDdOpen(false)
                        }}
                      >
                        + Add a vault…
                      </button>
                      <button
                        className="dd-add"
                        onClick={() => {
                          onOpenTopTraders?.()
                          setDdOpen(false)
                        }}
                      >
                        🏆 Browse top traders…
                      </button>
                    </div>
                  </>
                )}
              </div>
              <span className="following-tag">Following</span>
              <span className="vault-addr">
                {shortAddr(vault?.address)} ·{' '}
                <button className="linkish" onClick={() => setEditing(true)}>
                  change
                </button>
              </span>
              <button className="top-traders-btn" onClick={() => onOpenTopTraders?.()}>
                🏆 Top traders
              </button>
              {/* Compact stats — the tables below carry the detail; hover for
                  full precision. */}
              <div className="vault-stats-inline num">
                <span title={`Vault equity: ${fmtUsd(ms?.accountValue)}`}>
                  <b>{fmtUsdCompact(ms?.accountValue)}</b> equity
                </span>
                <span title={`Unrealized PnL: ${fmtSignedUsd(ms?.totalUnrealizedPnl)}`}>
                  <b className={(ms?.totalUnrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}>
                    {fmtUsdCompact(ms?.totalUnrealizedPnl, true)}
                  </b>{' '}
                  uPnL
                </span>
                <span>
                  <b>{ms?.openPositions ?? positions.length}</b> positions
                </span>
                <span title={`Total notional: ${fmtUsd(ms?.totalNtlPos)}`}>
                  <b>{fmtUsdCompact(ms?.totalNtlPos)}</b> notional
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="tabs">
        <div className="tab active">
          Positions <span className="count">({positions.length})</span>
        </div>
        <div className="tab">Balances</div>
        <div className="tab">Trade History</div>
        <div className="tab">Funding</div>
      </div>

      <div className="table-tools">
        <button className="sort-by">Sort by size ▾</button>
        <span className="faint" style={{ fontSize: 12 }}>
          live · updates every 5s
        </span>
      </div>

      {vaultError && vault && (
        <div className="stale-note">
          Live update failed — showing the last snapshot. {vaultError}
        </div>
      )}
      {vaultError && !vault ? (
        <div className="spin">Couldn’t load this address — {vaultError}</div>
      ) : !vault ? (
        <div className="spin">Loading vault…</div>
      ) : positions.length === 0 ? (
        <div className="empty">
          No open perp positions for this address.
          {ms?.spotUsd > 0 && (
            <div className="empty-sub">
              Holds {fmtUsd(ms.spotUsd)} in spot
              {spotBalances.length
                ? ` (${spotBalances
                    .slice(0, 3)
                    .map((b) => b.coin)
                    .join(', ')})`
                : ''}
              .
            </div>
          )}
        </div>
      ) : (
        <PositionsTable
          positions={positions}
          onMirror={onMirror}
          selectedCoin={selectedCoin}
          onSelectCoin={onSelectCoin}
        />
      )}

      <MarketList
        meta={meta}
        selectedCoin={selectedCoin}
        onSelectCoin={onSelectCoin}
        onTradeCoin={onTradeCoin}
      />
    </section>
  )
}
