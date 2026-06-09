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
