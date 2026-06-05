"""Pydantic request models for the trading endpoints."""
from typing import Literal, Optional

from pydantic import BaseModel, Field


class OrderRequest(BaseModel):
    coin: str
    side: Literal["long", "short"]
    notionalUsd: float = Field(gt=0, description="USD notional to open (size = notional / mark).")
    leverage: int = Field(ge=1, le=100)
    marginMode: Literal["cross", "isolated"] = "cross"
    slippage: Optional[float] = Field(default=None, ge=0, le=0.5)


class LeverageRequest(BaseModel):
    coin: str
    leverage: int = Field(ge=1, le=100)
    marginMode: Literal["cross", "isolated"] = "cross"


class CloseRequest(BaseModel):
    coin: str


class ArmRequest(BaseModel):
    armed: bool


class CredentialsRequest(BaseModel):
    secretKey: str
    accountAddress: Optional[str] = None
    persist: bool = True
