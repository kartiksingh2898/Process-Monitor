import asyncio

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel
import psutil

from ..scraper import get_process_detail, get_processes

router = APIRouter(prefix="/processes", tags=["processes"])


class KillBody(BaseModel):
    force: bool = False
    tree: bool = False


@router.get("/")
async def list_processes():
    # psutil is synchronous and CPU-heavy; run off the event loop.
    return await asyncio.to_thread(get_processes)


@router.get("/{pid}")
async def get_one_process(pid: int):
    try:
        return await asyncio.to_thread(get_process_detail, pid)
    except psutil.NoSuchProcess:
        raise HTTPException(status_code=404, detail="Process not found")
    except psutil.AccessDenied as e:
        raise HTTPException(status_code=403, detail=str(e))


def _terminate_or_kill(proc: psutil.Process, force: bool) -> None:
    if force:
        proc.kill()
    else:
        proc.terminate()


@router.post("/kill/{pid}")
async def kill_process(
    pid: int,
    body: KillBody = Body(default_factory=KillBody),
):
    opts = body
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        raise HTTPException(status_code=404, detail="Process not found")

    try:
        if opts.tree:
            children = proc.children(recursive=True)
            for child in reversed(children):
                try:
                    _terminate_or_kill(child, opts.force)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        _terminate_or_kill(proc, opts.force)
    except psutil.AccessDenied as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"message": f"Process {pid} {'killed' if opts.force else 'terminated'}"}
