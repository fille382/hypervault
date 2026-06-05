import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from './components/TopBar.jsx'
import VaultPanel from './components/VaultPanel.jsx'
import AccountPanel from './components/AccountPanel.jsx'
import TradeModal from './components/TradeModal.jsx'
import { getHealth, getMeta, getVault, getAccount, setArm } from './api.js'

const DEFAULT_VAULT = '0xd6e56265890b76413d1d527eb9b75e334c0c5b42'
const POLL_MS = 5000

export default function App() {
  const [health, setHealth] = useState(null)
  const [meta, setMeta] = useState({})
  const [addressInput, setAddressInput] = useState(DEFAULT_VAULT)
  const [activeAddress, setActiveAddress] = useState(DEFAULT_VAULT)
  const [vault, setVault] = useState(null)
  const [vaultError, setVaultError] = useState(null)
  const [account, setAccount] = useState(null)
  const [trade, setTrade] = useState(null) // prefill object | null
  const [toast, setToast] = useState(null)

  const toastTimer = useRef(null)
  const showToast = useCallback((kind, msg) => {
    setToast({ kind, msg })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])

  // Perp/spot metadata (max leverage, mark prices). Refreshed periodically below.
  useEffect(() => {
    getMeta().then(setMeta).catch(() => {})
    const id = setInterval(() => getMeta().then(setMeta).catch(() => {}), 15000)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    let h = null
    try {
      h = await getHealth()
      setHealth(h)
    } catch {
      /* backend not reachable yet */
    }
    try {
      const v = await getVault(activeAddress)
      setVault(v)
      setVaultError(null)
    } catch (e) {
      setVaultError(e.message)
      setVault(null)
    }
    if (h?.tradingConfigured || h?.accountAddress) {
      try {
        setAccount(await getAccount())
      } catch {
        setAccount(null)
      }
    } else {
      setAccount(null)
    }
  }, [activeAddress])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const onSubmitAddress = (addr) => {
    const a = (addr || '').trim()
    if (a) setActiveAddress(a)
  }

  const onToggleArm = async (next) => {
    try {
      const r = await setArm(next)
      setHealth((h) => ({ ...(h || {}), armed: r.armed }))
      showToast(
        next ? 'bad' : 'ok',
        next ? '⚠ ARMED — live orders enabled' : 'SAFE mode — orders simulated',
      )
    } catch (e) {
      showToast('bad', e.message)
    }
  }

  const openMirror = (pos) => {
    const m = meta[pos.coin] || {}
    const maxLev = m.maxLeverage || 20
    setTrade({
      coin: pos.coin,
      side: pos.side,
      leverage: Math.min(pos.leverage || 5, maxLev),
      marginMode: pos.leverageType === 'isolated' ? 'isolated' : 'cross',
      notionalUsd: 100,
    })
  }

  const openNewTrade = () => {
    const firstCoin = vault?.positions?.[0]?.coin || 'BTC'
    setTrade({ coin: firstCoin, side: 'long', leverage: 5, marginMode: 'cross', notionalUsd: 100 })
  }

  return (
    <>
      <TopBar health={health} account={account} onToggleArm={onToggleArm} />
      <div className="layout">
        <VaultPanel
          vault={vault}
          vaultError={vaultError}
          meta={meta}
          addressInput={addressInput}
          setAddressInput={setAddressInput}
          onSubmitAddress={onSubmitAddress}
          onMirror={openMirror}
          onNewTrade={openNewTrade}
        />
        <AccountPanel health={health} account={account} notify={showToast} refresh={refresh} />
      </div>
      {trade && (
        <TradeModal
          initial={trade}
          meta={meta}
          health={health}
          onClose={() => setTrade(null)}
          onResult={(kind, msg) => {
            showToast(kind, msg)
            refresh()
          }}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </>
  )
}
