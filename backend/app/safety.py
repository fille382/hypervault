"""Runtime safety state.

The app boots in SAFE mode. Orders are simulated (never sent to the exchange)
until the user explicitly flips ARM in the UI. This is an in-memory, per-process
flag: restarting the backend resets it to SAFE.
"""
import threading


class SafetyState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._armed = False

    @property
    def armed(self) -> bool:
        return self._armed

    def set_armed(self, value: bool) -> bool:
        with self._lock:
            self._armed = bool(value)
        return self._armed


safety = SafetyState()
