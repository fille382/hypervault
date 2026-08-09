"""Top-traders leaderboard, proxied from Hyperliquid's stats endpoint.

The upstream file (stats-data.hyperliquid.xyz/Mainnet/leaderboard) is a ~33 MB
uncompressed JSON blob with ~41k UNSORTED rows, regenerated every ~20 minutes.
Shipping that to the browser is a non-starter, so the backend downloads it,
keeps only the rows that can ever appear in a top-N view (top K per
window x metric), and serves small sorted slices. Conditional GETs
(ETag / If-Modified-Since) make refreshes free when the file hasn't changed.

This is a different host from api.hyperliquid.xyz (a static CDN object), so it
does NOT spend from the /info read budget in hl_info.py.
"""
import asyncio
import heapq
import json
import re
import time
from typing import Any, Optional

import httpx

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
# Upstream regenerates ~every 20 min; refetching sooner is wasted bandwidth.
REFRESH_SECONDS = 900
RETRY_SECONDS = 120  # after a failed refresh (stale data keeps serving meanwhile)
TOP_K = 100  # rows kept per ranking — matches the API's max `limit`

WINDOWS = ("day", "week", "month", "allTime")
METRICS = ("pnl", "roi", "vlm")
# Rankings are precomputed per equity tier (matching the UI's filter options),
# because filtering AFTER ranking would leave "top ROI among $1M+ accounts"
# nearly empty — the $1M+ crowd rarely makes the unfiltered global top-100.
EQUITY_TIERS = (0.0, 10_000.0, 100_000.0, 1_000_000.0)

