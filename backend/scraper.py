import datetime
import os
import platform
import re
import subprocess
import sys
import time

import psutil

_cpu_model_cache = None
_memory_speed_mhz_cache = None
_memory_speed_probed = False
_gpu_name_initialized = False
_gpu_name_value = None

cpu_count = psutil.cpu_count()

last_net = psutil.net_io_counters()
last_disk = psutil.disk_io_counters()
last_time = time.time()

# Minimal attrs for the table only — ppid/threads/started/cmdline/RSS load in get_process_detail.
_PROCESS_LIST_ATTRS = (
    "pid",
    "name",
    "username",
    "cpu_percent",
    "memory_percent",
    "status",
)


def _is_system_idle_row(pid, name) -> bool:
    """Windows idle pseudo-process: high % is 'free CPU', not real work — hide from the list."""
    if (name or "").strip().lower() == "system idle process":
        return True
    if sys.platform == "win32" and pid == 0:
        return True
    return False


def _map_status(raw: str) -> str:
    r = (raw or "").lower()
    if r == "running":
        return "running"
    if r == "zombie":
        return "zombie"
    if r in ("disk_sleep", "wait"):
        return "disk-sleep"
    return "sleeping"


def get_processes():
    """Fast list for the table: no cmdline, no RSS (those are loaded via get_process_detail)."""
    processes = []
    cc = cpu_count or 1
    for proc in psutil.process_iter(_PROCESS_LIST_ATTRS, ad_value=None):
        try:
            i = proc.info
            if not i or i.get("pid") is None:
                continue
            pid = i["pid"]
            pname = (i.get("name") or "").strip()
            if not pname:
                continue
            if _is_system_idle_row(pid, pname):
                continue
            cpu_pct = i.get("cpu_percent")
            if cpu_pct is not None:
                cpu_pct = round(float(cpu_pct) / cc, 2)
            else:
                cpu_pct = 0.0
            mem = i.get("memory_percent")
            mem_pct = round(float(mem or 0), 2)
            raw_status = i.get("status")
            status_s = raw_status if isinstance(raw_status, str) else (str(raw_status) if raw_status else "")
            st = _map_status(status_s)
            u = i.get("username")
            processes.append(
                {
                    "pid": pid,
                    "name": pname,
                    "username": u if u else "—",
                    "cpu_percent": cpu_pct,
                    "memory_percent": mem_pct,
                    "status": st,
                    "ppid": 0,
                    "num_threads": 0,
                    "started": "",
                    "cmdline": "",
                    "memory_rss_mb": 0.0,
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    return processes


def get_process_detail(pid: int) -> dict:
    """Full row for one PID (modal): cmdline + RSS + fresh CPU/memory."""
    if _is_system_idle_row(pid, ""):
        raise psutil.NoSuchProcess(pid)
    proc = psutil.Process(pid)
    cc = cpu_count or 1
    with proc.oneshot():
        name = (proc.name() or "").strip()
        cpu_pct = proc.cpu_percent(interval=None)
        if cpu_pct is not None:
            cpu_pct = round(float(cpu_pct) / cc, 2)
        else:
            cpu_pct = 0.0
        mem_pct = proc.memory_percent()
        mem_pct = round(float(mem_pct or 0), 2)
        st = _map_status(proc.status())
        ppid = proc.ppid()
        nt = proc.num_threads()
        try:
            ct = proc.create_time()
            started = datetime_iso_from_create_time(ct)
        except (psutil.Error, OSError, ValueError):
            started = ""
        try:
            cl = proc.cmdline()
            cmdline = " ".join(cl) if cl else name
        except (psutil.Error, OSError):
            cmdline = name
        try:
            rss = proc.memory_info().rss
            rss_mb = round(rss / (1024 * 1024), 1)
        except (psutil.Error, OSError):
            rss_mb = 0.0
        try:
            u = proc.username()
        except (psutil.Error, OSError):
            u = None
    if not name:
        raise psutil.NoSuchProcess(pid)
    return {
        "pid": proc.pid,
        "name": name,
        "username": u if u else "—",
        "cpu_percent": cpu_pct,
        "memory_percent": mem_pct,
        "status": st,
        "ppid": int(ppid),
        "num_threads": int(nt),
        "started": started,
        "cmdline": cmdline,
        "memory_rss_mb": rss_mb,
    }


def datetime_iso_from_create_time(ts: float) -> str:
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, ValueError, OverflowError):
        return ""


def _subprocess_kwargs():
    kw = {"capture_output": True, "text": True, "timeout": 10}
    if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kw


def _gpu_util_nvidia_smi():
    """Average GPU utilization % across NVIDIA adapters (0–100), or None if unavailable."""
    try:
        p = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            **_subprocess_kwargs(),
        )
        if p.returncode != 0 or not (p.stdout or "").strip():
            return None
        vals = []
        for line in (p.stdout or "").strip().splitlines():
            line = line.strip()
            if not line:
                continue
            part = line.split(",")[0].strip()
            try:
                vals.append(float(part))
            except ValueError:
                pass
        if not vals:
            return None
        return round(sum(vals) / len(vals), 1)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _gpu_util_windows_perf_counter():
    """3D engine utilization via performance counters (Windows 10+), or None."""
    if sys.platform != "win32":
        return None
    ps_cmd = (
        "$m=0; try { "
        "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples | "
        "Where-Object { $_.InstanceName -like '*engtype_3D*' } | "
        "ForEach-Object { if ($_.CookedValue -gt $m) { $m = $_.CookedValue } } "
        "} catch { }; "
        "if ($m -gt 100) { $m = 100 }; "
        "[math]::Round([double]$m, 1)"
    )
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            **_subprocess_kwargs(),
        )
        if p.returncode != 0 or not (p.stdout or "").strip():
            return None
        v = float((p.stdout or "").strip().splitlines()[-1].strip())
        return round(min(100.0, max(0.0, v)), 1)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def get_gpu_utilization():
    """System-wide GPU utilization percentage, or None if not measurable on this host."""
    v = _gpu_util_nvidia_smi()
    if v is not None:
        return v
    v = _gpu_util_windows_perf_counter()
    if v is not None:
        return v
    return None


