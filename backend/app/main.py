"""Hypervault FastAPI app.

Read endpoints (vault + account state, meta) need no key. Trading endpoints
(order/leverage/close) require a signing key AND the ARM switch to be on; in
SAFE mode /api/order returns a simulation instead of sending anything.
"""
import asyncio
import json
import logging
import time

from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .candle_store import CandleStore
from .config import BACKEND_DIR, settings, update_env_file
from .fill_store import FillStore
from .hl_info import (
    HLInfo,
    parse_candles,
    parse_fills,
    parse_margin_summary,
    parse_meta_ctxs,
    parse_positions,
    value_spot_balances,
)
from .hl_trade import HLTrader, TradingNotConfigured
from .hl_ws import HLWebSocketFeed, parse_book
from .models import (
    ArmRequest,
    CloseRequest,
    CredentialsRequest,
    LeverageRequest,
    OrderRequest,
    TpslRequest,
)
from .safety import safety

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hypervault")

info = HLInfo(settings.base_url)
trader = HLTrader(settings)
coingecko = httpx.AsyncClient(base_url="https://api.coingecko.com/api/v3", timeout=20.0)
# Local candle cache so we don't re-fetch closed bars from Hyperliquid every time.
candle_store = CandleStore(BACKEND_DIR / "data" / "candles.db")
# Durable per-address trade history (your own fills), persisted across sessions.
fill_store = FillStore(BACKEND_DIR / "data" / "trades.db")
# Live push feed from Hyperliquid: one connection, allMids always on, order
# books subscribed per coin on demand. Strictly less upstream load than polling.
ws_feed = HLWebSocketFeed(settings.base_url)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info(
        "hypervault backend up | network=%s | trading_configured=%s | account=%s",
        settings.network,
        trader.configured,
        trader.account_address,
    )
    ws_feed.start()
    yield
    await ws_feed.stop()
    await info.aclose()
    await coingecko.aclose()
    candle_store.close()
    fill_store.close()


