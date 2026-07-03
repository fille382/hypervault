"""Persistent Hyperliquid websocket feed.

One connection, a handful of subscriptions — Hyperliquid pushes updates, so we
never poll it for live data. `allMids` is always on; `l2Book` subscriptions are
per-coin, created the first time a caller asks for that coin's book and dropped
again after a while with no readers (someone closed the tab / switched coin).

Everything runs on the app's event loop: a single background task owns the
connection, reconnects with backoff, and re-subscribes after a drop. Readers
(`mids()` / `book()`) just look at in-memory snapshots — they never block.
"""
import asyncio
import contextlib
import json
import logging
import time
from typing import Any, Optional

import websockets

logger = logging.getLogger("hypervault.ws")

PING_INTERVAL = 30.0  # Hyperliquid closes connections that go quiet (~60s)
BOOK_IDLE_TTL = 90.0  # drop a coin's l2Book sub this long after the last request
RECONNECT_MAX = 30.0  # backoff ceiling between reconnect attempts


def _f(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_book(data: dict) -> Optional[dict]:
    """l2Book payload -> {coin, time, bids: [{px, sz, n}], asks: [...]}.

    Hyperliquid sends levels as [bids, asks], each sorted best-first
    (bids descending, asks ascending), prices/sizes as strings.
    """
    levels = (data or {}).get("levels")
    if not isinstance(levels, list) or len(levels) < 2:
        return None

    def side(rows: list) -> list[dict]:
        out = []
        for r in rows or []:
            px, sz = _f(r.get("px")), _f(r.get("sz"))
            if px is None or sz is None:
                continue
            out.append({"px": px, "sz": sz, "n": r.get("n")})
        return out

    return {
        "coin": data.get("coin"),
        "time": data.get("time"),
        "bids": side(levels[0]),
        "asks": side(levels[1]),
    }


class HLWebSocketFeed:
    def __init__(self, base_url: str) -> None:
        self._url = (
            base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/ws"
        )
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None  # the live connection, None while (re)connecting

        self._mids: dict[str, str] = {}
        self._mids_ts: float = 0.0
        self._books: dict[str, dict] = {}  # coin -> parsed book (with local "ts")
        self._book_wanted: dict[str, float] = {}  # coin -> last time a caller asked

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="hl-ws-feed")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    @property
    def connected(self) -> bool:
        return self._ws is not None

    # ── public reads (never block, never hit the network) ────────────────
    def mids(self, max_age: float = 10.0) -> Optional[dict]:
        """Latest allMids snapshot ({coin: 'px' str}), or None if stale/absent."""
        if self._mids and time.time() - self._mids_ts <= max_age:
            return self._mids
        return None

    def book(self, coin: str, max_age: float = 15.0) -> Optional[dict]:
        """Latest order book for `coin`, or None if we don't have a fresh one."""
        b = self._books.get(coin)
        if b and time.time() - b["ts"] <= max_age:
            return b
        return None

    async def ensure_book(self, coin: str) -> None:
        """Mark `coin`'s book as wanted; subscribe now if we're connected.

        Safe to call on every request — it only sends a subscribe message the
        first time (or after an idle unsubscribe / reconnect).
        """
        already = coin in self._book_wanted
        self._book_wanted[coin] = time.time()
        if not already and self._ws is not None:
            await self._send_subscription("subscribe", coin)

    # ── internals ─────────────────────────────────────────────────────────
    async def _send(self, payload: dict) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(payload))
        except Exception:  # noqa: BLE001 — connection died; the run loop reconnects
            pass

    async def _send_subscription(self, method: str, coin: str) -> None:
        await self._send({"method": method, "subscription": {"type": "l2Book", "coin": coin}})

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(self._url, max_size=2**22, open_timeout=10) as ws:
                    self._ws = ws
                    backoff = 1.0
                    logger.info("hyperliquid ws connected (%s)", self._url)
                    await self._send({"method": "subscribe", "subscription": {"type": "allMids"}})
                    for coin in list(self._book_wanted):
                        await self._send_subscription("subscribe", coin)
                    keeper = asyncio.create_task(self._keepalive())
                    try:
                        async for raw in ws:
                            self._handle(raw)
                    finally:
                        keeper.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await keeper
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — any drop: back off and reconnect
                logger.warning("hyperliquid ws disconnected: %s — retrying in %.0fs", exc, backoff)
            finally:
                self._ws = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX)

    async def _keepalive(self) -> None:
        """App-level ping (the server drops quiet connections) + idle-book janitor."""
        while True:
            await asyncio.sleep(PING_INTERVAL)
            await self._send({"method": "ping"})
            now = time.time()
            for coin, last in list(self._book_wanted.items()):
                if now - last > BOOK_IDLE_TTL:
                    del self._book_wanted[coin]
                    self._books.pop(coin, None)
                    await self._send_subscription("unsubscribe", coin)

    def _handle(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return
        channel = msg.get("channel")
        data = msg.get("data")
        if channel == "allMids":
            mids = (data or {}).get("mids")
            if isinstance(mids, dict):
                self._mids = mids
                self._mids_ts = time.time()
        elif channel == "l2Book":
            book = parse_book(data or {})
            if book and book.get("coin"):
                book["ts"] = time.time()
                self._books[book["coin"]] = book
