from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from .models import Base

# Always use project-root DB (parent of `backend/`), not the process cwd.
_ROOT = Path(__file__).resolve().parent.parent
_DB_PATH = str(_ROOT / "process_monitor.db").replace("\\", "/")
DATABASE_URL = f"sqlite+aiosqlite:///{_DB_PATH}"

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


def _sqlite_add_gpu_column_if_needed(connection):
    rows = connection.execute(text("PRAGMA table_info(system_history)")).fetchall()
    if not rows:
        return
    col_names = {row[1] for row in rows}
    if "gpu_usage" not in col_names:
        connection.execute(text("ALTER TABLE system_history ADD COLUMN gpu_usage REAL"))


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with engine.begin() as conn:
        await conn.run_sync(_sqlite_add_gpu_column_if_needed)

async def get_db():
    async with async_session() as session:
        yield session