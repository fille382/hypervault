import { useState } from 'react'
import { fmtUsd, fmtSignedUsd } from '../format.js'

export default function TopBar({ health, account, onToggleArm }) {
  const [confirming, setConfirming] = useState(false)
  const armed = !!health?.armed
  const network = health?.network || '…'
  const ms = account?.marginSummary

  const handleToggle = () => {
    if (!armed) setConfirming(true) // arming requires confirmation
    else onToggleArm(false) // disarming is instant
  }

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        <div>
          <div className="brand-name">Hypervault</div>
          <div className="brand-sub">Hyperliquid copy-trading</div>
        </div>
      </div>
      <span className={`net-pill ${network === 'testnet' ? 'testnet' : ''}`}>{network}</span>

      <div className="topbar-spacer" />

      {ms && (
        <div className="equity-chip">
          <div className="label">My balance</div>
          <div className="val num">{fmtUsd(ms.totalValue ?? ms.accountValue)}</div>
        </div>
      )}
      {ms && (
        <div className="equity-chip">
          <div className="label">Unrealized PnL</div>
          <div className={`val num ${(ms.totalUnrealizedPnl || 0) >= 0 ? 'pos' : 'neg'}`}>
            {fmtSignedUsd(ms.totalUnrealizedPnl)}
          </div>
        </div>
      )}

      <div className={`arm ${armed ? 'live' : 'safe'}`}>
        <span className="arm-state">{armed ? 'ARMED' : 'SAFE'}</span>
        <button
          className={`toggle ${armed ? 'on' : ''}`}
          onClick={handleToggle}
          title={armed ? 'Disarm (back to SAFE)' : 'Arm live trading'}
        >
          <span className="knob" />
        </button>
      </div>

      {confirming && (
        <div className="overlay" onClick={() => setConfirming(false)}>
          <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">Arm live trading?</div>
              <button className="x-btn" onClick={() => setConfirming(false)}>
                ×
              </button>
            </div>
            <p className="note">
              Orders will be sent to your <b>real {network} account</b> and executed with real
              funds. The size guardrail and per-order confirmation still apply.
            </p>
            <button
              className="submit live"
              onClick={() => {
                setConfirming(false)
                onToggleArm(true)
              }}
            >
              Yes, arm live orders
            </button>
            <button className="linkish" style={{ marginTop: 12 }} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