app = FastAPI(title="Hypervault API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _valid_address(address: str) -> bool:
    return isinstance(address, str) and address.startswith("0x") and len(address) == 42


# Small TTL cache so the 5s UI poll doesn't hammer Hyperliquid with requests
# for data that changes slowly (builder dexes, spot balances, vault names).
# On upstream failure, a stale entry is served rather than erroring out.
_ttl_cache: dict[str, tuple[float, Any]] = {}


async def _cached(key: str, ttl: float, fetch) -> Any:
    now = time.time()
    hit = _ttl_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    try:
        value = await fetch()
    except Exception:
        if hit:
            return hit[1]
        raise
    _ttl_cache[key] = (now, value)
    return value


async def _mids() -> dict:
    """Mid prices: the live websocket snapshot when fresh, REST (TTL-cached) otherwise."""
    live = ws_feed.mids()
    if live is not None:
        return live
    return await _cached("mids", 15, info.all_mids)


# Builder-deployed perp dexes (HIP-3, e.g. xyz:SP500). Positions on them are
# invisible to a plain clearinghouseState call, so we query each dex too.
_dex_cache: dict = {"names": None, "ts": 0.0}


async def _builder_dexs() -> list[str]:
    now = time.time()
    if _dex_cache["names"] is None or now - _dex_cache["ts"] > 3600:
        try:
            raw = await info.perp_dexs()
            _dex_cache["names"] = [d["name"] for d in raw or [] if d and d.get("name")]
            _dex_cache["ts"] = now
        except Exception:  # noqa: BLE001 — keep last known list (or none) on failure
            if _dex_cache["names"] is None:
                _dex_cache["names"] = []
    return _dex_cache["names"]


async def _all_positions(address: str) -> tuple[list[dict], dict]:
    """Positions + margin summary aggregated across the main and builder dexes."""
    dexs = await _builder_dexs()

    def dex_fetch(d: str):
        return lambda: info.clearinghouse_state(address, dex=d)

    results = await asyncio.gather(
        info.clearinghouse_state(address),
        # Builder-dex positions refresh every 30s — they're niche markets and
        # 9x-ing the upstream request rate for them isn't worth it.
        *(_cached(f"dex:{d}:{address.lower()}", 30, dex_fetch(d)) for d in dexs),
        return_exceptions=True,
    )
    main = results[0]
    if isinstance(main, BaseException):
        raise main
    positions = parse_positions(main)
    summary = parse_margin_summary(main)
    for st in results[1:]:
        if isinstance(st, BaseException):
            continue  # one builder dex failing shouldn't hide the rest
        positions.extend(parse_positions(st))
        extra = parse_margin_summary(st)
        for key in (
            "accountValue",
            "totalMarginUsed",
            "totalNtlPos",
            "withdrawable",
            "totalUnrealizedPnl",
        ):
            if extra.get(key):
                summary[key] = (summary.get(key) or 0.0) + extra[key]
        summary["openPositions"] += extra["openPositions"]
    positions.sort(key=lambda r: (r["positionValue"] or 0.0), reverse=True)
    return positions, summary


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


async def _full_meta() -> dict:
    """Tradeable universe across the main dex AND HIP-3 builder dexes.

    Builder dexes (xyz, vntl, …) host markets like xyz:GOLD and vntl:SPACEX that
    a plain metaAndAssetCtxs call never returns. We fetch each one too and merge;
    names are dex-prefixed, so the keys never collide. Builder metas are cached
    (60s) — they're niche and this endpoint is polled every 15s.
    """
    result = parse_meta_ctxs(await info.meta_and_asset_ctxs())
    dexs = await _builder_dexs()

    async def dex_meta(d: str) -> dict:
        return parse_meta_ctxs(await info.meta_and_asset_ctxs(dex=d), dex=d)

    extra = await asyncio.gather(
        *(_cached(f"meta:{d}", 60, lambda d=d: dex_meta(d)) for d in dexs),
        return_exceptions=True,
    )
    for r in extra:
        if isinstance(r, dict):  # a single builder dex failing shouldn't drop the rest
            result.update(r)
    return result


@app.get("/api/meta")
async def meta():
    try:
        return await _full_meta()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch meta: {exc}") from exc


@app.get("/api/vault/{address}")
async def vault(address: str):
    address = address.strip()
    if not _valid_address(address):
        raise HTTPException(status_code=400, detail="Expected a 0x… 42-character address.")
    try:
        (positions, summary), spot_state, mids = await asyncio.gather(
            _all_positions(address),
            _cached(f"spot:{address.lower()}", 30, lambda: info.spot_clearinghouse_state(address)),
            _mids(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch positions: {exc}") from exc

    # Vault-specific metadata is best-effort: a normal wallet address has none.
    # The name basically never changes, so cache it for 10 minutes.
    try:
        details = await _cached(
            f"details:{address.lower()}", 600, lambda: info.vault_details(address)
        )
    except Exception:  # noqa: BLE001
        details = None

    spot_balances, spot_usd = value_spot_balances((spot_state or {}).get("balances", []), mids)
    summary["spotUsd"] = spot_usd

    return {
        "address": address,
        "details": details,
        "positions": positions,
        "marginSummary": summary,
        "spotBalances": spot_balances,
    }


@app.get("/api/peers")
async def peers(addresses: str):
    """Open positions for several addresses at once (the saved-vaults dropdown).

    Lightweight on purpose: only clearinghouseState per address — no spot, no
    vault details — so polling a handful of peers stays cheap.
    """
    addrs: list[str] = []
    for a in addresses.split(","):
        a = a.strip()
        if _valid_address(a) and a.lower() not in {x.lower() for x in addrs}:
            addrs.append(a)
    addrs = addrs[:10]

    async def one(addr: str) -> dict:
        try:
            state = await info.clearinghouse_state(addr)
            return {"address": addr, "positions": parse_positions(state)}
        except Exception:  # noqa: BLE001 — a dead peer shouldn't fail the batch
            return {"address": addr, "positions": [], "error": True}

    return {"peers": await asyncio.gather(*(one(a) for a in addrs))}


@app.get("/api/fills")
async def fills(addresses: str, hours: float = 24, limit: int = 60):
    """Recent fills for several addresses, merged newest-first.

    Powers the activity feed: real trade history from the exchange, so the
    feed is complete even for trades made while the app was closed.
    """
    addrs: list[str] = []
    for a in addresses.split(","):
        a = a.strip()
        if _valid_address(a) and a.lower() not in {x.lower() for x in addrs}:
            addrs.append(a)
    addrs = addrs[:10]
    hours = max(0.5, min(hours, 720.0))  # up to 30 days for "load more" history
    limit = max(1, min(limit, 1000))
    cutoff = int(time.time() * 1000) - int(hours * 3_600_000)

    async def one(addr: str) -> list[dict]:
        try:
            raw = await info.user_fills(addr)
        except Exception:  # noqa: BLE001 — a dead address shouldn't fail the batch
            return []
        return [
            {**f, "address": addr}
            for f in parse_fills(raw)
            if f.get("time") and f["time"] >= cutoff
        ]

    lists = await asyncio.gather(*(one(a) for a in addrs))
    merged = sorted((f for sub in lists for f in sub), key=lambda f: f["time"], reverse=True)
    return {"fills": merged[:limit]}


@app.get("/api/account")
async def account():
    address = trader.account_address
    if not address:
        raise HTTPException(
            status_code=409,
            detail="No account address. Set HL_SECRET_KEY or HL_ACCOUNT_ADDRESS in backend/.env.",
        )
    try:
        (positions, summary), spot_state, mids = await asyncio.gather(
            _all_positions(address),
            _cached(f"spot:{address.lower()}", 30, lambda: info.spot_clearinghouse_state(address)),
            _mids(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to fetch account: {exc}") from exc

    spot_balances, spot_usd = value_spot_balances((spot_state or {}).get("balances", []), mids)
    perp_value = summary.get("accountValue") or 0.0
    summary["perpAccountValue"] = perp_value
    summary["spotUsd"] = spot_usd
    summary["totalValue"] = perp_value + spot_usd

    return {
        "address": address,
        "positions": positions,
        "marginSummary": summary,
        "spotBalances": spot_balances,
    }


# Throttle userFills refreshes per address so the chart-marker poll and the
# trade-history card (two callers) don't each hit Hyperliquid every cycle —
# whichever lands first refreshes, the rest serve from the local store.
FILLS_REFRESH_TTL = 15.0
_fills_refresh: dict[str, float] = {}


@app.get("/api/account/trades")
async def account_trades(limit: int = 80, before: int = 0):
    """Your persisted trade history, keyed by the connected account address.

    On the live (newest) view we pull fresh fills from Hyperliquid and save any
    new ones; `before` (ms) pages into older history straight from the local DB.
    """
    address = trader.account_address
    if not address:
        raise HTTPException(
            status_code=409,
            detail="No account address. Connect a key (or set HL_ACCOUNT_ADDRESS).",
        )
    limit = max(1, min(int(limit), 500))
    key = address.lower()
    # Newest view: refresh from the exchange and persist — but at most once per
    # FILLS_REFRESH_TTL per address, so repeated/duplicate polls stay local.
    if before <= 0 and time.time() - _fills_refresh.get(key, 0.0) > FILLS_REFRESH_TTL:
        try:
            raw = await info.user_fills(address)
            await asyncio.to_thread(fill_store.upsert, address, parse_fills(raw))
            _fills_refresh[key] = time.time()
        except Exception:  # noqa: BLE001 — serve saved history if the fetch fails
            pass
    rows, total = await asyncio.gather(
        asyncio.to_thread(fill_store.query, address, limit, before),
        asyncio.to_thread(fill_store.count, address),
    )
    return {"address": address, "trades": rows, "total": total}


_INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
    "1M": 2_592_000_000,  # case matters: "1M" is a month, "1m" is a minute
}


# Candle cache: we store closed bars locally and only hit Hyperliquid for the
# live tail (throttled) or to backfill older history we don't have yet.
CANDLE_TAIL_TTL = 10.0  # seconds between live-tail refreshes per (coin, interval)
_candle_tail: dict[str, float] = {}  # key -> last tail-refresh time
_candle_floor: set[str] = set()  # keys where we've confirmed no older history exists


async def _fetch_into_store(coin: str, interval: str, start_ms: int, end_ms: int) -> None:
    """Fetch a candle range from Hyperliquid and upsert it into the local store."""
    raw = await info.candle_snapshot(coin, interval, start_ms, end_ms)
    await asyncio.to_thread(candle_store.upsert, coin, interval, parse_candles(raw))


@app.get("/api/candles/{coin}")
async def candles(coin: str, interval: str = "1h", bars: int = 200, before: int = 0):
    """Candles for a window of `bars` ending now, or ending at `before` (ms) for
    lazy-loading older history. Served from the local cache; Hyperliquid is hit
    only for the live tail (throttled) or to backfill a gap we don't hold yet."""
    if interval != "1M":
        interval = interval.lower()
    step = _INTERVAL_MS.get(interval)
    if step is None:
        raise HTTPException(status_code=400, detail=f"Unsupported interval '{interval}'.")
    bars = max(10, min(int(bars), 5000))  # Hyperliquid serves up to ~5000 candles/request
    is_live = before <= 0  # the live window refreshes the forming bar; a `before` window doesn't
    end = int(time.time() * 1000) if is_live else int(before)
    start = end - bars * step
    start_sec, end_sec = start // 1000, end // 1000
    key = f"{coin}:{interval}"

    earliest, latest = await asyncio.to_thread(candle_store.bounds, coin, interval)

    try:
        if latest is None:
            # Cold cache: fetch the whole requested window once.
            await _fetch_into_store(coin, interval, start, end)
        else:
            # Keep the live tail current (throttled — closed bars never change).
            if is_live and end_sec > latest and time.time() - _candle_tail.get(key, 0.0) > CANDLE_TAIL_TTL:
                await _fetch_into_store(coin, interval, latest * 1000, end)
                _candle_tail[key] = time.time()
            # Backfill older history if asked for more than we hold — but only
            # until we've confirmed Hyperliquid has nothing older (the floor).
            if start_sec < earliest and key not in _candle_floor:
                await _fetch_into_store(coin, interval, start, min(end, earliest * 1000))
                new_earliest, _ = await asyncio.to_thread(candle_store.bounds, coin, interval)
                if new_earliest is not None and new_earliest >= earliest:
                    _candle_floor.add(key)  # no older data exists — stop trying
    except Exception:  # noqa: BLE001 — upstream hiccup: serve whatever we have cached
        pass

    rows = await asyncio.to_thread(candle_store.query, coin, interval, start_sec, end_sec)
    if not rows and is_live:
        raise HTTPException(status_code=502, detail=f"No candle data for '{coin}'.")
    return {"coin": coin, "interval": interval, "candles": rows}


@app.get("/api/book/{coin}")
async def book(coin: str, levels: int = 15):
    """Live order book for a coin, served from the websocket feed.

    The first request for a coin subscribes it (and falls back to one REST
    snapshot while the subscription warms up); after that it's pure push data
    and this endpoint never touches Hyperliquid, so the UI can poll it fast.
    """
    levels = max(1, min(int(levels), 20))  # Hyperliquid sends up to 20 per side
    await ws_feed.ensure_book(coin)
    data = ws_feed.book(coin)
    if data is None:
        # Cold start: the ws subscription hasn't delivered yet. One REST
        # snapshot bridges the gap (throttled by the ws cache thereafter).
        try:
            data = parse_book(await info.l2_book(coin))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"Order book unavailable: {exc}") from exc
        if data is None:
            raise HTTPException(status_code=404, detail=f"No order book for '{coin}'.")
    bids, asks = data["bids"][:levels], data["asks"][:levels]
    best_bid = bids[0]["px"] if bids else None
    best_ask = asks[0]["px"] if asks else None
    spread = (best_ask - best_bid) if (best_bid and best_ask) else None
    mid = (best_ask + best_bid) / 2 if (best_bid and best_ask) else None
    return {
        "coin": coin,
        "time": data.get("time"),
        "live": ws_feed.book(coin) is not None,  # false only on the REST fallback
        "bids": bids,
        "asks": asks,
        "spread": spread,
        "spreadPct": (spread / mid * 100) if (spread is not None and mid) else None,
        "mid": mid,
    }


# --------------------------------------------------------------------------- #
# Total crypto market cap (CoinGecko)                                         #
# --------------------------------------------------------------------------- #
async def _fetch_mcap() -> dict:
    r = await coingecko.get("/global")
    r.raise_for_status()
    d = (r.json() or {}).get("data", {})
    return {
        "marketCap": (d.get("total_market_cap") or {}).get("usd"),
        "change24h": d.get("market_cap_change_percentage_24h_usd"),
    }


@app.get("/api/mcap")
async def mcap():
    try:
        return await _cached("mcap", 120, _fetch_mcap)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Market cap fetch failed: {exc}") from exc


# CoinGecko's true global history endpoint is paid; summing the biggest coins
# tracks the TOTAL curve closely, and we scale it to today's real global total.
_MCAP_COINS = ["bitcoin", "ethereum", "tether", "ripple", "binancecoin", "solana"]


# Persist the last good market-cap history to disk so a backend restart (which
# wipes the in-memory cache) serves it instead of hammering — and 502-ing on —
# CoinGecko's rate-limited free tier.
def _mcap_disk_path(days: str):
    return BACKEND_DIR / "data" / f"mcap_hist_{days}.json"


def _save_mcap_disk(days: str, data: dict) -> None:
    try:
        path = _mcap_disk_path(days)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _load_mcap_disk(days: str):
    try:
        path = _mcap_disk_path(days)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        pass
    return None


@app.get("/api/mcap/history")
async def mcap_history(days: str = "365"):
    if days not in {"90", "365", "max"}:
        days = "365"

    async def fetch():
        total: dict[int, float] = {}
        fetched = 0
        for i, cid in enumerate(_MCAP_COINS):  # sequential — free-tier rate limits
            if i:
                await asyncio.sleep(2.5)  # pace requests to dodge 429s
            try:
                r = await coingecko.get(
                    f"/coins/{cid}/market_chart", params={"vs_currency": "usd", "days": days}
                )
                r.raise_for_status()
            except Exception:  # noqa: BLE001 — tolerated below, up to one miss
                continue
            # Bucket to days, keeping the coin's LAST value per day — the feed
            # mixes granularities and adds a "latest" point that would
            # otherwise double-count today.
            per_day: dict[int, float] = {}
            for ts, cap in (r.json() or {}).get("market_caps", []) or []:
                if cap:
                    per_day[int(ts // 86_400_000) * 86_400] = cap
            for day, cap in per_day.items():
                total[day] = total.get(day, 0.0) + cap
            fetched += 1
        # Don't cache junk: a half-fetched, unscaled series would be served for
        # hours. Raise instead — _cached keeps any previous good copy, and rate
        # limits clear within a minute or two.
        if fetched < len(_MCAP_COINS) - 1:
            raise RuntimeError("CoinGecko rate limit — try again in a minute")
        points = sorted(total.items())
        if not points or not points[-1][1]:
            raise RuntimeError("Empty market cap series")
        cur = (await _cached("mcap", 120, _fetch_mcap)).get("marketCap")
        if not cur:
            raise RuntimeError("No global total to scale against")
        scale = cur / points[-1][1]
        result = {"points": [{"time": t, "value": v * scale} for t, v in points]}
        _save_mcap_disk(days, result)  # durable copy for cold starts
        return result

    try:
        return await _cached(f"mcapHist:{days}", 21_600, fetch)
    except Exception:  # noqa: BLE001
        # Rate-limited / cold cache — serve the last good copy from disk rather
        # than 502-ing. Only fails outright if we've never fetched it before.
        disk = _load_mcap_disk(days)
        if disk:
            return disk
        raise HTTPException(
            status_code=502, detail="Market cap history unavailable — retry in a minute."
        )


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
            metas = await _full_meta()  # includes builder-dex markets (xyz:GOLD, vntl:SPACEX, …)
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
        result = await asyncio.to_thread(trader.close_position, req.coin, req.size)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Close failed: {exc}") from exc
    return {"result": result}


@app.post("/api/tpsl")
async def tpsl(req: TpslRequest):
    _require_trading()
    if not safety.armed:
        raise HTTPException(status_code=409, detail="SAFE mode — flip ARM to set auto-close.")
    if req.takeProfitPx is None and req.stopLossPx is None:
        raise HTTPException(status_code=400, detail="Provide a take-profit and/or stop-loss price.")
    try:
        result = await asyncio.to_thread(
            trader.set_tpsl, req.coin, req.isLong, req.size, req.takeProfitPx, req.stopLossPx
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Auto-close failed: {exc}") from exc
    return {"result": result}
