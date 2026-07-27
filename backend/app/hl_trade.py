"""Signed Hyperliquid trading via the official SDK.

The SDK is synchronous (it uses `requests`), so the FastAPI routes call these
methods through asyncio.to_thread. The Exchange is built lazily because
constructing it performs network I/O (it loads perp/spot metadata).
"""
import logging
import time
from typing import Any, Callable, Optional, TypeVar

import eth_account
import httpx
from eth_account.signers.local import LocalAccount
from hyperliquid.exchange import Exchange
from hyperliquid.utils.error import ClientError

from .config import PLACEHOLDER_KEY, Settings

logger = logging.getLogger("hypervault.trade")


class TradingNotConfigured(RuntimeError):
    """Raised when an order is attempted without a signing key configured."""


class UpstreamRateLimited(RuntimeError):
    """Hyperliquid's per-IP rate limit (HTTP 429) held through all retries."""


_T = TypeVar("_T")
_RETRY_DELAYS = (1.0, 2.0, 4.0)


def _retry_429(fn: Callable[[], _T]) -> _T:
    """Run an SDK call, retrying with backoff if Hyperliquid answers HTTP 429.

    A 429 is rejected at Hyperliquid's CDN edge before reaching the exchange,
    so the action never executed — retrying cannot double-place an order. The
    usual cause is the dashboard's own polling briefly exhausting the shared
    per-IP request budget, which frees up within seconds.
    """
    for attempt, delay in enumerate((*_RETRY_DELAYS, None)):
        try:
            return fn()
        except ClientError as exc:
            if exc.status_code != 429:
                raise
            if delay is None:
                raise UpstreamRateLimited(
                    "Hyperliquid rate limit (HTTP 429): too many requests from this IP. "
                    "The action was NOT executed — nothing reached the exchange. "
                    "Wait ~30 seconds and try again."
                ) from exc
            logger.warning(
                "Hyperliquid 429 — retrying in %.0fs (attempt %d/%d)",
                delay,
                attempt + 1,
                len(_RETRY_DELAYS),
            )
            time.sleep(delay)
    raise AssertionError("unreachable")


