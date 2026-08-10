"""Hypervault terminal app: runs the backend and gives you an interactive
console on top of it — no browser needed.

    cd backend
    .venv\\Scripts\\python -m app.terminal    # Windows
    .venv/bin/python -m app.terminal          # macOS / Linux

It starts the same FastAPI backend the web UI uses (uvicorn on 127.0.0.1:8001)
inside this process, then drops you into a prompt where every command is a thin
client of the local HTTP API. Because everything goes through the API, the
SAFE/ARM switch, the notional guardrail, and the upstream rate-limit budgeting
apply exactly as they do from the browser — there is no side door.

If a backend is already listening on the port (e.g. you started it for the web
UI), the console attaches to it instead of starting a second one. The web UI
and this terminal can run side by side against the same backend.

One-shot mode for scripting:  python -m app.terminal -c "status"
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import shlex
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone

import httpx

# --------------------------------------------------------------------------- #
# Terminal formatting                                                         #
# --------------------------------------------------------------------------- #
# Plain ANSI on purpose — no extra dependencies beyond what the backend needs.
# Windows 10+ terminals speak VT sequences once any call touches the console
# mode; os.system("") is the classic no-op that flips it on for cmd.exe.
if os.name == "nt":
    os.system("")

USE_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def c(text: str, code: str) -> str:
    return f"\x1b[{code}m{text}\x1b[0m" if USE_COLOR else text


def green(t: str) -> str:
    return c(t, "32")


def red(t: str) -> str:
    return c(t, "31")


def yellow(t: str) -> str:
    return c(t, "33")


def cyan(t: str) -> str:
    return c(t, "36")


def dim(t: str) -> str:
    return c(t, "2")


def bold(t: str) -> str:
    return c(t, "1")


def _vlen(s: str) -> int:
    """Visible length: what the terminal shows, ignoring color codes."""
    return len(_ANSI_RE.sub("", s))


def table(headers: list[str], rows: list[list[str]], align: str | None = None) -> str:
    """Render an aligned text table. `align` is one char per column: l or r."""
    align = align or "l" * len(headers)
    widths = [_vlen(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], _vlen(cell))

    def fmt(cells: list[str]) -> str:
        out = []
        for i, cell in enumerate(cells):
            pad = " " * (widths[i] - _vlen(cell))
            out.append(pad + cell if align[i] == "r" else cell + pad)
        return "  ".join(out).rstrip()

    lines = [dim(fmt(headers)), dim("  ".join("─" * w for w in widths))]
    lines.extend(fmt(r) for r in rows)
    return "\n".join(lines)


def fmt_usd(v: float | None, signed: bool = False, colored: bool = False) -> str:
    if v is None:
        return dim("—")
    sign = "-" if v < 0 else ("+" if signed else "")
    text = f"{sign}${abs(v):,.2f}"
    if colored:
        return green(text) if v >= 0 else red(text)
    return text


def fmt_px(v: float | None) -> str:
    if v is None:
        return dim("—")
    return f"{v:,.6g}"


def fmt_num(v: float | None) -> str:
    if v is None:
        return dim("—")
    return f"{v:,.6g}"


def fmt_pct(v: float | None, colored: bool = True) -> str:
    if v is None:
        return dim("—")
    text = f"{v * 100:+.2f}%"
    return (green(text) if v >= 0 else red(text)) if colored else text


def fmt_side(side: str | None) -> str:
    if side in ("long", "buy", "B"):
        return green(str(side))
    if side in ("short", "sell", "A", "S"):
        return red(str(side))
    return str(side or "—")


def fmt_time(ms: int | None) -> str:
    if not ms:
        return dim("—")
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone().strftime("%m-%d %H:%M:%S")


SPARK_BLOCKS = "▁▂▃▄▅▆▇█"


def sparkline(values: list[float]) -> str:
    vals = [v for v in values if v is not None]
    if not vals:
        return ""
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1.0
    return "".join(SPARK_BLOCKS[int((v - lo) / span * (len(SPARK_BLOCKS) - 1))] for v in vals)


# --------------------------------------------------------------------------- #
# Embedded backend server                                                     #
# --------------------------------------------------------------------------- #
class RingLogHandler(logging.Handler):
    """Keeps backend log lines in memory instead of spraying them over the
    prompt. The `logs` command dumps the recent buffer on demand."""

    def __init__(self, maxlen: int = 2000) -> None:
        super().__init__()
        self.buffer: deque[str] = deque(maxlen=maxlen)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.buffer.append(self.format(record))
        except Exception:  # noqa: BLE001 — logging must never take the app down
            pass


log_ring = RingLogHandler()


def _backend_running(client: httpx.Client) -> dict | None:
    """The /api/health payload if a Hypervault backend answers, else None."""
    try:
        resp = client.get("/api/health", timeout=2.0)
        data = resp.json()
        return data if resp.status_code == 200 and data.get("ok") else None
    except Exception:  # noqa: BLE001 — any failure just means "not running"
        return None


def start_embedded_server(host: str, port: int):
    """Run uvicorn + the FastAPI app in a background thread of this process.

    Root logging is claimed *before* importing app.main (whose basicConfig then
    no-ops), so all backend/uvicorn output lands in the ring buffer and the
    prompt stays clean. log_config=None makes uvicorn propagate to root too.
    """
    root = logging.getLogger()
    root.handlers = [log_ring]
    root.setLevel(logging.INFO)
    # The console's own HTTP calls would otherwise echo into the log buffer.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    import uvicorn

    from .main import app as fastapi_app

    config = uvicorn.Config(fastapi_app, host=host, port=port, log_config=None, access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="hypervault-uvicorn", daemon=True)
    thread.start()
    return server, thread


# --------------------------------------------------------------------------- #
# Console                                                                     #
# --------------------------------------------------------------------------- #
class Console:
    def __init__(self, client: httpx.Client, attached: bool) -> None:
        self.client = client
        self.attached = attached  # True = driving a backend we didn't start
        self.running = True

    # ---- plumbing -------------------------------------------------------- #
    def api(self, method: str, path: str, **kwargs) -> dict:
        """Call the backend; raise RuntimeError with the API's own detail text
        on any non-2xx, so command handlers just print the message."""
        try:
            resp = self.client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"backend unreachable: {exc}") from exc
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("detail")
            except Exception:  # noqa: BLE001
                detail = resp.text[:200]
            raise RuntimeError(f"{resp.status_code}: {detail}")
        return resp.json()

    def dispatch(self, argv: list[str]) -> None:
        name, args = argv[0].lower(), argv[1:]
        entry = COMMANDS.get(name) or COMMANDS.get(ALIASES.get(name, ""))
        if not entry:
            print(f"unknown command: {name}  (try 'help')")
            return
        handler, usage, _ = entry
        try:
            handler(self, args)
        except RuntimeError as exc:
            print(red(f"error {exc}"))
        except (IndexError, ValueError):
            print(f"usage: {usage}")

    # ---- commands -------------------------------------------------------- #
    def cmd_help(self, args: list[str]) -> None:
        print(bold("Hypervault terminal — commands"))
        rows = [[cyan(usage), desc] for _, usage, desc in COMMANDS.values()]
        print(table(["command", ""], rows))
        print(dim("\nCtrl+C or 'exit' quits. 'watch <command>' reruns any read command every 5s."))

    def cmd_status(self, args: list[str]) -> None:
        h = self.api("GET", "/api/health")
        armed = h.get("armed")
        print(f"backend     {green('● up')}" + (dim("  (attached to an already-running backend)") if self.attached else ""))
        print(f"network     {h.get('network')}")
        print(f"mode        {red('ARMED — live orders!') if armed else green('SAFE (simulating)')}")
        print(f"trading     {'configured' if h.get('tradingConfigured') else dim('no key — viewer only')}")
        print(f"account     {h.get('accountAddress') or dim('—')}")
        print(f"guardrail   max ${h.get('maxOrderNotionalUsd', 0):,.0f} per order, slippage {h.get('defaultSlippage')}")

    def _positions_table(self, positions: list[dict]) -> str:
        rows = []
        for p in positions:
            rows.append([
                bold(str(p.get("coin"))),
                fmt_side(p.get("side")),
                fmt_num(p.get("size")),
                fmt_px(p.get("entryPx")),
                fmt_px(p.get("markPx")),
                fmt_usd(p.get("positionValue")),
                fmt_usd(p.get("unrealizedPnl"), signed=True, colored=True),
                fmt_pct(p.get("roe")),
                f"{p.get('leverage') or '—'}x {dim(str(p.get('leverageType') or ''))}",
                fmt_px(p.get("liquidationPx")),
            ])
        return table(
            ["coin", "side", "size", "entry", "mark", "value", "uPnL", "ROE", "lev", "liq"],
            rows,
            align="llrrrrrrlr",
        )

    def _summary_line(self, s: dict) -> str:
        parts = [
            f"value {bold(fmt_usd(s.get('accountValue')))}",
            f"margin used {fmt_usd(s.get('totalMarginUsed'))}",
            f"uPnL {fmt_usd(s.get('totalUnrealizedPnl'), signed=True, colored=True)}",
            f"withdrawable {fmt_usd(s.get('withdrawable'))}",
        ]
        if s.get("spotUsd"):
            parts.append(f"spot {fmt_usd(s.get('spotUsd'))}")
        return "  |  ".join(parts)

    def cmd_account(self, args: list[str]) -> None:
        a = self.api("GET", "/api/account")
        print(f"{dim('account')} {a.get('address')}")
        print(self._summary_line(a.get("marginSummary") or {}))
        positions = a.get("positions") or []
        print(self._positions_table(positions) if positions else dim("no open positions"))

    def cmd_vault(self, args: list[str]) -> None:
        address = args[0] if args else "0xd6e56265890b76413d1d527eb9b75e334c0c5b42"  # same prefill as the web UI
        v = self.api("GET", f"/api/vault/{address}")
        name = (v.get("details") or {}).get("name")
        print(f"{dim('vault')} {bold(name) if name else ''} {v.get('address')}")
        print(self._summary_line(v.get("marginSummary") or {}))
        positions = v.get("positions") or []
        print(self._positions_table(positions) if positions else dim("no open positions"))

    def cmd_trader(self, args: list[str]) -> None:
        t = self.api("GET", f"/api/trader/{args[0]}")
        label = f"{bold(t['vaultName'])} (vault)" if t.get("isVault") else "wallet"
        print(f"{dim('trader')} {t.get('address')}  {label}")
        stats = t.get("stats") or {}
        if stats:
            hold_ms = stats.get("avgHoldMs")
            hold = f"{hold_ms / 3_600_000:.1f} h" if hold_ms else "—"
            print(
                f"win rate {fmt_pct(stats.get('winRate'))}  "
                f"round trips {stats.get('roundTrips') or 0} ({stats.get('fillCount') or 0} fills)  "
                f"avg hold {hold}"
            )
            top = stats.get("topCoins") or []
            if top:
                print("top markets  " + "  ".join(f"{x['coin']} ({fmt_usd(x['notional'])})" for x in top))
        pf = (t.get("portfolio") or {}).get("week") or {}
        pnl_curve = [p[1] for p in (pf.get("pnlHistory") or [])]
        if pnl_curve:
            print(f"7d PnL  {sparkline(pnl_curve)}  {fmt_usd(pnl_curve[-1], signed=True, colored=True)}")

    def cmd_leaderboard(self, args: list[str]) -> None:
        window = args[0] if args else "week"
        sort = args[1] if len(args) > 1 else "pnl"
        lb = self.api("GET", "/api/leaderboard", params={"window": window, "sort": sort, "limit": 15})
        rows = []
        for r in lb.get("traders") or []:
            rows.append([
                str(r.get("rank", "")),
                r.get("address", "—"),
                r.get("name") or dim("—"),
                fmt_usd(r.get("pnl"), signed=True, colored=True),
                fmt_pct(r.get("roi")),
                fmt_usd(r.get("vlm")),
                fmt_usd(r.get("accountValue")),
            ])
        print(table(["#", "address", "name", "PnL", "ROI", "volume", "acct value"], rows, align="rllrrrr"))
        print(dim(f"window={window} sort={sort} — 'trader <address>' for a profile, 'vault <address>' to follow"))

    def cmd_meta(self, args: list[str]) -> None:
        needle = args[0].upper() if args else None
        metas = self.api("GET", "/api/meta")
        items = sorted(metas.items(), key=lambda kv: (kv[1].get("oiUsd") or 0.0), reverse=True)
        if needle:
            items = [(k, v) for k, v in items if needle in k.upper()]
        rows = []
        for coin, m in items[:30]:
            prev, mark = m.get("prevDayPx"), m.get("markPx")
            day = (mark / prev - 1) if (mark and prev) else None
            rows.append([
                bold(coin),
                fmt_px(mark),
                fmt_pct(day),
                fmt_usd(m.get("oiUsd")),
                f"{m.get('maxLeverage') or '—'}x",
            ])
        print(table(["coin", "mark", "24h", "open interest", "max lev"], rows, align="lrrrr"))
        if not needle and len(metas) > 30:
            print(dim(f"top 30 of {len(metas)} by open interest — 'meta <search>' to filter"))

    def cmd_book(self, args: list[str]) -> None:
        coin = args[0]
        levels = int(args[1]) if len(args) > 1 else 10
        b = self.api("GET", f"/api/book/{coin}", params={"levels": levels})
        asks, bids = b.get("asks") or [], b.get("bids") or []

        # Top-of-book closest to the spread: asks print high→low, bids best-first.
        def line(lvl: dict, paint) -> str:
            px = f"{lvl.get('px'):>14,.6g}" if lvl.get("px") is not None else " " * 14
            sz = fmt_num(lvl.get("sz"))
            return f"  {paint(px)}  {' ' * max(0, 14 - _vlen(sz))}{sz}"

        for lvl in reversed(asks):
            print(line(lvl, red))
        pct = b.get("spreadPct")
        mode = "live" if b.get("live") else "snapshot"
        if pct is not None:
            print(dim(f"  ── spread {fmt_px(b.get('spread'))} ({pct:.4f}%) ── {mode}"))
        else:
            print(dim(f"  ── {mode}"))
        for lvl in bids:
            print(line(lvl, green))

    def cmd_tape(self, args: list[str]) -> None:
        coin = args[0]
        t = self.api("GET", f"/api/trades/{coin}", params={"limit": 25})
        rows = []
        for tr in reversed(t.get("trades") or []):
            rows.append([
                fmt_time(tr.get("time")),
                fmt_side(tr.get("side")),
                fmt_px(tr.get("px")),
                fmt_num(tr.get("sz")),
                fmt_usd((tr.get("px") or 0) * (tr.get("sz") or 0)),
            ])
        print(table(["time", "side", "price", "size", "notional"], rows, align="llrrr") if rows else dim("tape is warming up — try again in a second"))

    def cmd_candles(self, args: list[str]) -> None:
        coin = args[0]
        interval = args[1] if len(args) > 1 else "1h"
        bars = int(args[2]) if len(args) > 2 else 48
        data = self.api("GET", f"/api/candles/{coin}", params={"interval": interval, "bars": bars})
        candles = data.get("candles") or []
        if not candles:
            print(dim("no candles"))
            return
        closes = [row["close"] for row in candles]
        first, last = closes[0], closes[-1]
        change = (last / first - 1) if first else None
        print(f"{bold(coin)} {interval} × {len(candles)}  {sparkline(closes)}")
        print(f"open {fmt_px(first)}  last {bold(fmt_px(last))}  change {fmt_pct(change)}  "
              f"hi {fmt_px(max(row['high'] for row in candles))}  "
              f"lo {fmt_px(min(row['low'] for row in candles))}")

    def cmd_trades_history(self, args: list[str]) -> None:
        limit = int(args[0]) if args else 20
        data = self.api("GET", "/api/account/trades", params={"limit": limit})
        rows = []
        for f in data.get("trades") or []:
            rows.append([
                fmt_time(f.get("time")),
                bold(str(f.get("coin"))),
                fmt_side(f.get("side")),
                fmt_px(f.get("px")),
                fmt_num(f.get("sz")),
                fmt_usd(f.get("closedPnl"), signed=True, colored=True) if f.get("closedPnl") else dim("—"),
            ])
        print(table(["time", "coin", "side", "price", "size", "closed PnL"], rows, align="lllrrr")
              if rows else dim("no saved fills yet"))
        print(dim(f"{data.get('total', 0)} fills stored for {data.get('address')}"))

    def cmd_arm(self, args: list[str]) -> None:
        h = self.api("GET", "/api/health")
        if not h.get("tradingConfigured"):
            print(yellow("No signing key configured — arming is pointless (backend/.env, HL_SECRET_KEY)."))
        print(red("ARMING sends REAL market orders on Hyperliquid mainnet."))
        answer = input(f"Type {bold('ARM')} to confirm: ").strip()
        if answer != "ARM":
            print(dim("left in SAFE mode"))
            return
        self.api("POST", "/api/arm", json={"armed": True})
        print(red("● ARMED — orders are live. 'safe' to disarm."))

    def cmd_safe(self, args: list[str]) -> None:
        self.api("POST", "/api/arm", json={"armed": False})
        print(green("● SAFE — orders simulate only."))

    def _confirm_live(self, description: str) -> bool:
        print(red(f"ARMED: this places a LIVE order — {description}"))
        return input(f"Type {bold('LIVE')} to send: ").strip() == "LIVE"

    def cmd_order(self, args: list[str]) -> None:
        coin, side, usd = args[0], args[1].lower(), float(args[2])
        if side not in ("long", "short"):
            raise ValueError
        leverage = int(args[3]) if len(args) > 3 else 5
        margin = args[4].lower() if len(args) > 4 else "cross"
        armed = self.api("GET", "/api/health").get("armed")
        if armed and not self._confirm_live(f"{side} {coin} ${usd:,.2f} at {leverage}x {margin}"):
            print(dim("cancelled"))
            return
        result = self.api("POST", "/api/order", json={
            "coin": coin, "side": side, "notionalUsd": usd,
            "leverage": leverage, "marginMode": margin,
        })
        if result.get("simulated"):
            w = result.get("would") or {}
            print(green("SIMULATED") + f" — would {fmt_side(w.get('side'))} {fmt_num(w.get('size'))} {w.get('coin')} "
                  f"@ ~{fmt_px(w.get('markPx'))} ({fmt_usd(w.get('notionalUsd'))}, {w.get('leverage')}x {w.get('marginMode')})")
            print(dim("SAFE mode — nothing was sent. 'arm' to trade live."))
        else:
            print(red("LIVE ORDER SENT") + f" — {result}")

    def cmd_spot(self, args: list[str]) -> None:
        side, coin, usd = args[0].lower(), args[1], float(args[2])
        if side not in ("buy", "sell"):
            raise ValueError
        armed = self.api("GET", "/api/health").get("armed")
        if armed and not self._confirm_live(f"spot {side} {coin} ${usd:,.2f}"):
            print(dim("cancelled"))
            return
        result = self.api("POST", "/api/spot/order", json={"coin": coin, "side": side, "notionalUsd": usd})
        if result.get("simulated"):
            w = result.get("would") or {}
            print(green("SIMULATED") + f" — would {side} {fmt_num(w.get('size'))} {w.get('coin')} "
                  f"@ ~{fmt_px(w.get('markPx'))} ({fmt_usd(w.get('notionalUsd'))})")
        else:
            print(red("LIVE ORDER SENT") + f" — {result}")

    def cmd_close(self, args: list[str]) -> None:
        coin = args[0]
        size = float(args[1]) if len(args) > 1 else None
        what = f"close {fmt_num(size) + ' ' if size else ''}{coin}"
        if not self._confirm_live(what):
            print(dim("cancelled"))
            return
        payload: dict = {"coin": coin}
        if size is not None:
            payload["size"] = size
        result = self.api("POST", "/api/close", json=payload)
        print(f"closed — {result}")

    def cmd_leverage(self, args: list[str]) -> None:
        coin, lev = args[0], int(args[1])
        margin = args[2].lower() if len(args) > 2 else "cross"
        result = self.api("POST", "/api/leverage", json={"coin": coin, "leverage": lev, "marginMode": margin})
        print(f"leverage set — {result}")

    def cmd_logs(self, args: list[str]) -> None:
        n = int(args[0]) if args else 30
        lines = list(log_ring.buffer)[-n:]
        if not lines and self.attached:
            print(dim("attached to an external backend — its logs live in its own terminal"))
            return
        print("\n".join(lines) if lines else dim("no log lines yet"))

    def cmd_watch(self, args: list[str]) -> None:
        if not args:
            raise ValueError
        name = args[0].lower()
        name = ALIASES.get(name, name)
        if name in ("watch", "arm", "safe", "order", "spot", "close", "leverage", "exit"):
            print("watch only makes sense for read commands")
            return
        print(dim("Ctrl+C stops watching"))
        try:
            while True:
                print("\x1b[2J\x1b[H", end="")  # clear screen, cursor home
                print(dim(f"every 5s — {' '.join(args)} — {datetime.now().strftime('%H:%M:%S')}"))
                self.dispatch(args)
                time.sleep(5)
        except KeyboardInterrupt:
            print()

    def cmd_exit(self, args: list[str]) -> None:
        self.running = False


# name -> (handler, usage, description). Order here is the help order.
COMMANDS: dict[str, tuple] = {
    "help": (Console.cmd_help, "help", "this list"),
    "status": (Console.cmd_status, "status", "backend health, network, SAFE/ARM state"),
    "account": (Console.cmd_account, "account", "your equity + open positions (needs key/address)"),
    "history": (Console.cmd_trades_history, "history [n]", "your saved fill history"),
    "vault": (Console.cmd_vault, "vault [0x…]", "a vault/wallet's positions (default: HyperGrowth)"),
    "trader": (Console.cmd_trader, "trader <0x…>", "profile: win rate, top markets, 7d PnL spark"),
    "leaderboard": (Console.cmd_leaderboard, "leaderboard [day|week|month|allTime] [pnl|roi|vlm]", "top traders"),
    "meta": (Console.cmd_meta, "meta [search]", "markets: mark price, 24h move, open interest"),
    "candles": (Console.cmd_candles, "candles <coin> [interval] [bars]", "OHLC summary + sparkline"),
    "book": (Console.cmd_book, "book <coin> [levels]", "live order book"),
    "tape": (Console.cmd_tape, "tape <coin>", "recent public trades"),
    "watch": (Console.cmd_watch, "watch <command…>", "rerun a read command every 5s"),
    "arm": (Console.cmd_arm, "arm", "enable LIVE orders (asks for confirmation)"),
    "safe": (Console.cmd_safe, "safe", "back to SAFE (simulate-only) mode"),
    "order": (Console.cmd_order, "order <coin> <long|short> <usd> [lev] [cross|isolated]", "simulate (SAFE) or place (ARMED) a market order"),
    "spot": (Console.cmd_spot, "spot <buy|sell> <PAIR> <usd>", "spot market order (e.g. spot buy PURR/USDC 15)"),
    "close": (Console.cmd_close, "close <coin> [size]", "market-close a position (ARMED only)"),
    "leverage": (Console.cmd_leverage, "leverage <coin> <x> [cross|isolated]", "set leverage (ARMED only)"),
    "logs": (Console.cmd_logs, "logs [n]", "recent backend log lines"),
    "exit": (Console.cmd_exit, "exit", "quit (embedded backend stops too)"),
}
ALIASES = {"quit": "exit", "q": "exit", "h": "help", "?": "help", "lb": "leaderboard",
           "positions": "account", "acct": "account", "trades": "tape", "chart": "candles"}


BANNER = r"""
  _  _                             _ _
 | || |_  _ _ __  ___ _ ___ ____ _(_) | |_
 | __ | || | '_ \/ -_) '_\ V / _` | | |  _|
 |_||_|\_, | .__/\___|_|  \_/\__,_|_|_|\__|
       |__/|_|   terminal
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.terminal",
        description="Run the Hypervault backend with an interactive terminal console.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind/connect address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8001, help="backend port (default 8001)")
    parser.add_argument("--attach", action="store_true",
                        help="only attach to an already-running backend; never start one")
    parser.add_argument("-c", "--command", help="run one command non-interactively and exit")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}"
    client = httpx.Client(base_url=base_url, timeout=60.0)

    server = None
    server_thread = None
    attached = False
    if _backend_running(client):
        attached = True
        print(dim(f"backend already running on {base_url} — attaching to it"))
        if not args.attach:
            print(dim("(note: that's the code it was started with, not necessarily this checkout)"))
    elif args.attach:
        print(red(f"no backend answering on {base_url} (without --attach this would boot one)"))
        return 1
    else:
        print(dim(f"starting backend on {base_url} …"))
        server, server_thread = start_embedded_server(args.host, args.port)
        # uvicorn boots in its own thread; wait for /api/health before prompting.
        deadline = time.time() + 20
        while time.time() < deadline and server_thread.is_alive():
            if _backend_running(client):
                break
            time.sleep(0.2)
        if not _backend_running(client):
            print(red("backend failed to start — last log lines:"))
            print("\n".join(list(log_ring.buffer)[-15:]))
            return 1

    console = Console(client, attached)

    if args.command:
        console.dispatch(shlex.split(args.command))
    else:
        if USE_COLOR:
            print(green(BANNER))
        console.cmd_status([])
        print(dim("\ntype 'help' for commands\n"))
        while console.running:
            try:
                line = input(c("hv> ", "1;32") if USE_COLOR else "hv> ").strip()
            except (KeyboardInterrupt, EOFError):
                print()
                break
            if not line:
                continue
            try:
                console.dispatch(shlex.split(line))
            except ValueError:
                print("could not parse that line (unbalanced quotes?)")

    if server is not None:
        print(dim("stopping backend …"))
        server.should_exit = True
        server_thread.join(timeout=10)  # let the lifespan shutdown close the stores
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
