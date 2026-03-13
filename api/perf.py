import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Any


@dataclass
class RoutePerfStats:
    path: str
    count: int = 0
    errors: int = 0
    avg_ms: float = 0.0
    max_ms: float = 0.0
    last_ms: float = 0.0
    last_status: int = 200


@dataclass
class RequestPerfRecorder:
    max_samples: int = 200
    started_at: float = field(default_factory=time.time)
    routes: dict[str, RoutePerfStats] = field(default_factory=dict)
    recent: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=200))
    _lock: Lock = field(default_factory=Lock)

    def record(self, path: str, method: str, status_code: int, duration_ms: float) -> None:
        with self._lock:
            stats = self.routes.setdefault(path, RoutePerfStats(path=path))
            stats.count += 1
            if status_code >= 400:
                stats.errors += 1
            stats.last_ms = duration_ms
            stats.last_status = status_code
            stats.max_ms = max(stats.max_ms, duration_ms)
            stats.avg_ms = ((stats.avg_ms * (stats.count - 1)) + duration_ms) / stats.count
            self.recent.append({
                "path": path,
                "method": method,
                "status_code": status_code,
                "duration_ms": round(duration_ms, 2),
                "ts": time.time(),
            })

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            routes = sorted(
                (
                    {
                        "path": route.path,
                        "count": route.count,
                        "errors": route.errors,
                        "avg_ms": round(route.avg_ms, 2),
                        "max_ms": round(route.max_ms, 2),
                        "last_ms": round(route.last_ms, 2),
                        "last_status": route.last_status,
                    }
                    for route in self.routes.values()
                ),
                key=lambda item: item["avg_ms"],
                reverse=True,
            )
            return {
                "started_at": self.started_at,
                "routes": routes,
                "recent": list(self.recent),
            }


request_perf = RequestPerfRecorder()
