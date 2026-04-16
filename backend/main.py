import uvicorn
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_db, init_db
from .routers import history, processes
from .scraper import get_system_metrics
from . import snapshots

app = FastAPI(
    title="Process Manager API",
    description="Backend for the Process Manager desktop UI: processes, system metrics, and history.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(processes.router)
app.include_router(history.router)

@app.on_event("startup")
async def startup_event():
    await init_db()

@app.get("/")
def root():
    return {"message": "Process Manager API is running", "version": "1.0.0"}

@app.get("/system")
async def read_system_metrics(db: AsyncSession = Depends(get_db)):
    data = get_system_metrics()
    await snapshots.record_snapshot_throttled(
        db,
        data["cpu_usage_avg"],
        data["memory_percent"],
        data.get("gpu_usage_avg"),
    )
    return data

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)