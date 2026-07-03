import { useEffect, useState } from 'react'
import { coinIconUrl, coinLabel } from '../format.js'

// Hyperliquid's own market icon, with a graceful fallback. Missing icons (some
// builder markets, spot tokens) fall back to an initial-letter chip so rows
// never show a broken image. Used wherever a coin is named across the app.
export default function CoinIcon({ coin, size = 18, className = '' }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [coin]) // re-try when the coin changes

  if (!coin) return null
  const dim = { width: size, height: size }
  const cls = `coin-icon ${className}`.trim()

  if (broken) {
    return (
      <span className={`${cls} coin-icon-fallback`} style={dim} aria-hidden="true">
        {coinLabel(coin).slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      className={cls}
      style={dim}
      src={coinIconUrl(coin)}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  )
}