# ROI on a $50 account is noise (and often wash trading). ROI rankings only
# consider accounts at or above this equity; PnL/volume rankings are unfiltered.
ROI_MIN_ACCOUNT_VALUE = 1_000.0

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _f(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _clean_name(name: Any) -> Optional[str]:
    """displayName is arbitrary user text (emails, unicode art) — trim it down."""
    if not isinstance(name, str):
        return None
    name = _CONTROL_CHARS.sub("", name).strip()
    return name[:32] or None


def _compact_rows(raw: Any) -> list[dict]:
    """Full upstream payload -> compact rows with parsed floats.

    Row shape kept: {address, name, accountValue, windows: {day/week/month/
    allTime: {pnl, roi, vlm}}}. Rows missing any window are dropped (they
    can't be ranked consistently).
    """
    out: list[dict] = []
    for r in (raw or {}).get("leaderboardRows", []) or []:
        addr = r.get("ethAddress")
        if not isinstance(addr, str) or not addr.startswith("0x") or len(addr) != 42:
            continue
        account_value = _f(r.get("accountValue"))
        windows: dict[str, dict] = {}
        for pair in r.get("windowPerformances") or []:
            try:
                label, stats = pair
            except (TypeError, ValueError):
                continue
            if label in WINDOWS and isinstance(stats, dict):
                pnl = _f(stats.get("pnl"))
                # Upstream roi explodes for accounts funded mid-window (a $17k
                # gain "earning" 17,000% because the deposit isn't counted), so
                # we derive our own: return on approximate window-START equity
                # (current equity minus the window's pnl). Undefined when the
                # account started from ~nothing — those can't be ranked by ROI.
                start_equity = account_value - pnl
                windows[label] = {
                    "pnl": pnl,
                    "roi": (pnl / start_equity) if start_equity >= 100.0 else None,
                    "vlm": _f(stats.get("vlm")),
                }
        if len(windows) != len(WINDOWS):
            continue
        out.append(
            {
                "address": addr,
                "name": _clean_name(r.get("displayName")),
                "accountValue": account_value,
                "windows": windows,
            }
        )
    return out


def _parse_and_rank(
    payload: bytes,
) -> tuple[list[dict], dict[tuple[str, str, float], list[int]]]:
    """Raw response bytes -> (kept rows, rankings). Pure CPU; runs in a thread.

    Ranks once per (window, metric, equity tier) and keeps the union, so a row
    present in several rankings is stored once and referenced by index.
    """
    compact = _compact_rows(json.loads(payload))
    if not compact:
        raise RuntimeError("leaderboard payload contained no usable rows")

    rank_addrs: dict[tuple[str, str, float], list[str]] = {}
    keep: dict[str, dict] = {}
    for w in WINDOWS:
        # Zero volume in the window means the "PnL" is just holdings
        # drift / transfers — nothing to copy. Real leaderboard rows only.
        traded = [c for c in compact if c["windows"][w]["vlm"] > 0]
        for tier in EQUITY_TIERS:
            pool = [c for c in traded if c["accountValue"] >= tier] if tier else traded
            roi_pool = [
                c
                for c in pool
                if c["accountValue"] >= ROI_MIN_ACCOUNT_VALUE
                and c["windows"][w]["roi"] is not None
            ]
            for m in METRICS:
                best = heapq.nlargest(
                    TOP_K,
                    roi_pool if m == "roi" else pool,
                    key=lambda c: c["windows"][w][m] or 0.0,
                )
                rank_addrs[(w, m, tier)] = [b["address"] for b in best]
                for b in best:
                    keep[b["address"]] = b

    rows = list(keep.values())
    index_of = {r["address"]: i for i, r in enumerate(rows)}
    rank = {k: [index_of[a] for a in addrs] for k, addrs in rank_addrs.items()}
    return rows, rank


class LeaderboardCache:
    """In-memory top-N slices of the Hyperliquid leaderboard, refreshed lazily.

    Only the union of per-ranking top-K rows survives a refresh (a few
    thousand rows), so steady-state memory is a few MB — the 33 MB payload
    lives only inside the refresh call.
    """

    def __init__(self, url: str = LEADERBOARD_URL) -> None:
        self._url = url
        # The download is ~33 MB uncompressed — allow a leisurely read.
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=15.0))
        self._lock = asyncio.Lock()
        self._rows: list[dict] = []  # union of every ranking's top-K
        # (window, metric, tier) -> row indexes into _rows, best first
        self._rank: dict[tuple[str, str, float], list[int]] = {}
        self._refresh_task: Optional[asyncio.Task] = None
        self._next_attempt = 0.0
        self._updated_at: Optional[int] = None  # epoch ms of last successful refresh
        self._etag: Optional[str] = None
        self._last_modified: Optional[str] = None
        self._error: Optional[str] = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def top(self, window: str, sort: str, limit: int, min_account_value: float = 0.0) -> dict:
        """A sorted top-`limit` slice. Raises only if no data has EVER loaded."""
        await self._ensure_fresh()
        if not self._rows:
            raise RuntimeError(self._error or "leaderboard has not loaded yet")
        # Serve from the tier bucket at or below the requested floor; the
        # residual filter only bites for floors between tiers.
        tier = max((t for t in EQUITY_TIERS if t <= min_account_value), default=0.0)
        traders: list[dict] = []
        for i in self._rank.get((window, sort, tier), []):
            row = self._rows[i]
            if row["accountValue"] < min_account_value:
                continue
            w = row["windows"][window]
            traders.append(
                {
                    "rank": len(traders) + 1,
                    "address": row["address"],
                    "name": row["name"],
                    "accountValue": row["accountValue"],
                    "pnl": w["pnl"],
                    "roi": w["roi"],
                    "vlm": w["vlm"],
                    "windows": row["windows"],
                }
            )
            if len(traders) >= limit:
                break
        return {
            "updatedAt": self._updated_at,
            "window": window,
            "sort": sort,
            "stale": self._error is not None,
            "traders": traders,
        }

    async def _ensure_fresh(self) -> None:
        if time.time() < self._next_attempt:
            return
        if self._rows:
            # We have servable (if stale) data — never make a request wait ~30s
            # for the 33 MB re-download. Kick it off in the background instead.
            if self._refresh_task is None or self._refresh_task.done():
                self._refresh_task = asyncio.create_task(self._locked_refresh())
            return
        await self._locked_refresh()

    async def _locked_refresh(self) -> None:
        async with self._lock:
            if time.time() < self._next_attempt:  # refreshed while we waited on the lock
                return
            try:
                await self._refresh()
                self._error = None
                self._next_attempt = time.time() + REFRESH_SECONDS
            except Exception as exc:  # noqa: BLE001 — keep serving stale rows
                self._error = f"{type(exc).__name__}: {exc}"
                self._next_attempt = time.time() + RETRY_SECONDS

    async def _refresh(self) -> None:
        headers = {}
        if self._etag:
            headers["If-None-Match"] = self._etag
        if self._last_modified:
            headers["If-Modified-Since"] = self._last_modified
        resp = await self._client.get(self._url, headers=headers)
        if resp.status_code == 304 and self._rows:
            return  # unchanged upstream — current rows stay valid
        resp.raise_for_status()
        # Parsing 33 MB of JSON and ranking 41k rows takes ~1s of pure CPU —
        # do it off the event loop so other endpoints keep responding.
        rows, rank = await asyncio.to_thread(_parse_and_rank, resp.content)
        self._rows = rows
        self._rank = rank
        self._etag = resp.headers.get("etag")
        self._last_modified = resp.headers.get("last-modified")
        self._updated_at = int(time.time() * 1000)
