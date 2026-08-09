"""Read-only Hyperliquid /info access (no signing key required).

Used to render the vault dashboard and your own account state. Everything here
is public data, so the viewer works even before you configure a trading key.
"""
import time
from collections import deque
from typing import Any, Optional

import httpx

# Hyperliquid's REST limit is 1200 "weight" per minute per IP, shared by ALL
# traffic from this machine — including signed orders. Read polling here spends
# from a smaller budget so a busy dashboard can never starve the trading path
# (an order that hits the exhausted IP limit is rejected with HTTP 429).
# Per the docs: these /info types cost 2, userRole costs 60, the rest cost 20.
_REQUEST_WEIGHTS = {
    "l2Book": 2,
    "allMids": 2,
    "clearinghouseState": 2,
    "orderStatus": 2,
    "spotClearinghouseState": 2,
    "exchangeStatus": 2,
}
_DEFAULT_WEIGHT = 20
READ_BUDGET_PER_MIN = 900
# Heavy calls (weight 20 — userFills, metaAndAssetCtxs, candleSnapshot, …) stop
# spending at this lower line, so the weight-2 reads that render positions and
# balances always have headroom even when the pollers saturate the budget.
# Every heavy caller degrades to cached/stale data when refused.
HEAVY_BUDGET_PER_MIN = 700


class HLRateLimited(RuntimeError):
    """Local read budget exhausted — request skipped to protect the trading path."""


class HLInfo:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=timeout)
        self._spent: deque[tuple[float, int]] = deque()  # (timestamp, weight)
        self._spent_total = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    def _spend(self, weight: int) -> None:
        """Reserve `weight` from the sliding 1-minute read budget, or refuse.

        Refusing (rather than queueing) keeps the endpoint fast: callers all
        have a cached/stale fallback, and the budget refills within seconds.
        Heavy requests refuse at HEAVY_BUDGET_PER_MIN so cheap interactive
        reads keep working while the background pollers are saturated.
        """
        now = time.time()
        while self._spent and now - self._spent[0][0] > 60:
            self._spent_total -= self._spent.popleft()[1]
        limit = READ_BUDGET_PER_MIN if weight < _DEFAULT_WEIGHT else HEAVY_BUDGET_PER_MIN
        if self._spent_total + weight > limit:
            raise HLRateLimited(
                f"Hyperliquid read budget exhausted ({self._spent_total}/{limit} "
                "weight in the last minute) — try again in a few seconds."
            )
        self._spent.append((now, weight))
        self._spent_total += weight

    async def _post(self, payload: dict) -> Any:
        self._spend(_REQUEST_WEIGHTS.get(payload.get("type"), _DEFAULT_WEIGHT))
        resp = await self._client.post("/info", json=payload)
        resp.raise_for_status()
        return resp.json()

    async def vault_details(self, vault_address: str) -> Any:
        return await self._post({"type": "vaultDetails", "vaultAddress": vault_address})

    async def clearinghouse_state(self, address: str, dex: Optional[str] = None) -> Any:
        payload: dict = {"type": "clearinghouseState", "user": address}
        if dex:
            payload["dex"] = dex
        return await self._post(payload)

    async def perp_dexs(self) -> Any:
        return await self._post({"type": "perpDexs"})

    async def meta_and_asset_ctxs(self, dex: Optional[str] = None) -> Any:
        payload: dict = {"type": "metaAndAssetCtxs"}
        if dex:
            payload["dex"] = dex  # HIP-3 builder dex (e.g. "xyz", "vntl") — main dex otherwise
        return await self._post(payload)

    async def all_mids(self) -> Any:
        return await self._post({"type": "allMids"})

    async def spot_clearinghouse_state(self, address: str) -> Any:
        return await self._post({"type": "spotClearinghouseState", "user": address})

    async def spot_meta_and_asset_ctxs(self) -> Any:
        return await self._post({"type": "spotMetaAndAssetCtxs"})

    async def user_fills(self, address: str) -> Any:
        # aggregateByTime merges partial fills of one order into a single row,
        # matching what Hyperliquid's own trade-history UI shows.
        return await self._post({"type": "userFills", "user": address, "aggregateByTime": True})

    async def portfolio(self, address: str) -> Any:
        # PnL / account-value history per window (day, week, month, allTime,
        # plus perp-only variants). Works for any address, vault or wallet.
        return await self._post({"type": "portfolio", "user": address})

    async def l2_book(
        self, coin: str, sig: Optional[int] = None, mantissa: Optional[int] = None
    ) -> Any:
        # REST snapshot of the order book — used only as a cold-start fallback
        # while the websocket subscription is still warming up. nSigFigs and
        # mantissa mirror the ws subscription's price-grouping options.
        payload: dict = {"type": "l2Book", "coin": coin}
        if sig:
            payload["nSigFigs"] = sig
            if mantissa and sig == 5:
                payload["mantissa"] = mantissa
        return await self._post(payload)

    async def candle_snapshot(self, coin: str, interval: str, start_ms: int, end_ms: int) -> Any:
        return await self._post(
            {
                "type": "candleSnapshot",
                "req": {"coin": coin, "interval": interval, "startTime": start_ms, "endTime": end_ms},
            }
        )


