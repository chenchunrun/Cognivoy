"""Process-shared login rate limiting with a small file-backed contract."""

from __future__ import annotations

from collections.abc import Callable
import fcntl
import json
import math
from pathlib import Path
import time
from typing import Any

from cognivoy.services.coordination import (
    SharedCoordinationStore,
    get_shared_coordination_store,
)


class FileLoginRateLimiter:
    """Sliding-window limiter shared by every API worker on one data volume.

    A deployment can replace this object with a Redis/edge implementation as
    long as it exposes the same four methods. The bundled implementation uses
    an inter-process file lock and atomic replace, requiring no extra service.
    """

    def __init__(
        self,
        path: Path | Callable[[], Path],
        *,
        window_seconds: int = 300,
        identity_limit: int = 5,
        ip_limit: int = 30,
    ) -> None:
        self._path_source = path
        self.window_seconds = window_seconds
        self.identity_limit = identity_limit
        self.ip_limit = ip_limit

    @property
    def path(self) -> Path:
        value = self._path_source() if callable(self._path_source) else self._path_source
        return Path(value)

    @staticmethod
    def _keys(client_ip: str, username: str) -> tuple[str, str]:
        normalized = username.strip().casefold()
        return (
            json.dumps(["identity", client_ip, normalized], ensure_ascii=False),
            json.dumps(["ip", client_ip], ensure_ascii=False),
        )

    def _limit(self, key: str) -> int:
        try:
            kind = json.loads(key)[0]
        except (json.JSONDecodeError, IndexError, TypeError):
            kind = "ip"
        return self.identity_limit if kind == "identity" else self.ip_limit

    def _transaction(self, operation: Callable[[dict[str, list[float]], float], Any]) -> Any:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_suffix(path.suffix + ".lock")
        with lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                try:
                    raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
                except (OSError, json.JSONDecodeError):
                    raw = {}
                buckets = {
                    str(key): [float(value) for value in values if isinstance(value, (int, float))]
                    for key, values in raw.items()
                    if isinstance(values, list)
                }
                now = time.time()
                cutoff = now - self.window_seconds
                for key in list(buckets):
                    buckets[key] = [stamp for stamp in buckets[key] if stamp > cutoff]
                    if not buckets[key]:
                        buckets.pop(key, None)
                result = operation(buckets, now)
                temporary = path.with_suffix(path.suffix + ".tmp")
                temporary.write_text(
                    json.dumps(buckets, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                temporary.replace(path)
                return result
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def retry_after(self, client_ip: str, username: str) -> int:
        keys = self._keys(client_ip, username)

        def inspect(buckets: dict[str, list[float]], now: float) -> int:
            remaining = 0
            for key in keys:
                bucket = buckets.get(key, [])
                if len(bucket) >= self._limit(key):
                    remaining = max(
                        remaining,
                        math.ceil(self.window_seconds - (now - bucket[0])),
                    )
            return max(0, remaining)

        return int(self._transaction(inspect))

    def record_failure(self, client_ip: str, username: str) -> None:
        keys = self._keys(client_ip, username)

        def add(buckets: dict[str, list[float]], now: float) -> None:
            for key in keys:
                buckets.setdefault(key, []).append(now)

        self._transaction(add)

    def record_success(self, client_ip: str, username: str) -> None:
        identity_key, _ = self._keys(client_ip, username)
        self._transaction(lambda buckets, _now: buckets.pop(identity_key, None))

    def reset(self) -> None:
        self._transaction(lambda buckets, _now: buckets.clear())


class SharedLoginRateLimiter:
    """Login limiter backed by the deployment coordination database."""

    def __init__(
        self,
        *,
        store: SharedCoordinationStore | None = None,
        window_seconds: int = 300,
        identity_limit: int = 5,
        ip_limit: int = 30,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._store_override = store
        self.window_seconds = int(window_seconds)
        self.identity_limit = int(identity_limit)
        self.ip_limit = int(ip_limit)
        self._clock = clock

    @property
    def store(self) -> SharedCoordinationStore:
        return self._store_override or get_shared_coordination_store()

    @staticmethod
    def _keys(client_ip: str, username: str) -> tuple[str, str]:
        return f"{client_ip}\0{username.strip().casefold()}", str(client_ip)

    def retry_after(self, client_ip: str, username: str) -> int:
        identity_key, ip_key = self._keys(client_ip, username)
        return self.store.login_retry_after(
            identity_key=identity_key,
            ip_key=ip_key,
            identity_limit=self.identity_limit,
            ip_limit=self.ip_limit,
            window_seconds=self.window_seconds,
            now=self._clock(),
        )

    def record_failure(self, client_ip: str, username: str) -> None:
        identity_key, ip_key = self._keys(client_ip, username)
        self.store.record_login_failure(
            identity_key=identity_key,
            ip_key=ip_key,
            now=self._clock(),
        )

    def record_success(self, client_ip: str, username: str) -> None:
        identity_key, _ = self._keys(client_ip, username)
        self.store.clear_login_identity(identity_key)

    def reset(self) -> None:
        self.store.clear_login_events()


__all__ = ["FileLoginRateLimiter", "SharedLoginRateLimiter"]
