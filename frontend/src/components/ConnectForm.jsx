import { useState } from 'react'
import { setCredentials } from '../api.js'

// In-app credential entry. Posts the key to the LOCAL backend, which validates it,
// starts trading immediately, and (if "remember") writes it to backend/.env.
export default function ConnectForm({ network, onConnected, onError }) {
  const [secretKey, setSecretKey] = useState('')
  const [accountAddress, setAccountAddress] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const key = secretKey.trim()
    if (!key) return
    setBusy(true)
    try {
      const r = await setCredentials({
        secretKey: key,
        accountAddress: accountAddress.trim() || null,
        persist: remember,
      })
      setSecretKey('')
      setAccountAddress('')
      onConnected(r)
    } catch (e) {
      onError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect">
      <div className="setup-hint" style={{ borderStyle: 'solid' }}>
        Connect to trade on <b>{network || 'mainnet'}</b>. Use a Hyperliquid <b>API wallet</b>{' '}
        key (can trade, <b>can’t withdraw</b>). It’s stored locally on this machine and only used
        to sign your orders — it never leaves your computer.
      </div>

      <div className="field">
        <div className="label">API wallet private key</div>
        <input
          className="input num"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>

      <div className="field">
        <div className="label">
          <span>Main account address</span>
          <span>optional</span>
        </div>
        <input
          className="input num"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x… (blank if using your main wallet key)"
          value={accountAddress}
          onChange={(e) => setAccountAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>

      <label className="remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this machine (writes backend/.env)
      </label>

      <button className="submit safe" disabled={busy || !secretKey.trim()} onClick={submit}>
        {busy ? 'Connecting…' : 'Connect account'}
      </button>
    </div>
  )
}
