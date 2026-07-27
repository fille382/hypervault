// Click-to-place price alerts, persisted per coin in localStorage (same
// pattern as trendlines). App.jsx runs checkAlerts() against every fresh
// mark-price sweep; fired notices persist here so the Trade history panel
// can show them alongside your fills. Components sync via window events.
//
// Drawn trendlines are alert-aware too: a line's two anchors define its
// price at any moment (linear through t1/p1 → t2/p2, extended forward), so
// every sweep also checks whether the market is closing in on — or has
// crossed — each line you've drawn.

import { loadTrendStore, saveTrendStore } from './trendlines.js'
import { fmtPrice, coinLabel } from './format.js'

const ALERT_KEY = 'hypervault.priceAlerts'
const NOTICE_KEY = 'hypervault.alertNotices'
export const ALERTS_EVENT = 'hypervault:alertsChanged'
export const NOTICES_EVENT = 'hypervault:alertNoticesChanged'

// "Closing in" fires when the mark price gets within NEAR_PCT of the level;
// retreating past REARM_PCT re-arms it so price hovering near the line
// doesn't refire forever. Crossing the level fires "hit" and removes the
// alert — one-shot, like a TradingView alert.
export const NEAR_PCT = 0.5
const REARM_PCT = 1.2
const NOTICES_MAX = 200
// A choppy market sitting right on a trendline flips sides constantly —
// don't fire another cross notice for the same line inside this window.
const CROSS_COOLDOWN_MS = 5 * 60 * 1000

const emit = (name) => window.dispatchEvent(new Event(name))

