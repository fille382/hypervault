"""Configuration loaded from backend/.env (and the process environment)."""
import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from hyperliquid.utils import constants

# backend/app/config.py -> parents[1] == backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BACKEND_DIR / ".env"
load_dotenv(ENV_PATH)

# The literal value shipped in .env.example; treated as "not set".
PLACEHOLDER_KEY = "0xyour_api_wallet_private_key_here"


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    network: str               # "mainnet" | "testnet"
    base_url: str
    hl_secret_key: str | None
    hl_account_address: str | None
    max_order_notional_usd: float
    default_slippage: float
    cors_origins: list[str]

    @property
    def has_key(self) -> bool:
        key = self.hl_secret_key
        return bool(key) and key != PLACEHOLDER_KEY


def load_settings() -> Settings:
    network = (os.getenv("HL_NETWORK") or "mainnet").strip().lower()
    is_testnet = network == "testnet"
    base_url = constants.TESTNET_API_URL if is_testnet else constants.MAINNET_API_URL

    key = (os.getenv("HL_SECRET_KEY") or "").strip() or None
    address = (os.getenv("HL_ACCOUNT_ADDRESS") or "").strip() or None

    return Settings(
        network="testnet" if is_testnet else "mainnet",
        base_url=base_url,
        hl_secret_key=key,
        hl_account_address=address,
        max_order_notional_usd=float(os.getenv("MAX_ORDER_NOTIONAL_USD") or "2000"),
        default_slippage=float(os.getenv("DEFAULT_SLIPPAGE") or "0.01"),
        cors_origins=_split_csv(
            os.getenv("CORS_ORIGINS")
            # Vite dev servers plus the GitHub Pages site (which calls this
            # backend on loopback — see frontend/src/api.js).
            or "http://localhost:5173,http://127.0.0.1:5173"
            ",http://localhost:5174,http://127.0.0.1:5174"
            ",https://fille382.github.io"
        ),
    )


def update_env_file(updates: dict[str, str]) -> None:
    """Create/update keys in backend/.env, preserving comments and other lines."""
    lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and m.group(1) in updates:
            name = m.group(1)
            out.append(f"{name}={updates[name]}")
            seen.add(name)
        else:
            out.append(line)
    for name, value in updates.items():
        if name not in seen:
            out.append(f"{name}={value}")
    ENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")


settings = load_settings()