# --------------------------------------------------------------------------- #
# Pure parsers: turn raw Hyperliquid payloads into the shapes the UI consumes. #
# --------------------------------------------------------------------------- #
def _f(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_positions(state: dict) -> list[dict]:
    """clearinghouseState.assetPositions -> flat list matching the UI table."""
    out: list[dict] = []
    for ap in (state or {}).get("assetPositions", []):
        p = ap.get("position", {}) or {}
        szi = _f(p.get("szi")) or 0.0
        size = abs(szi)
        lev = p.get("leverage", {}) or {}
        position_value = _f(p.get("positionValue"))
        mark_px = (position_value / size) if (position_value is not None and size) else None
        # cumFunding.sinceOpen is funding PAID (positive). Flip sign so the UI shows
        # paid funding as a negative cost (matching Hyperliquid's column).
        since_open = _f((p.get("cumFunding", {}) or {}).get("sinceOpen"))
        funding = -since_open if since_open is not None else None
        out.append(
            {
                "coin": p.get("coin"),
                "side": "long" if szi >= 0 else "short",
                "size": size,
                "signedSize": szi,
                "entryPx": _f(p.get("entryPx")),
                "markPx": mark_px,
                "positionValue": position_value,
                "unrealizedPnl": _f(p.get("unrealizedPnl")),
                "roe": _f(p.get("returnOnEquity")),
                "leverage": lev.get("value"),
                "leverageType": lev.get("type"),
                "liquidationPx": _f(p.get("liquidationPx")),
                "marginUsed": _f(p.get("marginUsed")),
                "funding": funding,
                "maxLeverage": p.get("maxLeverage"),
            }
        )
    # Largest positions first (by notional), like the vault UI.
    out.sort(key=lambda r: (r["positionValue"] or 0.0), reverse=True)
    return out


def parse_margin_summary(state: dict) -> dict:
    ms = (state or {}).get("marginSummary", {}) or {}
    positions = (state or {}).get("assetPositions", []) or []
    total_upnl = 0.0
    for ap in positions:
        total_upnl += _f((ap.get("position") or {}).get("unrealizedPnl")) or 0.0
    return {
        "accountValue": _f(ms.get("accountValue")),
        "totalMarginUsed": _f(ms.get("totalMarginUsed")),
        "totalNtlPos": _f(ms.get("totalNtlPos")),
        "withdrawable": _f((state or {}).get("withdrawable")),
        "totalUnrealizedPnl": total_upnl,
        "openPositions": len(positions),
    }


def parse_meta_ctxs(meta_ctxs: Any, dex: str = "") -> dict:
    """metaAndAssetCtxs -> { coin: {maxLeverage, szDecimals, markPx, prevDayPx, funding, oiUsd, dayNtlVlm, dex} }.

    `dex` is "" for the main perp dex, or the HIP-3 builder dex name (e.g. "xyz").
    Builder-dex universe names already come prefixed ("xyz:GOLD"), so merging
    several dexes into one dict is collision-free.
    """
    result: dict[str, dict] = {}
    if not isinstance(meta_ctxs, list) or len(meta_ctxs) < 2:
        return result
    universe = (meta_ctxs[0] or {}).get("universe", []) or []
    ctxs = meta_ctxs[1] or []
    for i, asset in enumerate(universe):
        ctx = ctxs[i] if i < len(ctxs) else {}
        mark_px = _f((ctx or {}).get("markPx"))
        oi = _f((ctx or {}).get("openInterest"))
        result[asset.get("name")] = {
            "maxLeverage": asset.get("maxLeverage"),
            "szDecimals": asset.get("szDecimals"),
            "onlyIsolated": asset.get("onlyIsolated", False),
            "markPx": mark_px,
            "prevDayPx": _f((ctx or {}).get("prevDayPx")),
            "funding": _f((ctx or {}).get("funding")),
            # Open-interest notional: HL has no market-cap field, and this is the
            # closest on-exchange proxy for ranking markets by size.
            "oiUsd": oi * mark_px if oi is not None and mark_px is not None else None,
            "dayNtlVlm": _f((ctx or {}).get("dayNtlVlm")),
            "dex": dex,
        }
    return result


def parse_spot_meta_ctxs(raw: Any) -> dict:
    """spotMetaAndAssetCtxs -> { "BASE/QUOTE": {coin, base, szDecimals, markPx, prevDayPx, dayNtlVlm} }.

    Keys are human pair names ("HYPE/USDC"); `coin` is the on-exchange id the
    API wants ("PURR/USDC" for canonical pairs, "@107" for the rest). The SDK
    resolves both, so the display name is safe to trade with directly. On a
    duplicate display name the first pair wins (mirrors the SDK's mapping).
    """
    result: dict[str, dict] = {}
    if not isinstance(raw, list) or len(raw) < 2:
        return result
    meta = raw[0] or {}
    tokens = meta.get("tokens", []) or []
    ctx_by_coin = {c.get("coin"): c for c in (raw[1] or []) if c}
    for pair in meta.get("universe", []) or []:
        try:
            base_t, quote_t = (tokens[i] for i in pair.get("tokens"))
        except (TypeError, ValueError, IndexError):
            continue
        display = f'{base_t.get("name")}/{quote_t.get("name")}'
        if display in result:
            continue
        ctx = ctx_by_coin.get(pair.get("name")) or {}
        result[display] = {
            "coin": pair.get("name"),
            "base": base_t.get("name"),
            "szDecimals": base_t.get("szDecimals"),
            "markPx": _f(ctx.get("markPx")) or _f(ctx.get("midPx")),
            "prevDayPx": _f(ctx.get("prevDayPx")),
            "dayNtlVlm": _f(ctx.get("dayNtlVlm")),
        }
    return result


# Spot tokens we treat as $1. Anything else is valued at its perp mid (a good proxy).
_STABLES = {"USDC", "USDT", "USDT0", "USDE", "USDH", "USD", "DAI", "USDD", "TUSD", "FDUSD"}


def value_spot_balances(balances: list, mids: dict) -> tuple[list[dict], float]:
    """Value spot balances in USD. Returns (sorted list with per-token usd, total usd)."""
    out: list[dict] = []
    total = 0.0
    for b in balances or []:
        coin = b.get("coin")
        amount = _f(b.get("total")) or 0.0
        if amount <= 0:
            continue
        px = 1.0 if coin in _STABLES else _f((mids or {}).get(coin))
        usd = amount * px if px is not None else None
        if usd is not None:
            total += usd
        # `hold` is locked in open orders; only the rest is spendable/sellable.
        hold = _f(b.get("hold")) or 0.0
        out.append(
            {
                "coin": coin,
                "total": amount,
                "available": max(0.0, amount - hold),
                "usd": usd,
            }
        )
    out.sort(key=lambda r: (r["usd"] or 0.0), reverse=True)
    return out, total


def parse_fills(raw: Any) -> list[dict]:
    """userFills -> rows for the activity feed (newest first as delivered)."""
    out: list[dict] = []
    for f in raw or []:
        out.append(
            {
                "time": f.get("time"),
                "coin": f.get("coin"),
                "side": "buy" if f.get("side") == "B" else "sell",
                "dir": f.get("dir"),  # e.g. "Open Long", "Close Short", "Long > Short"
                "px": _f(f.get("px")),
                "sz": _f(f.get("sz")),
                "closedPnl": _f(f.get("closedPnl")),
                "fee": _f(f.get("fee")),
                "hash": f.get("hash"),
                "tid": f.get("tid"),  # unique trade id — used to dedupe/persist
            }
        )
    return out


def _downsample_history(points: Any, max_points: int) -> list[list]:
    """[[ms, "value"], ...] -> [[ms, float], ...] thinned to <= max_points.

    Keeps both endpoints so the sparkline's start/end are exact.
    """
    rows: list[list] = []
    for p in points or []:
        try:
            t, v = p
        except (TypeError, ValueError):
            continue
        rows.append([t, _f(v) or 0.0])
    if len(rows) <= max_points:
        return rows
    step = (len(rows) - 1) / (max_points - 1)
    return [rows[round(i * step)] for i in range(max_points)]


PORTFOLIO_WINDOWS = ("day", "week", "month", "allTime")


def parse_portfolio(raw: Any, max_points: int = 60) -> dict:
    """portfolio -> {window: {vlm, pnlHistory, accountValueHistory}}.

    Only the four combined windows are kept (the perp-only variants — perpDay
    etc. — are dropped); histories are downsampled for sparkline use.
    """
    out: dict[str, dict] = {}
    for pair in raw or []:
        try:
            label, data = pair
        except (TypeError, ValueError):
            continue
        if label not in PORTFOLIO_WINDOWS or not isinstance(data, dict):
            continue
        out[label] = {
            "vlm": _f(data.get("vlm")),
            "pnlHistory": _downsample_history(data.get("pnlHistory"), max_points),
            "accountValueHistory": _downsample_history(data.get("accountValueHistory"), max_points),
        }
    return out


def compute_trade_stats(raw_fills: Any) -> dict:
    """Raw userFills -> win rate / hold time / favourite markets.

    A "round trip" is one position episode per coin: it opens when the signed
    size leaves zero and closes when it returns to zero (a flip closes one and
    opens the next). Wins are episodes whose summed closedPnl is positive.
    userFills caps at the 2000 most recent fills, so these are *recent* stats;
    episodes already open before the window (or still open now) contribute no
    hold time, and only closed episodes count toward the win rate.

    Only PERP fills count — that's what a copier would mirror. Spot fills
    (coin "@107" or "PURR/USDC") are token buys/sells where position episodes
    and closedPnl don't mean the same thing.

    Whales often scale in/out without ever flattening, so zero completed
    episodes is common; winRate then falls back to the share of profitable
    closing fills (each fill with a non-zero closedPnl is one sample).
    """
    # userFills arrives newest-first, and fills in one block share a timestamp
    # (e.g. a close plus a re-entry). Reverse before the stable sort so
    # same-millisecond fills keep true execution order once sorted ascending.
    ordered = list(raw_fills or [])
    ordered.reverse()
    fills = sorted(
        (
            f
            for f in ordered
            if f.get("time")
            and f.get("coin")
            and not str(f["coin"]).startswith("@")
            and "/" not in str(f["coin"])
        ),
        key=lambda f: f["time"],
    )
    by_coin: dict[str, list[dict]] = {}
    for f in fills:
        by_coin.setdefault(f["coin"], []).append(f)

    wins = losses = 0
    close_wins = close_losses = 0  # fill-level fallback when no episode completes
    hold_ms: list[int] = []
    notional_by_coin: dict[str, float] = {}
    for coin, coin_fills in by_coin.items():
        # startPosition is the signed size BEFORE the first observed fill, so
        # we can tell a fresh episode from one that predates the window.
        pos = _f(coin_fills[0].get("startPosition")) or 0.0
        opened_at: Optional[int] = None  # None => open time unknown/predates window
        episode_pnl = 0.0
        for f in coin_fills:
            sz = _f(f.get("sz")) or 0.0
            delta = sz if f.get("side") == "B" else -sz
            new_pos = pos + delta
            if abs(new_pos) < 1e-8:
                new_pos = 0.0
            fill_pnl = _f(f.get("closedPnl")) or 0.0
            episode_pnl += fill_pnl
            if fill_pnl > 0:
                close_wins += 1
            elif fill_pnl < 0:
                close_losses += 1
            notional_by_coin[coin] = notional_by_coin.get(coin, 0.0) + sz * (_f(f.get("px")) or 0.0)
            crossed_zero = pos != 0.0 and (new_pos == 0.0 or (pos > 0) != (new_pos > 0))
            if crossed_zero:
                # Strictly positive counts as a win — a break-even close still
                # paid fees (closedPnl excludes them).
                if episode_pnl > 0:
                    wins += 1
                else:
                    losses += 1
                if opened_at is not None:
                    hold_ms.append(f["time"] - opened_at)
                episode_pnl = 0.0
                opened_at = f["time"] if new_pos != 0.0 else None  # a flip starts the next episode
            elif pos == 0.0 and new_pos != 0.0:
                opened_at = f["time"]
            pos = new_pos

    closed = wins + losses
    close_total = close_wins + close_losses
    if closed:
        win_rate, win_rate_basis = wins / closed, "roundTrips"
    elif close_total:
        win_rate, win_rate_basis = close_wins / close_total, "closes"
    else:
        win_rate, win_rate_basis = None, None
    top_coins = sorted(notional_by_coin.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return {
        "fillCount": len(fills),
        "roundTrips": closed,
        "wins": wins,
        "losses": losses,
        "winRate": win_rate,
        # "roundTrips" = per completed position episode; "closes" = per
        # closing fill (whales that never flatten have no completed episodes).
        "winRateBasis": win_rate_basis,
        "avgHoldMs": (sum(hold_ms) / len(hold_ms)) if hold_ms else None,
        "topCoins": [{"coin": c, "notional": n} for c, n in top_coins],
        "since": fills[0]["time"] if fills else None,
    }


def parse_candles(raw: Any) -> list[dict]:
    """candleSnapshot -> rows for lightweight-charts (time in seconds).

    Deduped by time (last bar wins) and sorted ascending: lightweight-charts
    asserts strictly increasing, unique timestamps, and Hyperliquid occasionally
    returns two bars sharing one timestamp (e.g. a repeated boundary bar).
    """
    by_time: dict[int, dict] = {}
    for c in raw or []:
        t = c.get("t")
        if t is None:
            continue
        sec = int(t) // 1000
        by_time[sec] = {
            "time": sec,
            "open": _f(c.get("o")),
            "high": _f(c.get("h")),
            "low": _f(c.get("l")),
            "close": _f(c.get("c")),
            "volume": _f(c.get("v")),
        }
    return [by_time[k] for k in sorted(by_time)]