export function loadAlertStore() {
  try {
    const obj = JSON.parse(localStorage.getItem(ALERT_KEY) || '{}')
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function saveAlertStore(store) {
  try {
    localStorage.setItem(ALERT_KEY, JSON.stringify(store))
  } catch {
    /* ignore storage errors */
  }
  emit(ALERTS_EVENT)
}

// `basePx` is where the market was when the alert was placed — it decides
// which side the price approaches from (and thus what "crossing" means).
export function addAlert(coin, px, basePx) {
  const store = loadAlertStore()
  const alert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    px,
    basePx,
    // Placed inside the approach band already? Start in 'near' so the
    // "closing in" notice doesn't fire instantly — only the actual hit will.
    state: (Math.abs(basePx - px) / px) * 100 <= NEAR_PCT ? 'near' : 'armed',
    createdAt: Date.now(),
  }
  store[coin] = [...(store[coin] || []), alert]
  saveAlertStore(store)
  return alert
}

export function removeAlert(coin, id) {
  const store = loadAlertStore()
  const kept = (store[coin] || []).filter((a) => a.id !== id)
  if (kept.length) store[coin] = kept
  else delete store[coin]
  saveAlertStore(store)
}

export function loadNotices() {
  try {
    const arr = JSON.parse(localStorage.getItem(NOTICE_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveNotices(list) {
  try {
    localStorage.setItem(NOTICE_KEY, JSON.stringify(list))
  } catch {
    /* ignore storage errors */
  }
  emit(NOTICES_EVENT)
}

export function removeNotice(id) {
  saveNotices(loadNotices().filter((n) => n.id !== id))
}

// The trendline's price at unix-seconds t — the segment's two anchors define
// the slope, and the line keeps that trajectory forward past its second point.
export function lineValueAt(ln, t) {
  if (ln.t2 === ln.t1) return null
  return ln.p1 + ((ln.p2 - ln.p1) * (t - ln.t1)) / (ln.t2 - ln.t1)
}

// Human-readable text for a fired notice — shared by the toast and the
// Trade history row so both always say the same thing. Crosses carry the
// direction: breaking upward through the level reads "crossed high",
// breaking downward "crossed low".
export function noticeText(n) {
  const at = fmtPrice(n.px)
  const cross = n.dir === 'up' ? '▲ crossed high' : n.dir === 'down' ? '▼ crossed low' : 'crossed'
  switch (n.kind) {
    case 'hit':
      return `${coinLabel(n.coin)} ${cross} through your alert at ${at}`
    case 'line-cross':
      return `${coinLabel(n.coin)} ${cross} ${n.dir === 'up' ? 'over' : 'under'} your trendline at ${at}`
    case 'line-near':
      return `${coinLabel(n.coin)} closing in on your trendline at ${at} · ${n.distPct.toFixed(2)}% away`
    default:
      return `${coinLabel(n.coin)} closing in on ${at} · ${n.distPct.toFixed(2)}% away`
  }
}

// Check every drawn trendline against the latest mark prices. Alert state
// lives on the line objects themselves (alertSide/alertState/lastCrossAt in
// the trendline store) so it survives reloads; drawing code ignores it.
function checkTrendlines(meta) {
  const store = loadTrendStore()
  const fired = []
  let changed = false
  const nowSec = Date.now() / 1000
  for (const [coin, lines] of Object.entries(store)) {
    const markPx = meta?.[coin]?.markPx
    if (!markPx) continue
    for (const ln of lines) {
      if (nowSec < ln.t1) continue // line starts in the future
      const value = lineValueAt(ln, nowSec)
      if (value == null || value <= 0) continue // vertical or extrapolated below zero
      const distPct = (Math.abs(markPx - value) / value) * 100
      const side = markPx > value ? 1 : markPx < value ? -1 : 0
      if (ln.alertSide == null) {
        // First sighting (or a line drawn pre-feature): record the side
        // quietly — only future movement should make noise.
        ln.alertSide = side
        changed = true
        continue
      }
      if (side !== 0 && ln.alertSide !== 0 && side !== ln.alertSide) {
        ln.alertSide = side
        ln.alertState = 'near' // a cross IS the approach — don't also fire "closing in"
        changed = true
        if (!ln.lastCrossAt || Date.now() - ln.lastCrossAt > CROSS_COOLDOWN_MS) {
          ln.lastCrossAt = Date.now()
          fired.push({
            coin,
            px: value,
            markPx,
            distPct,
            kind: 'line-cross',
            dir: side === 1 ? 'up' : 'down', // where the market ended up
          })
        }
        continue
      }
      if (side !== ln.alertSide) {
        ln.alertSide = side // exact-touch (side 0) bookkeeping
        changed = true
      }
      if ((ln.alertState || 'armed') === 'armed' && distPct <= NEAR_PCT) {
        ln.alertState = 'near'
        changed = true
        fired.push({ coin, px: value, markPx, distPct, kind: 'line-near' })
      } else if (ln.alertState === 'near' && distPct > REARM_PCT) {
        ln.alertState = 'armed' // price backed off — allow a fresh approach notice
        changed = true
      }
    }
  }
  if (changed) saveTrendStore(store)
  return fired
}

// Compare every alert AND drawn trendline with the latest mark prices
// (meta[coin].markPx). Mutates alert states, persists changes, records fired
// notices, and returns them so the caller can toast:
// [{ id, time, coin, px, markPx, distPct, kind: 'near'|'hit'|'line-near'|'line-cross' }].
export function checkAlerts(meta) {
  const store = loadAlertStore()
  const fired = []
  let changed = false
  for (const [coin, alerts] of Object.entries(store)) {
    const markPx = meta?.[coin]?.markPx
    if (!markPx) continue
    const keep = []
    for (const a of alerts) {
      // Placed exactly at the mark price: no approach side yet — anchor to
      // the first tick that moves away, so the cross test has a sign.
      if (a.basePx === a.px && markPx !== a.px) {
        a.basePx = markPx
        changed = true
      }
      const distPct = (Math.abs(markPx - a.px) / a.px) * 100
      const crossed = markPx === a.px || (markPx - a.px) * (a.basePx - a.px) < 0
      if (crossed) {
        // Approached from above → broke downward; from below → broke upward.
        fired.push({
          coin,
          px: a.px,
          markPx,
          distPct,
          kind: 'hit',
          dir: a.basePx > a.px ? 'down' : 'up',
        })
        changed = true
        continue // one-shot: the alert is done, drop it
      }
      if (a.state === 'armed' && distPct <= NEAR_PCT) {
        fired.push({ coin, px: a.px, markPx, distPct, kind: 'near' })
        a.state = 'near'
        changed = true
      } else if (a.state === 'near' && distPct > REARM_PCT) {
        a.state = 'armed' // price backed off — allow a fresh approach notice
        changed = true
      }
      keep.push(a)
    }
    if (keep.length) store[coin] = keep
    else delete store[coin]
  }
  if (changed) saveAlertStore(store)
  fired.push(...checkTrendlines(meta))
  if (!fired.length) return []
  const now = Date.now()
  const stamped = fired.map((f, i) => ({
    ...f,
    id: `${now}-${i}-${Math.random().toString(36).slice(2, 7)}`,
    time: now,
  }))
  saveNotices([...stamped, ...loadNotices()].slice(0, NOTICES_MAX))
  return stamped
}
