"""Local SQLite cache for Hyperliquid candles.

Closed candles never change, so once we've fetched a (coin, interval, time) bar
we can serve it forever from disk. We only call Hyperliquid for the live tail
(new bars since the newest stored) and to backfill older history we don't have
yet. Times are stored in SECONDS, matching parse_candles / lightweight-charts.
"""
import sqlite3
import threading
from pathlib import Path
from typing import Optional


class CandleStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # check_same_thread=False so asyncio.to_thread workers can use it; all
        # writes go through self._lock, reads are fine concurrently under WAL.
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS candles (
                coin     TEXT    NOT NULL,
                interval TEXT    NOT NULL,
                time     INTEGER NOT NULL,
                open     REAL,
                high     REAL,
                low      REAL,
                close    REAL,
                volume   REAL,
                PRIMARY KEY (coin, interval, time)
            )
            """
        )
        self._conn.commit()

    def bounds(self, coin: str, interval: str) -> tuple[Optional[int], Optional[int]]:
        """(earliest, latest) stored bar time in seconds, or (None, None) if empty."""
        row = self._conn.execute(
            "SELECT MIN(time), MAX(time) FROM candles WHERE coin = ? AND interval = ?",
            (coin, interval),
        ).fetchone()
        return (row[0], row[1]) if row else (None, None)

    def query(self, coin: str, interval: str, start_sec: int, end_sec: int) -> list[dict]:
        cur = self._conn.execute(
            "SELECT time, open, high, low, close, volume FROM candles "
            "WHERE coin = ? AND interval = ? AND time >= ? AND time <= ? ORDER BY time",
            (coin, interval, start_sec, end_sec),
        )
        return [
            {"time": t, "open": o, "high": h, "low": lo, "close": c, "volume": v}
            for (t, o, h, lo, c, v) in cur.fetchall()
        ]

    def upsert(self, coin: str, interval: str, candles: list[dict]) -> None:
        if not candles:
            return
        rows = [
            (coin, interval, c["time"], c["open"], c["high"], c["low"], c["close"], c["volume"])
            for c in candles
            if c.get("time") is not None
        ]
        if not rows:
            return
        with self._lock:
            # The newest bar is still forming, so its OHLCV changes — upsert
            # rather than ignore so re-fetching the tail refreshes it.
            self._conn.executemany(
                "INSERT INTO candles (coin, interval, time, open, high, low, close, volume) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(coin, interval, time) DO UPDATE SET "
                "open = excluded.open, high = excluded.high, low = excluded.low, "
                "close = excluded.close, volume = excluded.volume",
                rows,
            )
            self._conn.commit()

    def close(self) -> None:
        self._conn.close()
