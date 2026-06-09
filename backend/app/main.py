"""Hypervault FastAPI app.

Read endpoints (vault + account state, meta) need no key. Trading endpoints
(order/leverage/close) require a signing key AND the ARM switch to be on; in
SAFE mode /api/order returns a simulation instead of sending anything.
"""
import asyncio
import logging
import time

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import settings, update_env_file
from .hl_info import (
    HLInfo,
    parse_candles,
    parse_margin_summary,
    parse_meta_ctxs,
    parse_positions,
    value_spot_balances,
)
from .hl_trade import HLTrader, TradingNotConfigured
from .models import ArmRequest, CloseRequest, CredentialsRequest, LeverageRequest, OrderRequest
from .safety import safety

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hypervault")

info = HLInfo(settings.base_url)
trader = HLTrader(settings)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(
        "hypervault backend up | network=%s | trading_configured=%s | account=%s",
        settings.network,
        trader.configured,
        trader.account_address,
    )
    yield
    await info.aclose()


app = FastAPI(title="Hypervault API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _valid_address(address: str) -> bool:
    return isinstance(address, str) and address.startswith("0x") and len(address) == 42


# --------------------------------------------------------------------------- #
# Read endpoints (no key required)                                            #
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "network": settings.network,
        "tradingConfigured": trader.configured,
        "armed": safety.armed,
        "accountAddress": trader.account_address,
        "maxOrderNotionalUsd": settings.max_order_notional_usd,
        "defaultSlippage": settings.default_slippage,
    }


@app.get("/api/meta")
async def meta():
    try:
        raw = await info.meta_and_asset_ctxs()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch meta: {exc}") from exc
    return parse_meta_ctxs(raw)


