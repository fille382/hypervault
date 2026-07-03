"""Local SQLite store for an account's own trade history (fills).

Hyperliquid's userFills only returns the ~2000 most recent fills, so we persist
them locally keyed by account address. Over time this builds a durable profile
of every trade we've seen, even after older ones fall out of Hyperliquid's
window. Fills are immutable once recorded (keyed by their trade id `tid`).
"""
import sqlite3
import threading
from pathlib import Path


class FillStore:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fills (
                address    TEXT    NOT NULL,
                tid        INTEGER NOT NULL,
                time       INTEGER NOT NULL,
                coin       TEXT,
                side       TEXT,
                dir        TEXT,
                px         REAL,
                sz         REAL,
                closed_pnl REAL,
                fee        REAL,
                hash       TEXT,
                PRIMARY KEY (address, tid)
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS fills_addr_time ON fills (address, time)"
        )
        self._conn.commit()

    def upsert(self, address: str, fills: list[dict]) -> int:
        """Insert new fills for an address. Returns how many were newly added."""
        rows = [
            (
                address,
                f["tid"],
                f.get("time"),
                f.get("coin"),
                f.get("side"),
                f.get("dir"),
                f.get("px"),
                f.get("sz"),
                f.get("closedPnl"),
                f.get("fee"),
                f.get("hash"),
            )
            for f in fills
            if f.get("tid") is not None and f.get("time") is not None
        ]
        if not rows:
            return 0
        with self._lock:
            cur = self._conn.executemany(
                "INSERT INTO fills "
                "(address, tid, time, coin, side, dir, px, sz, closed_pnl, fee, hash) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(address, tid) DO NOTHING",  # fills never change
                rows,
            )
            self._conn.commit()
            return cur.rowcount or 0

    def query(self, address: str, limit: int = 100, before: int = 0) -> list[dict]:
        """Newest-first trades for an address; `before` (ms) pages into older history."""
        params: list = [address]
        where = "address = ?"
        if before and before > 0:
            where += " AND time < ?"
            params.append(int(before))
        params.append(int(limit))
        cur = self._conn.execute(
            "SELECT time, coin, side, dir, px, sz, closed_pnl, fee, hash, tid "
            f"FROM fills WHERE {where} ORDER BY time DESC LIMIT ?",
            params,
        )
        return [
            {
                "time": t,
                "coin": coin,
                "side": side,
                "dir": d,
                "px": px,
                "sz": sz,
                "closedPnl": pnl,
                "fee": fee,
                "hash": h,
                "tid": tid,
            }
            for (t, coin, side, d, px, sz, pnl, fee, h, tid) in cur.fetchall()
        ]

    def count(self, address: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) FROM fills WHERE address = ?", (address,)
        ).fetchone()
        return row[0] if row else 0

    def close(self) -> None:
        self._conn.close()
