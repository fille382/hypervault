"""Read-only Hyperliquid /info access (no signing key required).

Used to render the vault dashboard and your own account state. Everything here
is public data, so the viewer works even before you configure a trading key.
"""
from typing import Any, Optional

import httpx


class HLInfo:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _post(self, payload: dict) -> Any:
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

    async def user_fills(self, address: str) -> Any:
        # aggregateByTime merges partial fills of one order into a single row,
        # matching what Hyperliquid's own trade-history UI shows.
        return await self._post({"type": "userFills", "user": address, "aggregateByTime": True})

    async def l2_book(self, coin: str) -> Any:
        # REST snapshot of the order book — used only as a cold-start fallback
        # while the websocket subscription is still warming up.
        return await self._post({"type": "l2Book", "coin": coin})

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
    """metaAndAssetCtxs -> { coin: {maxLeverage, szDecimals, markPx, prevDayPx, funding, dex} }.

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
        result[asset.get("name")] = {
            "maxLeverage": asset.get("maxLeverage"),
            "szDecimals": asset.get("szDecimals"),
            "onlyIsolated": asset.get("onlyIsolated", False),
            "markPx": _f((ctx or {}).get("markPx")),
            "prevDayPx": _f((ctx or {}).get("prevDayPx")),
            "funding": _f((ctx or {}).get("funding")),
            "dex": dex,
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
        out.append({"coin": coin, "total": amount, "usd": usd})
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