@app.get("/api/vault/{address}")
async def vault(address: str):
    address = address.strip()
    if not _valid_address(address):
        raise HTTPException(status_code=400, detail="Expected a 0x… 42-character address.")
    try:
        state, spot_state, mids = await asyncio.gather(
            info.clearinghouse_state(address),
            info.spot_clearinghouse_state(address),
            info.all_mids(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch positions: {exc}") from exc

    # Vault-specific metadata is best-effort: a normal wallet address has none.
    details = None
    try:
        details = await info.vault_details(address)
    except Exception:  # noqa: BLE001
        details = None

    spot_balances, spot_usd = value_spot_balances((spot_state or {}).get("balances", []), mids)
    summary = parse_margin_summary(state)
    summary["spotUsd"] = spot_usd

    return {
        "address": address,
        "details": details,
        "positions": parse_positions(state),
        "marginSummary": summary,
        "spotBalances": spot_balances,
    }


@app.get("/api/account")
async def account():
    address = trader.account_address
    if not address:
        raise HTTPException(
            status_code=409,
            detail="No account address. Set HL_SECRET_KEY or HL_ACCOUNT_ADDRESS in backend/.env.",
        )
    try:
        state, spot_state, mids = await asyncio.gather(
            info.clearinghouse_state(address),
            info.spot_clearinghouse_state(address),
            info.all_mids(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch account: {exc}") from exc

    summary = parse_margin_summary(state)
    spot_balances, spot_usd = value_spot_balances((spot_state or {}).get("balances", []), mids)
    perp_value = summary.get("accountValue") or 0.0
    summary["perpAccountValue"] = perp_value
    summary["spotUsd"] = spot_usd
    summary["totalValue"] = perp_value + spot_usd

    return {
        "address": address,
        "positions": parse_positions(state),
        "marginSummary": summary,
        "spotBalances": spot_balances,
    }


_INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
}


@app.get("/api/candles/{coin}")
async def candles(coin: str, interval: str = "1h", bars: int = 200):
    interval = interval.lower()
    step = _INTERVAL_MS.get(interval)
    if step is None:
        raise HTTPException(status_code=400, detail=f"Unsupported interval '{interval}'.")
    bars = max(10, min(int(bars), 1000))
    end = int(time.time() * 1000)
    start = end - bars * step
    try:
        raw = await info.candle_snapshot(coin, interval, start, end)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch candles: {exc}") from exc
    return {"coin": coin, "interval": interval, "candles": parse_candles(raw)}


# --------------------------------------------------------------------------- #
# Safety + trading endpoints                                                  #
# --------------------------------------------------------------------------- #
@app.post("/api/arm")
async def arm(req: ArmRequest):
    value = safety.set_armed(req.armed)
    logger.warning("ARM set to %s", "ARMED (live orders)" if value else "SAFE")
    return {"armed": value}


@app.post("/api/credentials")
async def set_credentials(req: CredentialsRequest):
    key = (req.secretKey or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Missing private key.")
    addr = (req.accountAddress or "").strip() or None
    if addr and not _valid_address(addr):
        raise HTTPException(status_code=400, detail="Account address must be a 0x… 42-character address.")
    try:
        effective = trader.set_credentials(key, addr)
    except Exception as exc:  # noqa: BLE001  (eth_account raises on a bad key)
        raise HTTPException(status_code=400, detail=f"Invalid private key: {exc}") from exc

    persisted = False
    warning = None
    if req.persist:
        try:
            update_env_file({"HL_SECRET_KEY": key, "HL_ACCOUNT_ADDRESS": addr or ""})
            persisted = True
        except Exception as exc:  # noqa: BLE001
            warning = f"Connected, but couldn't write backend/.env: {exc}"

    result = {"ok": True, "accountAddress": effective, "persisted": persisted}
    if warning:
        result["warning"] = warning
    return result


@app.post("/api/credentials/clear")
async def clear_credentials():
    trader.clear_credentials()
    safety.set_armed(False)  # can't trade once disconnected — drop to SAFE
    try:
        update_env_file({"HL_SECRET_KEY": "", "HL_ACCOUNT_ADDRESS": ""})
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}


def _require_trading() -> None:
    if not trader.configured:
        raise HTTPException(
            status_code=400,
            detail="Trading not configured. Add HL_SECRET_KEY to backend/.env and restart.",
        )


def _check_notional(notional: float) -> None:
    if notional < 10:
        raise HTTPException(status_code=400, detail="Minimum order notional on Hyperliquid is ~$10.")
    if notional > settings.max_order_notional_usd:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Order notional ${notional:,.2f} exceeds the guardrail of "
                f"${settings.max_order_notional_usd:,.2f}. Raise MAX_ORDER_NOTIONAL_USD to allow."
            ),
        )


@app.post("/api/order")
async def order(req: OrderRequest):
    _check_notional(req.notionalUsd)
    slippage = req.slippage if req.slippage is not None else settings.default_slippage

    # SAFE mode: simulate from public market data only — no key, never hits the
    # exchange endpoint. Lets you explore the full flow before configuring a key.
    if not safety.armed:
        try:
            metas = parse_meta_ctxs(await info.meta_and_asset_ctxs())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Preview failed: {exc}") from exc
        cm = metas.get(req.coin)
        if not cm or not cm.get("markPx"):
            raise HTTPException(status_code=404, detail=f"No market data for '{req.coin}'.")
        mark = cm["markPx"]
        szd = cm.get("szDecimals")
        size = round(req.notionalUsd / mark, szd if szd is not None else 4)
        return {
            "simulated": True,
            "armed": False,
            "message": "SAFE mode — no order sent. Flip ARM to trade live.",
            "would": {
                "coin": req.coin,
                "markPx": mark,
                "size": size,
                "notionalUsd": size * mark,
                "side": req.side,
                "leverage": req.leverage,
                "marginMode": req.marginMode,
                "slippage": slippage,
            },
        }

    # Armed: a real order — this requires a configured signing key.
    _require_trading()
    is_buy = req.side == "long"
    is_cross = req.marginMode == "cross"
    try:
        result = await asyncio.to_thread(
            trader.place_market, req.coin, is_buy, req.notionalUsd, req.leverage, is_cross, slippage
        )
    except TradingNotConfigured as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Order failed: {exc}") from exc
    return {"simulated": False, "armed": True, **result}


@app.post("/api/leverage")
async def leverage(req: LeverageRequest):
    _require_trading()
    if not safety.armed:
        raise HTTPException(status_code=409, detail="SAFE mode — flip ARM to change leverage on-chain.")
    is_cross = req.marginMode == "cross"
    try:
        result = await asyncio.to_thread(trader.set_leverage, req.coin, req.leverage, is_cross)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Set leverage failed: {exc}") from exc
    return {"result": result}


@app.post("/api/close")
async def close(req: CloseRequest):
    _require_trading()
    if not safety.armed:
        raise HTTPException(status_code=409, detail="SAFE mode — flip ARM to close positions.")
    try:
        result = await asyncio.to_thread(trader.close_position, req.coin)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Close failed: {exc}") from exc
    return {"result": result}
