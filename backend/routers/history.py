from datetime import date, datetime, time as dt_time, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import SystemHistory
from .. import snapshots

router = APIRouter(prefix="/history", tags=["history"])


class RetentionBody(BaseModel):
    days: int = Field(ge=1, le=90, default=7)


@router.post("/retention")
async def set_retention(body: RetentionBody):
    snapshots.set_retention_days(body.days)
    return {"retention_days": snapshots.get_retention_days()}


@router.get("/")
async def list_history(
    from_: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    limit: int = Query(2000, ge=1, le=10000),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(SystemHistory).order_by(SystemHistory.timestamp.asc())
    # Rows are stored as naive UTC; interpret date filters as UTC calendar days.
    if from_ is not None:
        start = datetime.combine(from_, dt_time.min, tzinfo=timezone.utc).replace(tzinfo=None)
        stmt = stmt.where(SystemHistory.timestamp >= start)
    if to_date is not None:
        end = datetime.combine(to_date, dt_time.max, tzinfo=timezone.utc).replace(tzinfo=None)
        stmt = stmt.where(SystemHistory.timestamp <= end)
    stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return {
        "points": [
            {
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "cpu": r.cpu_usage,
                "memory": r.memory_usage,
                "gpu": r.gpu_usage,
            }
            for r in rows
        ]
    }
