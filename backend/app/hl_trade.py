"""Signed Hyperliquid trading via the official SDK.

The SDK is synchronous (it uses `requests`), so the FastAPI routes call these
methods through asyncio.to_thread. The Exchange is built lazily because
constructing it performs network I/O (it loads perp/spot metadata).
"""
import logging
from typing import Any, Optional

import eth_account
from eth_account.signers.local import LocalAccount
from hyperliquid.exchange import Exchange

from .config import PLACEHOLDER_KEY, Settings

logger = logging.getLogger("hypervault.trade")


class TradingNotConfigured(RuntimeError):
    """Raised when an order is attempted without a signing key configured."""


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

    def _get_exchange(self) -> Exchange:
        if self._exchange is None:
            account = self._get_account()
            account_address = self._account_address_cfg or account.address
            self._exchange = Exchange(
                account,
                self._settings.base_url,
                account_address=account_address,
            )
            self._account_address = account_address
            logger.info(
                "Hyperliquid Exchange ready (signer=%s, account=%s, %s)",
                account.address,
                account_address,
                self._settings.network,
            )
        return self._exchange

    # --- helpers -------------------------------------------------------------
    def _mark_price(self, exchange: Exchange, coin: str) -> float:
        coin_key = exchange.info.name_to_coin.get(coin, coin)
        mids = exchange.info.all_mids()
        px = mids.get(coin_key)
        if px is None:
            raise ValueError(f"No mid price available for '{coin}'.")
        return float(px)

    def _round_size(self, exchange: Exchange, coin: str, size: float) -> float:
        asset = exchange.info.name_to_asset(coin)
        sz_decimals = exchange.info.asset_to_sz_decimals[asset]
        return round(size, sz_decimals)

    # --- actions -------------------------------------------------------------
    def preview_order(self, coin: str, notional_usd: float) -> dict:
        """Compute size/price for an order without sending anything (SAFE mode)."""
        exchange = self._get_exchange()
        mark = self._mark_price(exchange, coin)
        size = self._round_size(exchange, coin, notional_usd / mark)
        return {"coin": coin, "markPx": mark, "size": size, "notionalUsd": size * mark}

    def set_leverage(self, coin: str, leverage: int, is_cross: bool) -> Any:
        exchange = self._get_exchange()
        return exchange.update_leverage(int(leverage), coin, is_cross)

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
        mark = self._mark_price(exchange, coin)
        size = self._round_size(exchange, coin, notional_usd / mark)
        if size <= 0:
            raise ValueError("Computed order size rounds to 0 — increase the USD amount.")

        # Set leverage/margin-mode first, then open at market.
        leverage_result = exchange.update_leverage(int(leverage), coin, is_cross)
        order_result = exchange.market_open(coin, is_buy, size, None, slippage)
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

    def close_position(self, coin: str) -> Any:
        """Market-close the entire existing position in `coin`."""
        exchange = self._get_exchange()
        return exchange.market_close(coin)
