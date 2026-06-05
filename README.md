# Hypervault

A desktop web dashboard for **following Hyperliquid vaults** and copy-trading their
coins into **your own** account — instead of depositing into the vault. You watch a
vault's live positions in a Hyperliquid-style table, then click **Mirror** on any coin
to open the same direction in your account with **your** chosen leverage, margin mode,
and USD size.

- **Backend** — FastAPI (Python) holding your signing key locally and placing orders via
  the official `hyperliquid-python-sdk`. Read-only vault/account data needs no key.
- **Frontend** — React + Vite, dark mint theme modeled on Hyperliquid's Positions tab.
- **Network** — mainnet (configurable).

> ⚠️ **Real money.** When armed, this sends real market orders on Hyperliquid mainnet.
> Read the Safety section before arming.

---

## Safety model

The app boots in **SAFE** mode. You flip the **ARM** switch (top-right) to place real orders.

| Guard | What it does |
|-------|--------------|
| **SAFE / ARM switch** | In SAFE, `/api/order` only *simulates* (computes size/price from public mark prices, sends nothing). Live orders require ARM. Arming shows a confirmation. The flag is in-memory — restarting the backend resets to SAFE. |
| **Per-order confirm** | The trade modal shows exact coin / side / size / leverage / est. cost before you submit. When armed, the submit button turns red and names the live order. |
| **Notional guardrail** | The backend rejects any single order above `MAX_ORDER_NOTIONAL_USD` (default $2,000). |
| **API wallet** | Strongly recommended: sign with a Hyperliquid **API wallet** (can trade, **cannot withdraw**) rather than your main wallet key. Limits the blast radius if the key leaks. |

---

## Prerequisites

- **Python 3.14** (the bundled venv was built with it; 3.11+ works) and [`uv`](https://docs.astral.sh/uv/) (optional but used below).
- **Node 18+** (built/tested on Node 22).

---

## Setup

### 1. Backend

```powershell
cd D:\programmering\2026\hypervault\backend

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

### 2. Frontend

```powershell
cd D:\programmering\2026\hypervault\frontend
npm install
```

---

## Run

Two terminals:

```powershell
# Terminal 1 — backend (from backend/)
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2 — frontend (from frontend/)
npm run dev
```

Open **http://localhost:5174**. The Vite dev server proxies `/api/*` to the backend on
port 8000, so there's no CORS to configure in dev.

---

## Using it

1. **Follow a vault** — the address box is prefilled with the *Systemic Strategies
   HyperGrowth* vault. Click **change** to paste any vault (or any wallet) `0x…` address.
   Its live positions render every 5 s.
2. **Mirror a coin** — click **Mirror** on a row. The modal opens prefilled with that
   coin and the vault's direction. Adjust **Long/Short**, **leverage** (capped at the
   coin's max), **Cross/Isolated**, and the **USD amount**. It shows estimated size,
   margin, and mark price.
3. **Simulate or trade** — in **SAFE** mode the button simulates. Flip **ARM** (top-right,
   with confirmation) and the button becomes a red **Place LIVE** order.
4. **Manage** — your account equity and open positions show in the right rail; **Close**
   market-closes a position (requires ARM).

---

## API (backend)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/health` | network, trading configured?, armed?, account, guardrail |
| GET | `/api/meta` | per-coin max leverage, szDecimals, mark price |
| GET | `/api/vault/{address}` | vault details + parsed positions + margin summary |
| GET | `/api/account` | your positions + margin summary (needs key/address) |
| POST | `/api/arm` | `{armed: bool}` — flip SAFE/ARM |
| POST | `/api/order` | `{coin, side, notionalUsd, leverage, marginMode}` — simulate (SAFE) or place (ARM) |
| POST | `/api/leverage` | `{coin, leverage, marginMode}` — set leverage (ARM) |
| POST | `/api/close` | `{coin}` — market-close a position (ARM) |

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
