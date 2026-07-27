// Thin client over the backend API. In dev the paths are relative and Vite
// proxies /api to FastAPI (see vite.config.js). Served from GitHub Pages there
// is no proxy, so we call the backend running on YOUR machine directly —
// browsers allow an https page to fetch http://127.0.0.1 (loopback is a
// "potentially trustworthy origin"), and the backend's CORS list includes the
// github.io origin. The site therefore only shows data while your local
// backend is up.
const API_BASE = window.location.hostname.endsWith('.github.io') ? 'http://127.0.0.1:8001' : ''

async function handle(res) {
  if (res.ok) return res.status === 204 ? null : res.json()
  let detail = res.statusText
  try {
    const body = await res.json()
    detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch {
    /* response had no JSON body */
  }
  throw new Error(detail)
}

const post = (path, body) =>
  fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle)

export const getHealth = () => fetch(API_BASE + '/api/health').then(handle)
export const getMeta = () => fetch(API_BASE + '/api/meta').then(handle)
export const getVault = (address) => fetch(API_BASE + `/api/vault/${address}`).then(handle)
export const getAccount = () => fetch(API_BASE + '/api/account').then(handle)
// Your persisted trade history (keyed by the connected address). `before` (ms) pages older.
export const getMyTrades = (limit = 80, before = 0) =>
  fetch(API_BASE + `/api/account/trades?limit=${limit}${before ? `&before=${before}` : ''}`).then(handle)
export const getPeers = (addresses) =>
  fetch(API_BASE + `/api/peers?addresses=${addresses.map(encodeURIComponent).join(',')}`).then(handle)
export const getFills = (addresses, hours = 24, limit = 60) =>
  fetch(
    API_BASE +
      `/api/fills?addresses=${addresses.map(encodeURIComponent).join(',')}&hours=${hours}&limit=${limit}`,
  ).then(handle)
// Live order book (websocket-fed on the backend — cheap to poll fast).
// `sig`/`mantissa` group levels into coarser price buckets (Hyperliquid's
// nSigFigs/mantissa); 0 = the coin's native tick.
export const getBook = (coin, levels = 12, sig = 0, mantissa = 0) =>
  fetch(
    API_BASE +
      `/api/book/${encodeURIComponent(coin)}?levels=${levels}${sig ? `&sig=${sig}` : ''}${
        mantissa ? `&mantissa=${mantissa}` : ''
      }`,
  ).then(handle)
// Recent public trades for a coin (the tape). `since` (ms) returns only newer
// trades, so poll with the newest time you've seen as a cursor.
export const getTrades = (coin, since = 0) =>
  fetch(API_BASE + `/api/trades/${encodeURIComponent(coin)}?since=${since}`).then(handle)
// `before` (ms) loads an older window ending at that time, for lazy-loading history.
export const getCandles = (coin, interval = '1h', bars = 200, before = 0) =>
  fetch(
    API_BASE +
      `/api/candles/${encodeURIComponent(coin)}?interval=${interval}&bars=${bars}${
        before ? `&before=${before}` : ''
      }`,
  ).then(handle)

// Spot pairs ("HYPE/USDC" …) with mark prices, for the order ticket's Spot tab.
export const getSpotMeta = () => fetch(API_BASE + '/api/spot/meta').then(handle)

export const setArm = (armed) => post('/api/arm', { armed })
export const placeOrder = (payload) => post('/api/order', payload)
// Spot market buy/sell — actually owning the tokens, no leverage.
export const placeSpotOrder = (payload) => post('/api/spot/order', payload)
export const setLeverage = (payload) => post('/api/leverage', payload)
export const closePosition = (coin) => post('/api/close', { coin })
// Partial close: `size` is in coin units (e.g. half the position size).
export const reducePosition = (coin, size) => post('/api/close', { coin, size })
// Auto-close: reduce-only take-profit / stop-loss trigger orders.
export const setTpsl = (payload) => post('/api/tpsl', payload)

export const setCredentials = (payload) => post('/api/credentials', payload)
export const clearCredentials = () => post('/api/credentials/clear', {})
