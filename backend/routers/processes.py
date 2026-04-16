import asyncio
import subprocess
import sys

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel
import psutil

from ..scraper import get_process_detail, get_processes

router = APIRouter(prefix="/processes", tags=["processes"])


class KillBody(BaseModel):
    force: bool = False
    tree: bool = False


def _terminate_or_kill(proc: psutil.Process, force: bool) -> None:
    if force:
        proc.kill()
    else:
        proc.terminate()


def _kill_tree_windows_taskkill(pid: int, force: bool) -> str:
    """One OS call for the whole tree — much faster than psutil recursive children()."""
    args = ["taskkill", "/PID", str(pid), "/T"]
    if force:
        args.append("/F")
    run_kw = {"capture_output": True, "text": True, "timeout": 120}
    if sys.platform == "win32":
        run_kw["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(args, **run_kw)
    combined = ((r.stderr or "") + (r.stdout or "")).lower()
    if r.returncode == 0:
        return f"Process {pid} {'killed' if force else 'terminated'}"
    if "not found" in combined or "not running" in combined:
        raise psutil.NoSuchProcess(pid)
    if "access is denied" in combined:
        raise psutil.AccessDenied()
    raise RuntimeError((r.stderr or r.stdout or "").strip() or f"taskkill exited {r.returncode}")


def _kill_process_sync(pid: int, force: bool, tree: bool) -> str:
    """Synchronous kill; run in a worker thread from the async route."""
    if sys.platform == "win32" and tree:
        return _kill_tree_windows_taskkill(pid, force)

    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        raise
    if tree:
        children = proc.children(recursive=True)
        for child in reversed(children):
            try:
                _terminate_or_kill(child, force)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    _terminate_or_kill(proc, force)
    return f"Process {pid} {'killed' if force else 'terminated'}"


@router.get("/")
async def list_processes():
    # psutil is synchronous and CPU-heavy; run off the event loop.
    return await asyncio.to_thread(get_processes)


# Static path before /{pid} so "kill" is never captured as a PID segment.
@router.post("/kill/{pid}")
async def kill_process(
    pid: int,
    body: KillBody = Body(default_factory=KillBody),
):
    opts = body
    try:
        msg = await asyncio.to_thread(_kill_process_sync, pid, opts.force, opts.tree)
    except psutil.NoSuchProcess:
        raise HTTPException(status_code=404, detail="Process not found")
    except psutil.AccessDenied as e:
        detail = (str(e) or "").strip() or "Access denied (elevated processes may require running the API as administrator)"
        raise HTTPException(status_code=403, detail=detail)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Kill operation timed out")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": msg}


@router.get("/{pid}")
async def get_one_process(pid: int):
    try:
        return await asyncio.to_thread(get_process_detail, pid)
    except psutil.NoSuchProcess:
        raise HTTPException(status_code=404, detail="Process not found")
    except psutil.AccessDenied as e:
        detail = (str(e) or "").strip() or "Access denied (elevated processes may require running the API as administrator)"
        raise HTTPException(status_code=403, detail=detail)
