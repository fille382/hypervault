import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TopBar from './components/TopBar.jsx'
import VaultPanel from './components/VaultPanel.jsx'
import AccountPanel from './components/AccountPanel.jsx'
import TradeModal from './components/TradeModal.jsx'
import TopTraders from './components/TopTraders.jsx'
import {
  getHealth,
  getMeta,
  getVault,
  getAccount,
  getPeers,
  getFills,
  getMyTrades,
  setArm,
} from './api.js'
import { fmtNum, fmtPrice, shortAddr, coinLabel } from './format.js'
import { checkAlerts, noticeText } from './alerts.js'

const DEFAULT_VAULT = '0xd6e56265890b76413d1d527eb9b75e334c0c5b42'
// Live-data poll cadence scales with the chart timeframe: fast when you're
// scalping a 5m chart, relaxed when you're eyeing a weekly. No point hammering
// Hyperliquid's free API for sub-5s updates you can't even see on a 3D candle.
const POLL_BY_TIMEFRAME = {
  '5m': 5000,
  '15m': 8000,
  '1h': 15000,
  '4h': 30000,
  '1d': 30000,
  '3d': 60000,
  '1w': 60000,
  '1M': 60000,
}
const pollMsFor = (tf) => POLL_BY_TIMEFRAME[tf] || 10000
// Your own positions update at this fixed rate regardless of the chart timeframe.
const ACCOUNT_POLL_MS = 4000
const SAVED_KEY = 'hypervault.savedVaults'
// Toast queue: how long each toast lives, how many stack on screen at once,
// and how many more may wait their turn before the oldest waiter is dropped.
const TOAST_MS = 4200
const TOAST_VISIBLE = 3
const TOAST_PENDING_MAX = 5
// Vault-activity fills each get their own toast, up to this many per poll;
// anything beyond that collapses into one "…and N more" summary toast.
const FILL_TOASTS_MAX = 4

function loadSavedVaults() {
  try {
    const arr = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persistVaults(list) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    /* ignore storage errors */
  }
}

const FILLS_POLL_MS = 20000
const FILLS_HOURS = 72
const FILLS_LIMIT = 150
// "Load more" grows the window/limit up to these ceilings (matches backend caps).
const FILLS_HOURS_MAX = 720
const FILLS_LIMIT_MAX = 1000
const fillKey = (f) => `${f.address}-${f.hash}-${f.coin}-${f.time}-${f.sz}`

