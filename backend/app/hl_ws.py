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
from collections import deque
from typing import Any, Optional

import websockets

logger = logging.getLogger("hypervault.ws")

PING_INTERVAL = 30.0  # Hyperliquid closes connections that go quiet (~60s)
BOOK_IDLE_TTL = 90.0  # drop a coin's l2Book sub this long after the last request
TRADES_IDLE_TTL = 90.0  # same idea for a coin's public-trades stream
TRADES_BUFFER = 1500  # trades kept per coin (enough for size statistics)
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


def parse_trades(data: list) -> list[dict]:
    """trades payload -> [{coin, px, sz, time, side}], side = taker direction."""
    out = []
    for t in data or []:
        if not isinstance(t, dict):
            continue
        px, sz, ts = _f(t.get("px")), _f(t.get("sz")), t.get("time")
        if px is None or sz is None or not isinstance(ts, (int, float)):
            continue
        out.append(
            {
                "coin": t.get("coin"),
                "px": px,
                "sz": sz,
                "time": int(ts),
                # Hyperliquid: "B" = the taker bought (lifted an ask),
                # "A" = the taker sold (hit a bid).
                "side": "buy" if t.get("side") == "B" else "sell",
            }
        )
    return out


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
        # coin -> {"ts", "sig", "mantissa"}: last request time and the price
        # grouping (Hyperliquid's nSigFigs/mantissa) the subscription uses.
        self._book_wanted: dict[str, dict] = {}
        self._trades: dict[str, deque] = {}  # coin -> recent public trades
        self._trades_wanted: dict[str, float] = {}  # coin -> last request time

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

    def book(
        self,
        coin: str,
        sig: Optional[int] = None,
        mantissa: Optional[int] = None,
        max_age: float = 15.0,
    ) -> Optional[dict]:
        """Latest book for `coin` at this grouping, or None if stale/mismatched."""
        b = self._books.get(coin)
        if (
            b
            and time.time() - b["ts"] <= max_age
            and b.get("sig") == sig
            and b.get("mantissa") == mantissa
        ):
            return b
        return None

    async def ensure_book(
        self, coin: str, sig: Optional[int] = None, mantissa: Optional[int] = None
    ) -> None:
        """Mark `coin`'s book as wanted at this price grouping.

        Safe to call on every request — it only talks to Hyperliquid the first
        time (or after an idle unsubscribe / reconnect). One subscription per
        coin: asking for a different grouping swaps the subscription, so the
        most recently requested grouping wins.
        """
        want = self._book_wanted.get(coin)
        if want and want["sig"] == sig and want["mantissa"] == mantissa:
            want["ts"] = time.time()
            return
        if want and self._ws is not None:
            await self._send_subscription("unsubscribe", coin, want["sig"], want["mantissa"])
        self._book_wanted[coin] = {"ts": time.time(), "sig": sig, "mantissa": mantissa}
        self._books.pop(coin, None)  # any cached snapshot is at the old grouping
        if self._ws is not None:
            await self._send_subscription("subscribe", coin, sig, mantissa)

    def trades(self, coin: str, since_ms: int = 0) -> list[dict]:
        """Buffered public trades for `coin` newer than `since_ms`, oldest first."""
        buf = self._trades.get(coin)
        if not buf:
            return []
        rows = list(buf)
        return [t for t in rows if t["time"] > since_ms] if since_ms > 0 else rows

    async def ensure_trades(self, coin: str) -> None:
        """Mark `coin`'s public-trades stream as wanted (subscribes on first ask)."""
        known = coin in self._trades_wanted
        self._trades_wanted[coin] = time.time()
        if not known and self._ws is not None:
            await self._send(
                {"method": "subscribe", "subscription": {"type": "trades", "coin": coin}}
            )

    # ── internals ─────────────────────────────────────────────────────────
    async def _send(self, payload: dict) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(payload))
        except Exception:  # noqa: BLE001 — connection died; the run loop reconnects
            pass

    async def _send_subscription(
        self, method: str, coin: str, sig: Optional[int] = None, mantissa: Optional[int] = None
    ) -> None:
        # nSigFigs 2-5 groups levels into coarser price buckets upstream;
        # mantissa (2 or 5, only with nSigFigs=5) picks the in-between steps.
        sub: dict[str, Any] = {"type": "l2Book", "coin": coin}
        if sig:
            sub["nSigFigs"] = sig
            if mantissa and sig == 5:
                sub["mantissa"] = mantissa
        await self._send({"method": method, "subscription": sub})

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(self._url, max_size=2**22, open_timeout=10) as ws:
                    self._ws = ws
                    backoff = 1.0
                    logger.info("hyperliquid ws connected (%s)", self._url)
                    await self._send({"method": "subscribe", "subscription": {"type": "allMids"}})
                    for coin, want in list(self._book_wanted.items()):
                        await self._send_subscription("subscribe", coin, want["sig"], want["mantissa"])
                    for coin in list(self._trades_wanted):
                        await self._send(
                            {"method": "subscribe", "subscription": {"type": "trades", "coin": coin}}
                        )
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
            for coin, want in list(self._book_wanted.items()):
                if now - want["ts"] > BOOK_IDLE_TTL:
                    del self._book_wanted[coin]
                    self._books.pop(coin, None)
                    await self._send_subscription("unsubscribe", coin, want["sig"], want["mantissa"])
            for coin, ts in list(self._trades_wanted.items()):
                if now - ts > TRADES_IDLE_TTL:
                    del self._trades_wanted[coin]
                    self._trades.pop(coin, None)
                    await self._send(
                        {"method": "unsubscribe", "subscription": {"type": "trades", "coin": coin}}
                    )

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
                # The payload doesn't echo nSigFigs/mantissa, so stamp the book
                # with the grouping we currently want for this coin. A message
                # from a just-swapped subscription may get mis-stamped for one
                # tick; the next push (at the new grouping) overwrites it.
                want = self._book_wanted.get(book["coin"])
                book["sig"] = want["sig"] if want else None
                book["mantissa"] = want["mantissa"] if want else None
                self._books[book["coin"]] = book
        elif channel == "trades":
            for t in parse_trades(data if isinstance(data, list) else []):
                coin = t.get("coin")
                if not coin:
                    continue
                buf = self._trades.get(coin)
                if buf is None:
                    buf = self._trades[coin] = deque(maxlen=TRADES_BUFFER)
                buf.append(t)
