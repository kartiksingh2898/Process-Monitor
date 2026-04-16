# Process Manager

A small **local process monitor**: live process list (CPU / RAM / status), system metrics, **CPU / RAM / GPU** history charts, and optional **SQLite-backed** history when the API is running.

- **Backend:** [FastAPI](https://fastapi.tiangolo.com/) + [psutil](https://github.com/giampaolo/psutil) + [SQLAlchemy](https://www.sqlalchemy.org/) (async SQLite).
- **Frontend:** [React](https://react.dev/) + [Vite](https://vite.dev/) + [Chart.js](https://www.chartjs.org/).

Everything talks to your machine over **`127.0.0.1`** — no cloud, no account.

---

## Prerequisites

| Tool | Notes |
|------|--------|
| **Python 3.10+** | Required for the API. |
| **Node.js 18+** (LTS recommended) | Required for the Vite dev UI (and `npm run build`). |

---

## Windows: one-click launch

Double-click **`launch-process-manager.bat`** in the repository root (or run it from a terminal). It will:

1. Create **`venv`** only if it does not exist yet.
2. Run **`pip install -r requirements.txt`** (quick when everything is already installed).
3. Run **`npm install`** in **`frontend/`** only if **`frontend/node_modules`** is missing.
4. Open **two** Command Prompt windows: **Process Manager - API** (Uvicorn) and **Process Manager - UI** (Vite).

Close each window to stop that server. The UI is usually **http://localhost:5173**; the API is **http://127.0.0.1:8000**.

---

## Python dependencies (`pip`)

Install from the **repository root** (the folder that contains `backend/` and `frontend/`):

```bash
python -m venv venv
```

**Windows**

```powershell
.\venv\Scripts\activate
pip install -r requirements.txt
```

**macOS / Linux**

```bash
source venv/bin/activate
pip install -r requirements.txt
```

### What `requirements.txt` installs

| Package | Role |
|---------|------|
| **fastapi** | HTTP API (`/processes`, `/system`, `/history`, …). |
| **uvicorn[standard]** | ASGI server (run + reload in dev). |
| **sqlalchemy[asyncio]** | Async ORM + queries for history (pulls **greenlet** where needed). |
| **aiosqlite** | Async driver for SQLite (`sqlite+aiosqlite`). |
| **psutil** | Process list, CPU/RAM, disk/network metrics. |
| **pydantic** | Request/response models (used by FastAPI). |

---

## Run the API (backend)

From the **repository root**:

**Windows**

```powershell
.\venv\Scripts\activate
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

**macOS / Linux**

```bash
source venv/bin/activate
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

- API: **http://127.0.0.1:8000**
- Health check: **http://127.0.0.1:8000/** (JSON)

On first startup, **`process_monitor.db`** is created next to `backend/` (project root) for saved history.

---

## Run the UI (frontend)

In a **second** terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (usually **http://localhost:5173**).

The UI defaults to **`http://127.0.0.1:8000`** for the API. Change it under **Settings** if your API runs elsewhere.

### Production build (optional)

```bash
cd frontend
npm run build
npm run preview
```

---

## GPU metrics (optional)

On **Windows**, GPU usage is read from **NVIDIA** (`nvidia-smi`) when available, otherwise from **performance counters** (3D engine). If neither works, GPU charts may show gaps or “—”.

---

## Project layout

```
process-monitor/
├── backend/                      # FastAPI app (main, routers, scraper, DB)
├── frontend/                     # Vite + React UI
├── requirements.txt             # Python dependencies
├── launch-process-manager.bat   # Windows: setup (if needed) + start API + UI
└── process_monitor.db           # Created at runtime (history); safe to delete
```

---

## License

Add a license file if you distribute this repo publicly.