// True while the browser tab is visible. Pollers gate on this so they pause in
// a background tab (no point hammering the API when nobody's looking) and fire
// an immediate refresh the moment you switch back.
function useDocumentVisible() {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export default function App() {
  const visible = useDocumentVisible()
  const [health, setHealth] = useState(null)
  const [meta, setMeta] = useState({})
  const [addressInput, setAddressInput] = useState(DEFAULT_VAULT)
  const [activeAddress, setActiveAddress] = useState(DEFAULT_VAULT)
  const [vault, setVault] = useState(null)
  const [vaultError, setVaultError] = useState(null)
  const [account, setAccount] = useState(null)
  const [trade, setTrade] = useState(null) // prefill object | null
  const [toasts, setToasts] = useState([])
  const [selectedCoin, setSelectedCoin] = useState(null)
  const [savedVaults, setSavedVaults] = useState(loadSavedVaults)
  const [online, setOnline] = useState(true) // is the backend reachable?
  // Chart timeframe drives how often we poll live data (see POLL_BY_TIMEFRAME).
  const [chartTf, setChartTf] = useState('3d')
  const pollMs = pollMsFor(chartTf)

  // Queued toasts: up to TOAST_VISIBLE show stacked, each for its full
  // TOAST_MS; anything beyond that waits in a small pending queue instead of
  // overwriting what's on screen. When the queue overflows, the oldest
  // *waiting* toast drops (stale news loses to fresh news). Click dismisses.
  const toastQ = useRef({ visible: [], pending: [], timers: new Map(), id: 0 })
  const dismissToast = useCallback((id) => {
    const q = toastQ.current
    clearTimeout(q.timers.get(id))
    q.timers.delete(id)
    q.visible = q.visible.filter((t) => t.id !== id)
    const next = q.pending.shift()
    if (next) {
      q.visible = [...q.visible, next]
      q.timers.set(next.id, setTimeout(() => dismissToast(next.id), TOAST_MS))
    }
    setToasts(q.visible)
  }, [])
  const showToast = useCallback(
    (kind, msg) => {
      const q = toastQ.current
      const t = { id: ++q.id, kind, msg }
      if (q.visible.length < TOAST_VISIBLE) {
        q.visible = [...q.visible, t]
        q.timers.set(t.id, setTimeout(() => dismissToast(t.id), TOAST_MS))
        setToasts(q.visible)
      } else {
        q.pending = [...q.pending, t].slice(-TOAST_PENDING_MAX)
      }
    },
    [dismissToast],
  )
  useEffect(() => {
    const q = toastQ.current
    return () => q.timers.forEach((timer) => clearTimeout(timer))
  }, [])

  // Activity feed: real trade history (userFills) for every saved vault,
  // polled from the exchange — complete even for trades made while the app
  // was closed. New fills after the first load also fire a toast.
  const [fills, setFills] = useState([])
  const seenFillsRef = useRef(null) // null until the first load (history, not news)
  // Addresses whose fills we've already seen once. A just-followed trader's
  // backlog is history, not breaking news — only toast for addresses that
  // were being tracked on the previous poll.
  const trackedAddrsRef = useRef(new Set())
  // Your own recent trades, for the chart markers (opens / closes on the coin).
  const [myTrades, setMyTrades] = useState([])
  useEffect(() => {
    const configured = health?.tradingConfigured || health?.accountAddress
    if (!configured) {
      setMyTrades([])
      return undefined
    }
    if (!visible) return undefined
    let cancelled = false
    const load = () =>
      getMyTrades(500, 0)
        .then((r) => !cancelled && setMyTrades(r.trades || []))
        .catch(() => {})
    load()
    const id = setInterval(load, 20000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [health?.tradingConfigured, health?.accountAddress, visible])
  // Growable activity window — "load more" (scroll to the bottom) extends it.
  const [fillsHours, setFillsHours] = useState(FILLS_HOURS)
  const [fillsLimit, setFillsLimit] = useState(FILLS_LIMIT)
  const fillsBusyRef = useRef(false) // debounce: one growth until new data lands
  useEffect(() => {
    fillsBusyRef.current = false // fills changed (or stopped growing) — allow next load
  }, [fills.length])
  const loadMoreFills = useCallback(() => {
    // Only grow if the list is currently full (more likely exists) and not maxed.
    if (fillsBusyRef.current || fills.length < fillsLimit || fillsLimit >= FILLS_LIMIT_MAX) return
    fillsBusyRef.current = true
    setFillsLimit((l) => Math.min(l + 150, FILLS_LIMIT_MAX))
    setFillsHours((h) => Math.min(h + 72, FILLS_HOURS_MAX))
  }, [fills.length, fillsLimit])

  // Perp/spot metadata (max leverage, mark prices). Refreshed periodically below.
  useEffect(() => {
    if (!visible) return undefined
    getMeta().then(setMeta).catch(() => {})
    const id = setInterval(() => getMeta().then(setMeta).catch(() => {}), 15000)
    return () => clearInterval(id)
  }, [visible])

  // Chart-drawn price alerts AND trendlines, checked against every fresh
  // mark-price sweep (the meta poll covers all coins). Fired notices toast
  // here and persist into the Trade history feed (see alerts.js).
  useEffect(() => {
    if (!meta || !Object.keys(meta).length) return
    for (const n of checkAlerts(meta)) {
      const landed = n.kind === 'hit' || n.kind === 'line-cross'
      showToast(landed ? 'ok' : 'info', `🔔 ${noticeText(n)}`)
    }
  }, [meta, showToast])

  // BTC price + 24h change for the top-bar chip, straight from the meta poll
  // (Hyperliquid markPx / prevDayPx) — no extra upstream requests.
  const btc = useMemo(() => {
    const m = meta?.BTC
    if (!m?.markPx) return null
    return {
      price: m.markPx,
      change24h: m.prevDayPx ? (m.markPx / m.prevDayPx - 1) * 100 : null,
    }
  }, [meta])

  // Health + the FOLLOWED vault — polled at the timeframe-scaled cadence.
  const refresh = useCallback(async () => {
    try {
      const h = await getHealth()
      setHealth(h)
      setOnline(true)
    } catch {
      setOnline(false) // backend down / restarting — surfaced in the top bar
    }
    try {
      const v = await getVault(activeAddress)
      setVault(v)
      setVaultError(null)
    } catch (e) {
      setVaultError(e.message)
      setVault(null)
    }
  }, [activeAddress])

  useEffect(() => {
    if (!visible) return undefined
    refresh()
    const id = setInterval(refresh, pollMs)
    return () => clearInterval(id)
  }, [refresh, visible, pollMs])

  // YOUR OWN account (positions + live PnL) — polled fast and independent of the
  // chart timeframe, so your PnL stays current even while viewing a wide candle.
  const refreshAccount = useCallback(async () => {
    if (!(health?.tradingConfigured || health?.accountAddress)) {
      setAccount(null)
      return
    }
    try {
      setAccount(await getAccount())
    } catch {
      /* keep the last good snapshot on a transient failure */
    }
  }, [health?.tradingConfigured, health?.accountAddress])

  useEffect(() => {
    if (!visible) return undefined
    refreshAccount()
    const id = setInterval(refreshAccount, ACCOUNT_POLL_MS)
    return () => clearInterval(id)
  }, [refreshAccount, visible])

  // Used by trade actions to refresh everything at once, immediately.
  const refreshAll = useCallback(() => {
    refresh()
    refreshAccount()
  }, [refresh, refreshAccount])

  // Default the chart to the largest vault position; keep the selection valid.
  // A selection counts as valid if it's any tradeable market (you picked it
  // from the All-markets list) OR shows up in the vault/your positions/recent
  // fills — so clicking a market, a "My positions" row, or an Activity row all
  // chart that coin instead of snapping back to the vault's top position.
  useEffect(() => {
    const vaultCoins = vault?.positions?.map((p) => p.coin) || []
    const myCoins = account?.positions?.map((p) => p.coin) || []
    const fillCoins = fills.map((f) => f.coin)
    const valid =
      selectedCoin != null &&
      (selectedCoin in meta ||
        vaultCoins.includes(selectedCoin) ||
        myCoins.includes(selectedCoin) ||
        fillCoins.includes(selectedCoin))
    if (valid) return
    // No valid selection — fall back to the vault's largest position, then yours.
    setSelectedCoin(vaultCoins[0] || myCoins[0] || null)
  }, [vault, account, fills, selectedCoin, meta])

  // Remember every vault/wallet that successfully loads, for the dropdown.
  useEffect(() => {
    const addr = vault?.address
    if (!addr) return
    const name = vault.details?.name || null
    setSavedVaults((prev) => {
      const idx = prev.findIndex((s) => s.address.toLowerCase() === addr.toLowerCase())
      if (idx === -1) {
        const next = [...prev, { address: addr, name }]
        persistVaults(next)
        return next
      }
      if (name && prev[idx].name !== name) {
        const next = prev.slice()
        next[idx] = { ...next[idx], name }
        persistVaults(next)
        return next
      }
      return prev
    })
  }, [vault])

  // Poll the OTHER saved vaults' positions so we can show their trades on the
  // chart of whichever coin is selected (e.g. everyone's SOL entries at once).
  const [peerPositions, setPeerPositions] = useState({}) // addr(lower) -> positions[]
  useEffect(() => {
    const others = savedVaults.filter(
      (s) => s.address.toLowerCase() !== activeAddress.toLowerCase(),
    )
    if (!others.length) {
      setPeerPositions({})
      return undefined
    }
    if (!visible) return undefined
    let cancelled = false
    const load = () =>
      getPeers(others.map((o) => o.address))
        .then((r) => {
          if (cancelled) return
          const map = {}
          for (const p of r.peers || []) map[p.address.toLowerCase()] = p.positions || []
          setPeerPositions(map)
        })
        .catch(() => {})
    load()
    const id = setInterval(load, Math.max(pollMs, 10000)) // peers never faster than 10s
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [savedVaults, activeAddress, visible, pollMs])

  // Poll recent fills for ALL saved vaults (including the active one).
  useEffect(() => {
    if (!savedVaults.length) {
      setFills([])
      return undefined
    }
    if (!visible) return undefined
    const nameByAddr = {}
    for (const s of savedVaults) nameByAddr[s.address.toLowerCase()] = s.name
    let cancelled = false
    const load = () =>
      getFills(savedVaults.map((s) => s.address), fillsHours, fillsLimit)
        .then((r) => {
          if (cancelled) return
          const list = (r.fills || []).map((f) => ({
            ...f,
            vault: nameByAddr[f.address.toLowerCase()] || shortAddr(f.address),
          }))
          setFills(list)
          const keys = new Set(list.map(fillKey))
          const prev = seenFillsRef.current
          seenFillsRef.current = keys
          const prevAddrs = trackedAddrsRef.current
          trackedAddrsRef.current = new Set(savedVaults.map((s) => s.address.toLowerCase()))
          if (!prev) return // first load is history, not breaking news
          // One toast per new fill, oldest first so they queue in trade order.
          // The toast queue paces the display; if a poll brings a real flood,
          // everything past the first few is summarized in a single closer.
          const fresh = list.filter(
            (f) => !prev.has(fillKey(f)) && prevAddrs.has(f.address.toLowerCase()),
          )
          const shown = fresh.slice(0, FILL_TOASTS_MAX)
          for (const f of shown.reverse()) {
            showToast(
              'info',
              `${f.vault} ${f.dir || (f.side === 'buy' ? 'Buy' : 'Sell')} ${fmtNum(f.sz)} ${coinLabel(f.coin)} @ ${fmtPrice(f.px)}`,
            )
          }
          if (fresh.length > FILL_TOASTS_MAX) {
            showToast('info', `…and ${fresh.length - FILL_TOASTS_MAX} more trades in the activity feed`)
          }
        })
        .catch(() => {})
    load()
    const id = setInterval(load, FILLS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [savedVaults, showToast, fillsHours, fillsLimit, visible])

  // Other vaults' open positions on the currently charted coin.
  const peersOnCoin = useMemo(() => {
    if (!selectedCoin) return []
    return savedVaults
      .filter((s) => s.address.toLowerCase() !== activeAddress.toLowerCase())
      .map((s) => {
        const pos = (peerPositions[s.address.toLowerCase()] || []).find(
          (p) => p.coin === selectedCoin,
        )
        return pos ? { ...pos, vaultAddress: s.address, vaultName: s.name } : null
      })
      .filter(Boolean)
  }, [savedVaults, activeAddress, peerPositions, selectedCoin])

  const onSubmitAddress = (addr) => {
    // Accept a bare 0x address OR a full Hyperliquid vault URL (extract the address).
    const match = (addr || '').match(/0x[a-fA-F0-9]{40}/)
    const a = match ? match[0] : (addr || '').trim()
    if (a) {
      setActiveAddress(a)
      setAddressInput(a)
      if (a.toLowerCase() !== activeAddress.toLowerCase()) setSelectedCoin(null) // follow new vault's top position
    }
  }

  const removeVault = (addr) => {
    setSavedVaults((prev) => {
      const next = prev.filter((s) => s.address.toLowerCase() !== addr.toLowerCase())
      persistVaults(next)
      return next
    })
  }

  // Top-traders discovery (the leaderboard modal).
  const [showTopTraders, setShowTopTraders] = useState(false)
  // Follow WITHOUT switching the dashboard to them: adds the address to the
  // saved list right away, so its fills/positions start feeding the activity
  // feed and chart dots. (The auto-save effect above only records addresses
  // that have loaded as the active vault — a leaderboard follow shouldn't
  // have to yank the whole dashboard over to do the same.)
  const followAddress = (addr, name) => {
    setSavedVaults((prev) => {
      if (prev.some((s) => s.address.toLowerCase() === addr.toLowerCase())) return prev
      const next = [...prev, { address: addr, name: name || null }]
      persistVaults(next)
      return next
    })
    showToast('ok', `Following ${name || shortAddr(addr)} — their trades will show in your feed`)
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
      // Default to isolated — capped, known max loss per position (the margin you
      // assign). You can switch to cross in the ticket.
      marginMode: 'isolated',
      notionalUsd: 100,
      title: 'Mirror trade',
    })
  }

  // Add to one of YOUR existing positions: same coin/side/leverage, you just
  // pick how much more to add. Reuses the order ticket.
  const openAddExposure = (pos) => {
    const m = meta[pos.coin] || {}
    setSelectedCoin(pos.coin)
    setTrade({
      coin: pos.coin,
      side: pos.side,
      leverage: Math.min(pos.leverage || 5, m.maxLeverage || 20),
      marginMode: pos.leverageType === 'isolated' || m.onlyIsolated ? 'isolated' : 'cross',
      notionalUsd: 100,
      title: `Add ${coinLabel(pos.coin)} exposure`,
    })
  }

  // Open the trade ticket. With a coin (from the markets list) it prefills that
  // market and charts it; bare (the "+ New trade" button) it defaults sensibly.
  const openNewTrade = (coin) => {
    // Default to the coin you're currently charting, then the vault's top position.
    const c =
      typeof coin === 'string' ? coin : selectedCoin || vault?.positions?.[0]?.coin || 'BTC'
    const m = meta[c] || {}
    setSelectedCoin(c)
    setTrade({
      coin: c,
      side: 'long',
      leverage: Math.min(5, m.maxLeverage || 20),
      marginMode: 'isolated', // isolated is the norm — contained, known max loss
      notionalUsd: 100,
      title: typeof coin === 'string' ? `Trade ${coinLabel(c)}` : 'New trade',
    })
  }

  const selectedPosition = vault?.positions?.find((p) => p.coin === selectedCoin) || null
  const myPosition = account?.positions?.find((p) => p.coin === selectedCoin) || null

  return (
    <>
      <TopBar
        health={health}
        account={account}
        btc={btc}
        online={online}
        onToggleArm={onToggleArm}
        onNewTrade={openNewTrade}
        notify={showToast}
        refresh={refreshAll}
      />
      <div className="layout">
        <VaultPanel
          vault={vault}
          vaultError={vaultError}
          meta={meta}
          addressInput={addressInput}
          setAddressInput={setAddressInput}
          onSubmitAddress={onSubmitAddress}
          savedVaults={savedVaults}
          onRemoveVault={removeVault}
          onMirror={openMirror}
          onTradeCoin={openNewTrade}
          selectedCoin={selectedCoin}
          onSelectCoin={setSelectedCoin}
          selectedPosition={selectedPosition}
          myPosition={myPosition}
          peersOnCoin={peersOnCoin}
          fills={fills}
          myFills={myTrades}
          onTimeframe={setChartTf}
          notify={showToast}
          onOpenTopTraders={() => setShowTopTraders(true)}
        />
        <AccountPanel
          health={health}
          account={account}
          notify={showToast}
          refresh={refreshAll}
          fills={fills}
          selectedCoin={selectedCoin}
          onSelectCoin={setSelectedCoin}
          onAddExposure={openAddExposure}
          onNewTrade={openNewTrade}
          onLoadMoreFills={loadMoreFills}
          fillsMaxed={fillsLimit >= FILLS_LIMIT_MAX}
        />
      </div>
      {showTopTraders && (
        <TopTraders
          onClose={() => setShowTopTraders(false)}
          savedVaults={savedVaults}
          activeAddress={activeAddress}
          onFollow={followAddress}
          onUnfollow={removeVault}
          onView={(addr) => {
            onSubmitAddress(addr)
            setShowTopTraders(false)
          }}
        />
      )}
      {trade && (
        <TradeModal
          initial={trade}
          meta={meta}
          health={health}
          account={account}
          onClose={() => setTrade(null)}
          onResult={(kind, msg) => {
            showToast(kind, msg)
            refreshAll()
          }}
        />
      )}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast ${t.kind}`}
              onClick={() => dismissToast(t.id)}
              title="Click to dismiss"
            >
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
