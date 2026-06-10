import { useState } from 'react'
import PositionsTable from './PositionsTable.jsx'
import ChartPanel from './ChartPanel.jsx'
import { fmtUsd, fmtSignedUsd, shortAddr } from '../format.js'

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
  onNewTrade,
  selectedCoin,
  onSelectCoin,
  selectedPosition,
}) {
  const [editing, setEditing] = useState(false)
  const [ddOpen, setDdOpen] = useState(false)
  const ms = vault?.marginSummary
  const name = vault?.details?.name
  const positions = vault?.positions || []
  const spotBalances = vault?.spotBalances || []

  return (
    <section className="panel">
      <div className="vault-head">
        <div className="vault-title-row">
          <div style={{ flex: 1, minWidth: 0 }}>
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
                <div className="vault-title-row">
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
                        </div>
                      </>
                    )}
                  </div>
                  <span className="following-tag">Following</span>
                </div>
                <div className="vault-addr">
                  {shortAddr(vault?.address)} ·{' '}
                  <button className="linkish" onClick={() => setEditing(true)}>
                    change
                  </button>
                </div>
              </>
            )}
          </div>
          <button className="mirror-btn" onClick={onNewTrade}>
            + New trade
          </button>
        </div>

        <div className="stat-row">
          <div className="stat">
            <div className="label">Vault equity</div>
            <div className="val num">{fmtUsd(ms?.accountValue)}</div>
          </div>
          <div className="stat">
            <div className="label">Unrealized PnL</div>
            <div className={`val num ${(ms?.totalUnrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}`}>
              {fmtSignedUsd(ms?.totalUnrealizedPnl)}
            </div>
          </div>
          <div className="stat">
            <div className="label">Positions</div>
            <div className="val num">{ms?.openPositions ?? positions.length}</div>
          </div>
          <div className="stat">
            <div className="label">Total notional</div>
            <div className="val num">{fmtUsd(ms?.totalNtlPos)}</div>
          </div>
        </div>
      </div>

      <ChartPanel coin={selectedCoin} position={selectedPosition} />

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

      {vaultError ? (
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
    </section>
  )
}
