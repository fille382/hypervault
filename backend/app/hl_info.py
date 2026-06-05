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

    async def clearinghouse_state(self, address: str) -> Any:
        return await self._post({"type": "clearinghouseState", "user": address})

    async def meta_and_asset_ctxs(self) -> Any:
        return await self._post({"type": "metaAndAssetCtxs"})

    async def all_mids(self) -> Any:
        return await self._post({"type": "allMids"})

    async def spot_clearinghouse_state(self, address: str) -> Any:
        return await self._post({"type": "spotClearinghouseState", "user": address})


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
        lev = p.get("leverage", {}) or {}
        out.append(
            {
                "coin": p.get("coin"),
                "side": "long" if szi >= 0 else "short",
                "size": abs(szi),
                "signedSize": szi,
                "entryPx": _f(p.get("entryPx")),
                "positionValue": _f(p.get("positionValue")),
                "unrealizedPnl": _f(p.get("unrealizedPnl")),
                "roe": _f(p.get("returnOnEquity")),
                "leverage": lev.get("value"),
                "leverageType": lev.get("type"),
                "liquidationPx": _f(p.get("liquidationPx")),
                "marginUsed": _f(p.get("marginUsed")),
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


def parse_meta_ctxs(meta_ctxs: Any) -> dict:
    """metaAndAssetCtxs -> { coin: {maxLeverage, szDecimals, markPx, prevDayPx, funding} }."""
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
