// Number / currency formatting helpers (tabular, en-US).

export const fmtUsd = (n, dp = 2) => {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`
}

export const fmtSignedUsd = (n, dp = 2) => {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '-' : '+'
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`
}

// Compact USD for tight spots ($12.82M, $915.4K, $208.55). Full precision
// belongs in a title tooltip next to these.
export const fmtUsdCompact = (n, signed = false) => {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '-' : signed ? '+' : ''
  const abs = Math.abs(n)
  const [div, suffix] =
    abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e4 ? [1e3, 'K'] : [1, '']
  const v = abs / div
  return `${sign}$${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 1 : 2 })}${suffix}`
}

// Compact number for coin sizes: trims trailing zeros, groups thousands.
export const fmtNum = (n, maxDp = 4) => {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: maxDp })
}

// ROE / percentage from a fraction (0.39 -> "+39.0%").
export const fmtPct = (frac, dp = 1) => {
  if (frac == null || Number.isNaN(frac)) return '—'
  const sign = frac < 0 ? '' : '+'
  return `${sign}${(frac * 100).toFixed(dp)}%`
}

export const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')

// Compact duration from milliseconds: "3d 4h", "5h 12m", "8m", "45s".
export const fmtDuration = (ms) => {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}

// Display name for a coin: builder-dex markets come prefixed ("xyz:SP500");
// show just "SP500" (keep the full id for API calls and React keys).
export const coinLabel = (c) => (c && c.includes(':') ? c.split(':')[1] : c || '')

// Friendly name for a perp dex. "" is Hyperliquid's main dex; the rest are
// HIP-3 builder dexes. Falls back to the upper-cased code for any new dex.
const DEX_LABELS = {
  '': 'Hyperliquid',
  xyz: 'XYZ',
  flx: 'Felix',
  vntl: 'Ventuals',
  hyna: 'HyENA',
  km: 'Kinetiq',
  abcd: 'ABCDEx',
  cash: 'dreamcash',
  para: 'Paragon',
}
export const dexLabel = (d) => DEX_LABELS[d] ?? (d ? d.toUpperCase() : 'Hyperliquid')

// Best-effort TradingView chart link for a Hyperliquid market. Main-dex coins
// are crypto perps, so we point at the closest analog — the Binance USDT perp
// (BINANCE:BTCUSDT.P). Builder-dex markets (xyz:TSLA, vntl:SPACEX, xyz:GOLD…)
// are equities/commodities/pre-IPO, so we pass the bare ticker and let
// TradingView's symbol search resolve the right listing.
export const tradingViewUrl = (coin) => {
  if (!coin) return 'https://www.tradingview.com/'
  const ticker = coinLabel(coin).toUpperCase()
  const symbol = coin.includes(':') ? ticker : `BINANCE:${ticker}USDT.P`
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`
}

// Hyperliquid's own per-market icon. The name includes the dex prefix for
// builder markets (e.g. "xyz:GOLD"). Missing icons return an HTML page rather
// than a 404, so render via <img> with an onError fallback.
export const coinIconUrl = (coin) => (coin ? `https://app.hyperliquid.xyz/coins/${coin}.svg` : '')

export const fmtPx = (n) => {
  if (n == null || Number.isNaN(n)) return '—'
  // More decimals for sub-dollar coins.
  const dp = n >= 1000 ? 2 : n >= 1 ? 3 : 5
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: dp })}`
}

// Bare price (no $ prefix) for table cells, dynamic precision like Hyperliquid.
export const fmtPrice = (n) => {
  if (n == null || Number.isNaN(n)) return '—'
  const dp = n >= 1000 ? 2 : n >= 1 ? 4 : 6
  return n.toLocaleString('en-US', { maximumFractionDigits: dp })
}