def _gpu_names_nvidia_smi():
    try:
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            **_subprocess_kwargs(),
        )
        if p.returncode != 0 or not (p.stdout or "").strip():
            return None
        names = []
        for line in (p.stdout or "").strip().splitlines():
            n = line.strip()
            if n and n not in names:
                names.append(n)
        if not names:
            return None
        return " · ".join(names) if len(names) > 1 else names[0]
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _gpu_names_windows_wmi():
    if sys.platform != "win32":
        return None
    ps_cmd = (
        "$n = @(); "
        "Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | "
        "ForEach-Object { if ($_.Name) { $t = $_.Name.Trim(); if ($t -and $n -notcontains $t) { $n += $t } } }; "
        "$n -join ' · '"
    )
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            **_subprocess_kwargs(),
        )
        if p.returncode != 0 or not (p.stdout or "").strip():
            return None
        s = (p.stdout or "").strip().splitlines()[-1].strip()
        return s if s else None
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def _gpu_names_linux_lspci():
    if not sys.platform.startswith("linux"):
        return None
    try:
        p = subprocess.run(
            ["lspci"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if p.returncode != 0 or not (p.stdout or "").strip():
            return None
        lines = []
        for line in (p.stdout or "").splitlines():
            low = line.lower()
            if "vga" in low or "3d controller" in low or "display controller" in low:
                # e.g. "01:00.0 VGA compatible controller: NVIDIA ..."
                parts = line.split(":", 2)
                desc = parts[-1].strip() if len(parts) >= 3 else line.strip()
                if desc and desc not in lines:
                    lines.append(desc)
        if not lines:
            return None
        return " · ".join(lines[:4]) if len(lines) > 1 else lines[0]
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _fetch_gpu_model_name():
    n = _gpu_names_nvidia_smi()
    if n:
        return n
    n = _gpu_names_windows_wmi()
    if n:
        return n
    n = _gpu_names_linux_lspci()
    if n:
        return n
    return None


def get_gpu_model_name():
    """Display name(s) for GPU adapter(s), cached per process."""
    global _gpu_name_initialized, _gpu_name_value
    if not _gpu_name_initialized:
        _gpu_name_initialized = True
        _gpu_name_value = _fetch_gpu_model_name()
    return _gpu_name_value


def _fetch_cpu_model_name() -> str:
    system = platform.system()
    try:
        if system == "Windows":
            p = subprocess.run(["wmic", "cpu", "get", "Name"], **_subprocess_kwargs())
            if p.returncode == 0 and p.stdout:
                lines = [
                    ln.strip()
                    for ln in p.stdout.splitlines()
                    if ln.strip() and ln.strip().lower() != "name"
                ]
                names = [ln for ln in lines if ln]
                if names:
                    uniq = []
                    for n in names:
                        if n not in uniq:
                            uniq.append(n)
                    return " · ".join(uniq) if len(uniq) > 1 else uniq[0]
        elif system == "Darwin":
            p = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                **_subprocess_kwargs(),
            )
            if p.returncode == 0 and (p.stdout or "").strip():
                return (p.stdout or "").strip()
        else:
            # Linux and others: model name from cpuinfo
            try:
                with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if line.startswith("model name") or line.startswith("Model name"):
                            return line.split(":", 1)[1].strip()
            except OSError:
                pass
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    proc = (platform.processor() or "").strip()
    return proc if proc else "Unknown"


def get_cpu_model_name() -> str:
    """Human-readable CPU model (cached per process)."""
    global _cpu_model_cache
    if _cpu_model_cache is None:
        _cpu_model_cache = _fetch_cpu_model_name()
    return _cpu_model_cache


def _probe_memory_speed_mhz_windows():
    try:
        p = subprocess.run(
            ["wmic", "memorychip", "get", "Speed"],
            **_subprocess_kwargs(),
        )
        if p.returncode != 0 or not p.stdout:
            return None
        speeds = []
        for ln in p.stdout.splitlines():
            ln = ln.strip()
            if not ln or ln.lower() == "speed":
                continue
            m = re.match(r"^(\d+)", ln)
            if m:
                v = int(m.group(1))
                if v > 0:
                    speeds.append(v)
        return max(speeds) if speeds else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _probe_memory_speed_mhz_linux():
    """Best-effort without root; may return None."""
    try:
        base = "/sys/devices/system/memory"
        speeds = []
        if not os.path.isdir(base):
            return None
        for name in os.listdir(base):
            if not name.startswith("memory"):
                continue
            sp = os.path.join(base, name, "memory_speed_mhz")
            if os.path.isfile(sp):
                try:
                    with open(sp, encoding="utf-8") as f:
                        v = int(f.read().strip())
                        if v > 0:
                            speeds.append(v)
                except (OSError, ValueError):
                    pass
        return max(speeds) if speeds else None
    except OSError:
        return None


def _get_memory_speed_mhz():
    global _memory_speed_mhz_cache, _memory_speed_probed
    if _memory_speed_probed:
        return _memory_speed_mhz_cache
    _memory_speed_probed = True
    if sys.platform == "win32":
        _memory_speed_mhz_cache = _probe_memory_speed_mhz_windows()
    elif sys.platform.startswith("linux"):
        _memory_speed_mhz_cache = _probe_memory_speed_mhz_linux()
    else:
        _memory_speed_mhz_cache = None
    return _memory_speed_mhz_cache


def format_ram_hardware_line(vm) -> str:
    """Installed RAM description (total from live vm + optional speed), Task Manager–style."""
    total_gb = vm.total / (1024**3)
    gbs = f"{round(total_gb, 1)} GB"
    spd = _get_memory_speed_mhz()
    if spd:
        return f"{gbs} @ {spd} MT/s"
    return gbs


def get_system_metrics():
    global last_net, last_disk, last_time

    now = time.time()
    delta_time = now - last_time if (now - last_time) > 0 else 1

    curr_net = psutil.net_io_counters()
    curr_disk = psutil.disk_io_counters()

    download_mbs = ((curr_net.bytes_recv - last_net.bytes_recv) / delta_time) / (1024 * 1024)
    upload_mbs = ((curr_net.bytes_sent - last_net.bytes_sent) / delta_time) / (1024 * 1024)

    disk_read_mbs = 0.0
    disk_write_mbs = 0.0
    if curr_disk is not None and last_disk is not None:
        disk_read_mbs = (
            (curr_disk.read_bytes - last_disk.read_bytes) / delta_time
        ) / (1024 * 1024)
        disk_write_mbs = (
            (curr_disk.write_bytes - last_disk.write_bytes) / delta_time
        ) / (1024 * 1024)

    last_net = curr_net
    if curr_disk is not None:
        last_disk = curr_disk
    last_time = now

    vm = psutil.virtual_memory()

    gpu_pct = get_gpu_utilization()

    return {
        "download_mbs": round(download_mbs, 2),
        "upload_mbs": round(upload_mbs, 2),
        "disk_read_mbs": round(disk_read_mbs, 2),
        "disk_write_mbs": round(disk_write_mbs, 2),
        "total_ram_gb": round(vm.total / (1024**3), 1),
        "memory_percent": round(vm.percent, 1),
        "memory_used_gb": round(vm.used / (1024**3), 2),
        "cpu_usage_avg": psutil.cpu_percent(interval=None),
        "cpu_name": get_cpu_model_name(),
        "ram_hardware": format_ram_hardware_line(vm),
        "gpu_usage_avg": gpu_pct,
        "gpu_metrics_available": gpu_pct is not None,
        "gpu_name": get_gpu_model_name(),
    }
