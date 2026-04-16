import asyncio
import time
from datetime import datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from .models import SystemHistory

_lock = asyncio.Lock()
_last_monotonic = 0.0
INTERVAL_SEC = 5.0
_retention_days = 7


def set_retention_days(days: int) -> None:
    global _retention_days
    _retention_days = max(1, min(90, int(days)))


def get_retention_days() -> int:
    return _retention_days


async def record_snapshot_throttled(
    session: AsyncSession,
    cpu: float,
    mem: float,
    gpu: float | None = None,
) -> None:
    global _last_monotonic
    async with _lock:
        now = time.monotonic()
        if now - _last_monotonic < INTERVAL_SEC:
            return
        _last_monotonic = now
        row = SystemHistory(
            cpu_usage=float(cpu),
            memory_usage=float(mem),
            gpu_usage=float(gpu) if gpu is not None else None,
            timestamp=datetime.utcnow(),
        )
        session.add(row)
        cutoff = datetime.utcnow() - timedelta(days=_retention_days)
        await session.execute(delete(SystemHistory).where(SystemHistory.timestamp < cutoff))
        await session.commit()
