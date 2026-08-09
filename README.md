# Hypervault

A web dashboard for **following Hyperliquid vaults** and copy-trading their coins into
**your own** account — instead of depositing into the vault. You watch a vault's live
positions in a Hyperliquid-style table next to a full trading chart, then click
**Mirror** on any coin to open the same direction in your account with **your** chosen
leverage, margin mode, and USD size.

**Live site: <https://fille382.github.io/hypervault/>** — works on any machine where
your backend is running (see [The live site](#the-live-site) below).

- **Backend** — FastAPI (Python) holding your signing key locally and placing orders via
  the official `hyperliquid-python-sdk`. Read-only vault/market data needs no key.
- **Frontend** — React + Vite + lightweight-charts, dark mint theme modeled on
  Hyperliquid's own UI.
- **Network** — mainnet (configurable).

> ⚠️ **Real money.** When armed, this sends real market orders on Hyperliquid mainnet.
> Read the Safety section before arming.

---

## What you get

- **Chart-first layout** — candles for any Hyperliquid coin (5m → 1M), lazy-loading
  history, a searchable coin picker, and a fullscreen BTC daily macro chart.
- **Live order book & tape** — websocket-fed on the backend, grouped price levels,
  buy/sell pressure, market-pulse events (walls eaten, large prints).
- **Chart tools** — trendlines (with cross notifications), price alerts, a drag-to-measure
  tool, and your own fills plotted as dots at the exact fill price.
- **Vault following** — any vault or wallet address; positions, balances, trade history,
  and funding refresh live. Save multiple vaults; their fills stream into an activity
  feed with toasts.
- **Top traders** — Hyperliquid's leaderboard built in (🏆 button): rank by PnL, ROI,
  or volume over 24h/7d/30d/all-time, expand a row for win rate, average hold time,
  favourite markets and a PnL sparkline, then follow any wallet with one click — it
  gets the full vault treatment above.
- **Copy-trading** — Mirror any position with your own size/leverage, partial closes,
  take-profit/stop-loss triggers, spot buys, all behind the safety rails below.

---

## The live site

GitHub Pages serves the **static frontend only**. It talks to the backend running on
**your own machine** (`http://127.0.0.1:8001`) — your key and your orders never touch
any server. On a machine without the backend, the site just shows
"● Backend offline" — nobody else can see your data or trade.

**Don't have the backend yet?** One-line install — paste into a normal PowerShell
window (needs git and Python 3.11+, no admin rights):

```powershell
irm https://raw.githubusercontent.com/fille382/hypervault/master/scripts/install.ps1 | iex
```

It clones the repo into `%USERPROFILE%\hypervault`, sets up the venv and
dependencies, registers the `hypervault://` protocol, and starts the backend.
Safe to re-run — an existing install just gets updated. The live site offers the
same command via the **⤓ install** link in the offline banner. Trading needs your
key in `backend\.env` afterwards (see [Setup](#setup)); the viewer works keyless.

**Already cloned the repo?** One-time setup (after [Setup](#setup) below):

```powershell
# Registers the hypervault:// link protocol for your user (no admin needed).
# IMPORTANT: run this yourself in a normal PowerShell window — it must run in
# YOUR shell session for the browser to pick it up.
powershell -ExecutionPolicy Bypass -File scripts\register-backend-protocol.ps1
```

From then on the loop is:

1. Open <https://fille382.github.io/hypervault/>.
2. If the backend is off, the red banner offers **▶ start backend** — click it.
   (First ever click: the browser asks "Open Hypervault backend starter?" —
   tick **Always allow**.)
3. A minimized terminal appears in your taskbar, the banner clears, data flows.

The backend always boots in **SAFE** mode — flip ARM in the UI when you intend to trade.

---

## Safety model

The app boots in **SAFE** mode. You flip the **ARM** switch (top-right) to place real orders.

| Guard | What it does |
|-------|--------------|
| **SAFE / ARM switch** | In SAFE, `/api/order` only *simulates* (computes size/price from public mark prices, sends nothing). Live orders require ARM. Arming shows a confirmation. The flag is in-memory — restarting the backend resets to SAFE. |
| **Per-order confirm** | The trade modal shows exact coin / side / size / leverage / est. cost before you submit. When armed, the submit button turns red and names the live order. |
| **Notional guardrail** | The backend rejects any single order above `MAX_ORDER_NOTIONAL_USD` (default $2,000). |
| **API wallet** | Strongly recommended: sign with a Hyperliquid **API wallet** (can trade, **cannot withdraw**) rather than your main wallet key. Limits the blast radius if the key leaks. |
| **Local-only backend** | The API binds to `127.0.0.1` and allows only known origins (localhost dev + the Pages site) via CORS. Nothing outside your machine can reach it. |

---

## Prerequisites

- **Python 3.14** (3.11+ works) and [`uv`](https://docs.astral.sh/uv/) (optional but used below).
- **Node 18+** (built/tested on Node 22).
- Windows for the helper scripts (`start-backend.ps1`, protocol registration); the
  backend/frontend themselves are cross-platform.

---

## Setup

### 1. Backend

```powershell
cd backend

# create the virtualenv + install deps (with uv)
uv venv .venv --python 3.14
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

# …or with plain pip:
# py -3.14 -m venv .venv
# .venv\Scripts\python -m pip install -r requirements.txt
```

Then create your config from the template:

```powershell
copy .env.example .env
```

Edit **`backend/.env`**:

```ini
HL_SECRET_KEY=0x...            # your API-wallet private key (see below)
HL_ACCOUNT_ADDRESS=0x...       # your MAIN account address (the one with funds)
HL_NETWORK=mainnet
MAX_ORDER_NOTIONAL_USD=2000    # hard cap per order
DEFAULT_SLIPPAGE=0.01          # 1% market-order slippage
```

**Creating an API wallet** (recommended): on the Hyperliquid website, open the
top-right menu → **API** → generate an API wallet and approve it. Put that wallet's
private key in `HL_SECRET_KEY`, and your normal account's `0x…` address in
`HL_ACCOUNT_ADDRESS`. The API wallet can place/cancel orders but cannot withdraw funds.

> If instead you use your *main* wallet's own private key, you can leave
> `HL_ACCOUNT_ADDRESS` blank — it's derived from the key.
>
> The vault **viewer** works with no key at all; you just can't place orders.

### 2. Frontend (only needed for local development)

```powershell
cd frontend
npm install
```

### 3. One-click starter (optional, for the live site)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-backend-protocol.ps1
```

Run it **yourself, once, in a normal PowerShell window** (re-run if you move the
repo). It registers the `hypervault://` protocol so the live site's
**▶ start backend** button can launch `start-backend.ps1` from the browser.

---

## Run

**Everyday use:** open the [live site](https://fille382.github.io/hypervault/) and click
**▶ start backend** if prompted — that's it. Or start the backend yourself:

```powershell
.\start-backend.ps1   # frees port 8001, then runs uvicorn on 127.0.0.1:8001
```

**Local development** (two terminals):

```powershell
# Terminal 1 — backend
.\start-backend.ps1

# Terminal 2 — frontend (from frontend/)
npm run dev
```

Open **http://localhost:5174**. The Vite dev server proxies `/api/*` to the backend on
port 8001, so there's no CORS to configure in dev.

---

## Using it

1. **Pick a coin** — the coin picker (or any position row) loads its chart, order book,
   and tape. Timeframes 5m → 1M; scroll left for deep history.
2. **Follow a vault** — the address box is prefilled with the *Systemic Strategies
   HyperGrowth* vault. Click **change** to paste any vault (or wallet) `0x…` address.
   Saved vaults' fills stream into the activity feed.
3. **Mirror a coin** — click **Mirror** on a row. The modal opens prefilled with that
   coin and the vault's direction. Adjust **Long/Short**, **leverage**, **Cross/Isolated**,
   and the **USD amount**; it shows estimated size, margin, and mark price.
4. **Simulate or trade** — in **SAFE** mode the button simulates. Flip **ARM** (top-right,
   with confirmation) and the button becomes a red **Place LIVE** order.
5. **Manage** — your equity and open positions live in the account panel; partial or
   full **Close**, **TP/SL** triggers, and leverage changes all require ARM.
6. **Draw** — trendlines and price alerts notify you (toast + history) when the market
   closes in or crosses; the measure tool reads % moves off the chart.

---

## Deploying the frontend

Pushes to `master` that touch `frontend/` auto-deploy to GitHub Pages via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) (Vite build with
`--base=/hypervault/`). Pages caches `index.html` for ~10 minutes — hard-refresh
(Ctrl+F5) if you don't see a fresh deploy yet.

---

## API (backend)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | network, trading configured?, armed?, account, guardrail |
| GET | `/api/meta` | per-coin max leverage, szDecimals, mark price, funding, OI |
| GET | `/api/spot/meta` | spot pairs with mark prices |
| GET | `/api/vault/{address}` | vault details + parsed positions + margin summary |
| GET | `/api/account` | your positions + margin summary (needs key/address) |
| GET | `/api/account/trades` | your persisted fill history (paged with `before`) |
| GET | `/api/peers` | positions for saved vault addresses |
| GET | `/api/fills` | recent fills for saved vaults (activity feed) |
| GET | `/api/leaderboard` | top traders; `window` day/week/month/allTime, `sort` pnl/roi/vlm, `minAccountValue` |
| GET | `/api/trader/{address}` | trader profile: PnL history per window, win rate, avg hold, top markets |
| GET | `/api/candles/{coin}` | OHLCV, locally cached; `interval`, `bars`, `before` |
| GET | `/api/book/{coin}` | live order book (websocket-fed); `levels`, `sig`, `mantissa` |
| GET | `/api/trades/{coin}` | recent public trades (the tape); `since` cursor |
| POST | `/api/arm` | `{armed: bool}` — flip SAFE/ARM |
| POST | `/api/order` | `{coin, side, notionalUsd, leverage, marginMode}` — simulate (SAFE) or place (ARM) |
| POST | `/api/spot/order` | spot market buy/sell (ARM) |
| POST | `/api/leverage` | `{coin, leverage, marginMode}` — set leverage (ARM) |
| POST | `/api/close` | `{coin, size?}` — market-close a position, fully or partially (ARM) |
| POST | `/api/tpsl` | reduce-only take-profit / stop-loss triggers (ARM) |
| POST | `/api/credentials` | connect a signing key from the UI |
| POST | `/api/credentials/clear` | forget the signing key |

---

## Notes & caveats

- **First live order:** once armed, do a small test first (e.g. ~$12 notional, above the
  ~$10 Hyperliquid minimum) to confirm signing works with your key before sizing up.
- Orders are **market** orders with `DEFAULT_SLIPPAGE` tolerance. Limit orders aren't
  exposed in the UI yet.
- The notional guardrail and SAFE default are the main protections — keep
  `MAX_ORDER_NOTIONAL_USD` sane for your account.
- This tool does not auto-follow — mirroring is one click per coin, by design, so you stay
  in control of size and leverage.
- Hyperliquid's public API allows ~1200 request-weight/min per IP; the backend budgets
  reads below that and serves candles/fills from local SQLite caches, so the dashboard
  can't starve the trading path.