class HLTrader:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._secret_key: Optional[str] = settings.hl_secret_key
        self._account_address_cfg: Optional[str] = settings.hl_account_address
        self._exchange: Optional[Exchange] = None
        self._account: Optional[LocalAccount] = None
        self._account_address: Optional[str] = None

    @staticmethod
    def _key_ok(key: Optional[str]) -> bool:
        return bool(key) and key != PLACEHOLDER_KEY

    @property
    def configured(self) -> bool:
        return self._key_ok(self._secret_key)

    @property
    def account_address(self) -> Optional[str]:
        if self._account_address:
            return self._account_address
        if self._account_address_cfg:
            return self._account_address_cfg
        if self.configured:
            try:
                return self._get_account().address
            except Exception:  # noqa: BLE001
                return None
        return None

    # --- credential management (runtime, from the UI) ------------------------
    def set_credentials(self, secret_key: str, account_address: Optional[str] = None) -> str:
        """Validate + apply a signing key at runtime. Returns the effective account address.

        Raises ValueError (via eth_account) if the key is not a valid private key.
        """
        account = eth_account.Account.from_key(secret_key)
        self._secret_key = secret_key
        self._account_address_cfg = account_address or None
        self._reset()
        effective = account_address or account.address
        logger.info("Credentials set (signer=%s, account=%s)", account.address, effective)
        return effective

    def clear_credentials(self) -> None:
        self._secret_key = None
        self._account_address_cfg = None
        self._reset()
        logger.info("Credentials cleared")

    def _reset(self) -> None:
        self._exchange = None
        self._account = None
        self._account_address = None

    # --- lazy construction ---------------------------------------------------
    def _get_account(self) -> LocalAccount:
        if self._account is None:
            if not self.configured:
                raise TradingNotConfigured("No signing key configured.")
            self._account = eth_account.Account.from_key(self._secret_key)
        return self._account

    def _builder_dex_names(self) -> list[str]:
        """HIP-3 builder dex names (xyz, vntl, …). Needed so the SDK can resolve
        builder-market assets like 'xyz:GOLD'. Best-effort — never fatal."""
        try:
            resp = httpx.post(
                f"{self._settings.base_url}/info", json={"type": "perpDexs"}, timeout=10.0
            )
            resp.raise_for_status()
            return [d["name"] for d in resp.json() or [] if d and d.get("name")]
        except Exception:  # noqa: BLE001
            return []

    def _get_exchange(self) -> Exchange:
        if self._exchange is None:
            account = self._get_account()
            account_address = self._account_address_cfg or account.address
            # Load builder dexes too so markets like 'xyz:GOLD' / 'vntl:SPACEX'
            # are tradeable. If that meta load fails, fall back to main-dex only
            # rather than breaking trading entirely.
            builder = self._builder_dex_names()
            loaded_builders = len(builder)
            try:
                self._exchange = Exchange(
                    account,
                    self._settings.base_url,
                    account_address=account_address,
                    perp_dexs=[""] + builder if builder else None,
                )
            except Exception:  # noqa: BLE001
                logger.warning(
                    "Builder-dex metadata unavailable — main-dex trading only.", exc_info=True
                )
                loaded_builders = 0
                self._exchange = Exchange(
                    account,
                    self._settings.base_url,
                    account_address=account_address,
                )
            self._account_address = account_address
            logger.info(
                "Hyperliquid Exchange ready (signer=%s, account=%s, %s, builderDexs=%d)",
                account.address,
                account_address,
                self._settings.network,
                loaded_builders,
            )
        return self._exchange

    # --- helpers -------------------------------------------------------------
    def _mark_price(self, exchange: Exchange, coin: str) -> float:
        coin_key = exchange.info.name_to_coin.get(coin, coin)
        # Builder-dex mids live under their own dex ("xyz:GOLD" -> dex "xyz");
        # the default all_mids() only carries main-dex prices.
        dex = coin.split(":")[0] if ":" in coin else ""
        mids = exchange.info.all_mids(dex)
        px = mids.get(coin_key)
        if px is None:
            raise ValueError(f"No mid price available for '{coin}'.")
        return float(px)

    def _round_size(self, exchange: Exchange, coin: str, size: float) -> float:
        asset = exchange.info.name_to_asset(coin)
        sz_decimals = exchange.info.asset_to_sz_decimals[asset]
        return round(size, sz_decimals)

    def _round_px(self, exchange: Exchange, coin: str, px: float) -> float:
        """Round a price to Hyperliquid's tick rules (5 sig-figs, max decimals
        by asset). Mirrors the SDK's own _slippage_price rounding."""
        asset = exchange.info.name_to_asset(coin)
        sz_decimals = exchange.info.asset_to_sz_decimals[asset]
        is_spot = asset >= 10_000
        return round(float(f"{px:.5g}"), (8 if is_spot else 6) - sz_decimals)

    # --- actions -------------------------------------------------------------
    def preview_order(self, coin: str, notional_usd: float) -> dict:
        """Compute size/price for an order without sending anything (SAFE mode)."""
        exchange = self._get_exchange()
        mark = self._mark_price(exchange, coin)
        size = self._round_size(exchange, coin, notional_usd / mark)
        return {"coin": coin, "markPx": mark, "size": size, "notionalUsd": size * mark}

    def set_leverage(self, coin: str, leverage: int, is_cross: bool) -> Any:
        exchange = self._get_exchange()
        return _retry_429(lambda: exchange.update_leverage(int(leverage), coin, is_cross))

    def place_market(
        self,
        coin: str,
        is_buy: bool,
        notional_usd: float,
        leverage: int,
        is_cross: bool,
        slippage: float,
    ) -> dict:
        exchange = self._get_exchange()
        mark = _retry_429(lambda: self._mark_price(exchange, coin))
        size = self._round_size(exchange, coin, notional_usd / mark)
        if size <= 0:
            raise ValueError("Computed order size rounds to 0 — increase the USD amount.")

        # Set leverage/margin-mode first, then open at market.
        leverage_result = _retry_429(lambda: exchange.update_leverage(int(leverage), coin, is_cross))
        order_result = _retry_429(lambda: exchange.market_open(coin, is_buy, size, None, slippage))
        return {
            "leverageResult": leverage_result,
            "orderResult": order_result,
            "submitted": {
                "coin": coin,
                "side": "long" if is_buy else "short",
                "size": size,
                "markPx": mark,
                "notionalUsd": size * mark,
                "leverage": int(leverage),
                "marginMode": "cross" if is_cross else "isolated",
                "slippage": slippage,
            },
        }

    def place_spot_market(
        self,
        coin: str,
        is_buy: bool,
        notional_usd: float,
        slippage: float,
    ) -> dict:
        """Market buy/sell on a spot pair — you own (or part with) the actual
        tokens. No leverage or margin mode; the pair name ("HYPE/USDC") is
        resolved by the SDK to its spot asset id."""
        exchange = self._get_exchange()
        mark = _retry_429(lambda: self._mark_price(exchange, coin))
        raw = notional_usd / mark
        size = self._round_size(exchange, coin, raw)
        if not is_buy and size > raw:
            # Never round a sell UP: "sell everything I hold" must not become
            # an order for slightly more than the balance (exchange rejects it).
            asset = exchange.info.name_to_asset(coin)
            step = 10 ** -exchange.info.asset_to_sz_decimals[asset]
            size = self._round_size(exchange, coin, size - step)
        if size <= 0:
            raise ValueError("Computed order size rounds to 0 — increase the USD amount.")
        order_result = _retry_429(lambda: exchange.market_open(coin, is_buy, size, None, slippage))
        return {
            "orderResult": order_result,
            "submitted": {
                "coin": coin,
                "side": "buy" if is_buy else "sell",
                "size": size,
                "markPx": mark,
                "notionalUsd": size * mark,
                "slippage": slippage,
            },
        }

    def close_position(self, coin: str, size: Optional[float] = None) -> Any:
        """Market-close a position. Full close if `size` is None, else a partial
        (reduce-only) close of `size` coin units."""
        exchange = self._get_exchange()
        if size is None:
            return _retry_429(lambda: exchange.market_close(coin))
        size = self._round_size(exchange, coin, size)
        if size <= 0:
            raise ValueError("Reduce size rounds to 0 — increase the amount.")
        return _retry_429(lambda: exchange.market_close(coin, sz=size))

    def _cancel_triggers(self, exchange: Exchange, coin: str) -> int:
        """Cancel existing trigger (TP/SL) orders for `coin` so re-saving auto
        close replaces them rather than stacking duplicates. Best-effort."""
        address = self._account_address or self._account_address_cfg
        if not address:
            try:
                address = self._get_account().address
            except Exception:  # noqa: BLE001
                return 0
        dex = coin.split(":")[0] if ":" in coin else ""
        try:
            opens = exchange.info.frontend_open_orders(address, dex)
        except Exception:  # noqa: BLE001
            return 0
        cancelled = 0
        for o in opens or []:
            if o.get("coin") == coin and o.get("isTrigger"):
                try:
                    exchange.cancel(coin, o["oid"])
                    cancelled += 1
                except Exception:  # noqa: BLE001
                    pass
        return cancelled

    def set_tpsl(
        self,
        coin: str,
        is_long: bool,
        size: float,
        take_profit_px: Optional[float] = None,
        stop_loss_px: Optional[float] = None,
        slippage: float = 0.05,
    ) -> dict:
        """Place reduce-only take-profit / stop-loss market trigger orders that
        close the position when price crosses the trigger. Replaces any existing
        trigger orders on this coin."""
        exchange = self._get_exchange()
        size = self._round_size(exchange, coin, size)
        if size <= 0:
            raise ValueError("Position size rounds to 0.")
        # Closing a long means selling; closing a short means buying.
        is_buy = not is_long
        result: dict = {"cancelledExisting": self._cancel_triggers(exchange, coin)}

        def place(trigger_px: float, tpsl: str) -> Any:
            tpx = self._round_px(exchange, coin, trigger_px)
            # Aggressive limit beyond the trigger so the market trigger fills.
            raw_limit = tpx * (1 + slippage) if is_buy else tpx * (1 - slippage)
            limit_px = self._round_px(exchange, coin, raw_limit)
            return _retry_429(
                lambda: exchange.order(
                    coin,
                    is_buy,
                    size,
                    limit_px,
                    order_type={"trigger": {"triggerPx": tpx, "isMarket": True, "tpsl": tpsl}},
                    reduce_only=True,
                )
            )

        if take_profit_px is not None:
            result["takeProfit"] = place(take_profit_px, "tp")
        if stop_loss_px is not None:
            result["stopLoss"] = place(stop_loss_px, "sl")
        return result
