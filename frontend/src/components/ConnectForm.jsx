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
        <b>You need a Hyperliquid API wallet</b> — a separate trading key that{' '}
        <b>can’t withdraw</b> your funds. Takes a minute:
        <ol className="setup-steps">
          <li>
            Open{' '}
            <a href="https://app.hyperliquid.xyz/API" target="_blank" rel="noreferrer">
              app.hyperliquid.xyz/API
            </a>{' '}
            and connect your normal wallet.
          </li>
          <li>
            Name a new API wallet (e.g. “hypervault”), click <b>Generate</b>, then{' '}
            <b>Authorize API Wallet</b>.
          </li>
          <li>Copy the private key it shows (only shown once) and paste it below.</li>
        </ol>
        The key is sent only to the backend on <b>this computer</b> and used to sign your{' '}
        {network || 'mainnet'} orders — it never leaves your machine.
      </div>

      <div className="field">
        <div className="label">
          <span>API wallet private key</span>
          <a
            className="label-link"
            href="https://app.hyperliquid.xyz/API"
            target="_blank"
            rel="noreferrer"
          >
            where do I get this?
          </a>
        </div>
        <input
          className="input num"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x… (the key from the API page, not your seed phrase)"
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
          <span>required with an API wallet</span>
        </div>
        <input
          className="input num"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x… the account that holds your funds"
          value={accountAddress}
          onChange={(e) => setAccountAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <div className="field-hint">
          Your Ethereum address — the MetaMask (or other) wallet you connect to Hyperliquid
          with. It’s the <b>public</b> 0x… address shown top-right on Hyperliquid. Leave blank
          only if you pasted that wallet’s own private key above.
        </div>
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
