// Thin client over the backend API. All paths are relative and proxied to
// the FastAPI server by Vite (see vite.config.js).

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
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle)

export const getHealth = () => fetch('/api/health').then(handle)
export const getMeta = () => fetch('/api/meta').then(handle)
export const getVault = (address) => fetch(`/api/vault/${address}`).then(handle)
export const getAccount = () => fetch('/api/account').then(handle)
export const getCandles = (coin, interval = '1h', bars = 200) =>
  fetch(`/api/candles/${encodeURIComponent(coin)}?interval=${interval}&bars=${bars}`).then(handle)

export const setArm = (armed) => post('/api/arm', { armed })
export const placeOrder = (payload) => post('/api/order', payload)
export const setLeverage = (payload) => post('/api/leverage', payload)
export const closePosition = (coin) => post('/api/close', { coin })

export const setCredentials = (payload) => post('/api/credentials', payload)
export const clearCredentials = () => post('/api/credentials/clear', {})
