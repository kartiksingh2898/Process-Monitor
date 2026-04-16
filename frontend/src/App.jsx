import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import clsx from 'clsx';
import toast, { Toaster } from 'react-hot-toast';
import { Cog } from 'lucide-react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

/** Index of the last finite Y value in a series (for “current” marker). */
function getLastFiniteSeriesIndex(data) {
  if (!data?.length) return -1;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const v = data[i];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return i;
  }
  return -1;
}

/** Circle on the latest sample (series-colored ring); rest of the line stays point-free. */
function lineDatasetCurrentPointStyle(seriesColor, centerFill = '#161b22') {
  return {
    pointRadius: (ctx) => {
      if (ctx.datasetIndex !== 0) return 0;
      const last = getLastFiniteSeriesIndex(ctx.dataset.data);
      return last >= 0 && ctx.dataIndex === last ? 7.2 : 0;
    },
    pointHoverRadius: (ctx) => {
      if (ctx.datasetIndex !== 0) return 0;
      const last = getLastFiniteSeriesIndex(ctx.dataset.data);
      return last >= 0 && ctx.dataIndex === last ? 10.4 : 0;
    },
    pointBackgroundColor: (ctx) => {
      if (ctx.datasetIndex !== 0) return 'transparent';
      const last = getLastFiniteSeriesIndex(ctx.dataset.data);
      if (last < 0 || ctx.dataIndex !== last) return 'transparent';
      return centerFill;
    },
    pointBorderColor: (ctx) => {
      if (ctx.datasetIndex !== 0) return 'transparent';
      const last = getLastFiniteSeriesIndex(ctx.dataset.data);
      if (last < 0 || ctx.dataIndex !== last) return 'transparent';
      return seriesColor;
    },
    pointBorderWidth: (ctx) => {
      if (ctx.datasetIndex !== 0) return 0;
      const last = getLastFiniteSeriesIndex(ctx.dataset.data);
      return last >= 0 && ctx.dataIndex === last ? 2.4 : 0;
    },
  };
}

/** Round to one decimal (avoids float noise in labels). */
function roundOneDecimal(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** "12.3%" for canvas labels and chart tooltips. */
function formatPctOneDecimal(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${roundOneDecimal(n).toFixed(1)}%`;
}

/** Draws current % near the last point on single-series line charts. */
const currentSeriesEndLabelPlugin = {
  id: 'currentSeriesEndLabel',
  afterDatasetsDraw(chart) {
    if (chart.options.plugins?.currentSeriesEndLabel === false) return;
    const ds0 = chart.data?.datasets?.[0];
    const meta0 = chart.getDatasetMeta(0);
    if (!ds0?.data?.length || !meta0?.data?.length) return;
    const last = getLastFiniteSeriesIndex(ds0.data);
    if (last < 0) return;
    const pt = meta0.data[last];
    if (!pt || pt.skip) return;
    const val = Number(ds0.data[last]);
    if (!Number.isFinite(val)) return;
    const area = chart.chartArea;
    if (!area) return;
    const label = formatPctOneDecimal(val);
    const seriesColor =
      typeof ds0.borderColor === 'string'
        ? ds0.borderColor
        : Array.isArray(ds0.borderColor)
          ? ds0.borderColor[0]
          : '#58a6ff';
    const { ctx } = chart;
    const chartW = chart.width;
    const chartH = chart.height;
    /** Keep text fully inside canvas (stroke extends past glyph bounds). */
    const padY = 12;
    const padX = 4;
    const above = 18;
    const below = 24;
    let y = pt.y - above;
    if (y < padY) y = pt.y + below;
    if (y > chartH - padY) y = Math.min(pt.y - above, chartH - padY);
    if (y < padY) y = padY;
    ctx.save();
    ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    const textW = ctx.measureText(label).width;
    const half = textW / 2 + 3;
    let x = pt.x;
    x = Math.max(padX + half, Math.min(chartW - padX - half, x));
    ctx.strokeStyle = 'rgba(13,17,23,0.94)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = seriesColor;
    ctx.fillText(label, x, y);
    ctx.restore();
  },
};

Chart.register(currentSeriesEndLabelPlugin);

const SETTINGS_KEY = 'process_manager_settings';
/** Old localStorage key — still read once so settings survive the rename */
const LEGACY_SETTINGS_KEY = 'procmon_settings';

const DEFAULT_SETTINGS = {
  refreshSec: 3,
  maxProcs: 50,
  retentionDays: 7,
  forceKill: false,
  killTree: false,
  confirmKill: true,
  ws: false,
  apiBase: 'http://127.0.0.1:8000',
};

const SERVICE_USERS = new Set(
  ['SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'ROOT', 'WWW-DATA'].map((s) => s.toUpperCase()),
);

function readStoredSettings() {
  try {
    let raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function cpuColor(v) {
  if (v < 30) return '#3fb950';
  if (v < 70) return '#d29922';
  return '#f85149';
}

function statusBadgeClass(s) {
  if (s === 'running') return 's-running';
  if (s === 'disk-sleep') return 's-disk';
  if (s === 'zombie') return 's-zombie';
  return 's-sleeping';
}

function statusLabel(s) {
  if (s === 'disk-sleep') return 'disk-sleep';
  return s || 'sleeping';
}

function csvEscapeRow(cells) {
  return cells
    .map((c) => {
      const s = String(c ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(',');
}

function downloadBlob(filename, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  clip: false,
  animation: { duration: 400 },
  /** Room above/beside plot so canvas labels are not clipped by chart area edges. */
  layout: {
    padding: { top: 22, right: 12, bottom: 10, left: 12 },
  },
  plugins: {
    legend: { display: false },
    currentSeriesEndLabel: true,
    tooltip: {
      callbacks: {
        label: (ctx) => {
          const y = ctx.parsed?.y;
          if (y == null || Number.isNaN(Number(y))) return '—';
          return formatPctOneDecimal(y);
        },
      },
    },
  },
  scales: {
    x: { display: false, grid: { display: false } },
    y: {
      min: 0,
      max: 100,
      grid: { color: 'rgba(255,255,255,0.05)' },
      ticks: {
        color: '#6e7681',
        font: { size: 10 },
        callback: (v) => `${v}%`,
      },
    },
  },
};

function statsMinAvgMax(arr) {
  const nums = arr.filter((x) => x != null && typeof x === 'number' && !Number.isNaN(x));
  if (!nums.length) return { min: '--', avg: '--', max: '--' };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return {
    min: roundOneDecimal(min).toFixed(1),
    avg: roundOneDecimal(avg).toFixed(1),
    max: roundOneDecimal(max).toFixed(1),
  };
}

function formatApiError(err) {
  const d = err.response?.data?.detail;
  if (Array.isArray(d)) {
    return d
      .map((x) => (typeof x === 'object' && x?.msg ? x.msg : JSON.stringify(x)))
      .join('; ');
  }
  if (d != null) return String(d);
  return err.message || 'Request failed';
}

export default function App() {
  const [settings, setSettings] = useState(readStoredSettings);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [processes, setProcesses] = useState([]);
  const [systemData, setSystemData] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [sortKey, setSortKey] = useState('cpu_percent');
  const [sortDir, setSortDir] = useState('desc');
  const [paused, setPaused] = useState(false);
  const [liveTime, setLiveTime] = useState('');

  const [liveCpu, setLiveCpu] = useState([]);
  const [liveRam, setLiveRam] = useState([]);
  const [liveGpu, setLiveGpu] = useState([]);
  const [liveLabels, setLiveLabels] = useState([]);

  const [histFrom, setHistFrom] = useState(() => daysAgoISO(1));
  const [histTo, setHistTo] = useState(todayISO);
  const [histPoints, setHistPoints] = useState([]);

  const [modalProc, setModalProc] = useState(null);
  const [modalDetailLoading, setModalDetailLoading] = useState(false);
  const [killBusyPid, setKillBusyPid] = useState(null);

  const api = useMemo(() => axios.create({ baseURL: settings.apiBase }), [settings.apiBase]);

  const pausedRef = useRef(paused);
  const lastFetchErrToast = useRef(0);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const sortSelectValue = useMemo(() => {
    if (sortKey === 'cpu_percent') return `cpu-${sortDir}`;
    if (sortKey === 'memory_percent') return `ram-${sortDir}`;
    if (sortKey === 'name') return `name-${sortDir}`;
    if (sortKey === 'pid') return `pid-${sortDir}`;
    return 'cpu-desc';
  }, [sortKey, sortDir]);

  const dashCpuCanvas = useRef(null);
  const dashRamCanvas = useRef(null);
  const dashGpuCanvas = useRef(null);
  const dashCpuChart = useRef(null);
  const dashRamChart = useRef(null);
  const dashGpuChart = useRef(null);

  const histCpuCanvas = useRef(null);
  const histRamCanvas = useRef(null);
  const histGpuCanvas = useRef(null);
  const histCpuChart = useRef(null);
  const histRamChart = useRef(null);
  const histGpuChart = useRef(null);

  const dashChartsRowRef = useRef(null);
  const histChartsRowRef = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setLiveTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const elCpu = dashCpuCanvas.current;
    const elRam = dashRamCanvas.current;
    const elGpu = dashGpuCanvas.current;
    if (!elCpu || !elRam || !elGpu) return;

    dashCpuChart.current = new Chart(elCpu.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            borderColor: '#58a6ff',
            borderWidth: 1.5,
            fill: true,
            backgroundColor: 'rgba(88,166,255,0.08)',
            tension: 0.4,
            ...lineDatasetCurrentPointStyle('#58a6ff'),
          },
        ],
      },
      options: { ...chartDefaults },
    });
    dashRamChart.current = new Chart(elRam.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            borderColor: '#bc8cff',
            borderWidth: 1.5,
            fill: true,
            backgroundColor: 'rgba(188,140,255,0.08)',
            tension: 0.4,
            ...lineDatasetCurrentPointStyle('#bc8cff'),
          },
        ],
      },
      options: { ...chartDefaults },
    });
    dashGpuChart.current = new Chart(elGpu.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            data: [],
            borderColor: '#f0883e',
            borderWidth: 1.5,
            fill: true,
            backgroundColor: 'rgba(240,136,62,0.08)',
            tension: 0.4,
            spanGaps: false,
            ...lineDatasetCurrentPointStyle('#f0883e'),
          },
        ],
      },
      options: { ...chartDefaults },
    });

    return () => {
      dashCpuChart.current?.destroy();
      dashRamChart.current?.destroy();
      dashGpuChart.current?.destroy();
      dashCpuChart.current = null;
      dashRamChart.current = null;
      dashGpuChart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = dashCpuChart.current;
    const r = dashRamChart.current;
    const g = dashGpuChart.current;
    if (!c || !r || !g) return;
    c.data.labels = [...liveLabels];
    c.data.datasets[0].data = [...liveCpu];
    c.update('none');
    r.data.labels = [...liveLabels];
    r.data.datasets[0].data = [...liveRam];
    r.update('none');
    g.data.labels = [...liveLabels];
    g.data.datasets[0].data = [...liveGpu];
    g.update('none');
  }, [liveCpu, liveRam, liveGpu, liveLabels]);

  /** Chart.js does not always pick up CSS grid / flex size changes; force resize. */
  useEffect(() => {
    const resizeDashboardCharts = () => {
      requestAnimationFrame(() => {
        dashCpuChart.current?.resize();
        dashRamChart.current?.resize();
        dashGpuChart.current?.resize();
      });
    };
    const row = dashChartsRowRef.current;
    let ro;
    if (row && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resizeDashboardCharts);
      ro.observe(row);
    }
    window.addEventListener('resize', resizeDashboardCharts);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', resizeDashboardCharts);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        dashCpuChart.current?.resize();
        dashRamChart.current?.resize();
        dashGpuChart.current?.resize();
      });
    });
    return () => cancelAnimationFrame(id);
  }, [activeTab]);

  const initHistCharts = useCallback(() => {
    const elC = histCpuCanvas.current;
    const elR = histRamCanvas.current;
    const elG = histGpuCanvas.current;
    if (!elC || !elR || !elG) return;
    if (!histCpuChart.current) {
      histCpuChart.current = new Chart(elC.getContext('2d'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              borderColor: '#58a6ff',
              borderWidth: 1.5,
              fill: true,
              backgroundColor: 'rgba(88,166,255,0.08)',
              tension: 0.4,
              ...lineDatasetCurrentPointStyle('#58a6ff'),
            },
          ],
        },
        options: {
          ...chartDefaults,
          scales: {
            ...chartDefaults.scales,
            x: {
              display: true,
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#6e7681', font: { size: 9 }, maxRotation: 45 },
            },
          },
        },
      });
    }
    if (!histRamChart.current) {
      histRamChart.current = new Chart(elR.getContext('2d'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              borderColor: '#bc8cff',
              borderWidth: 1.5,
              fill: true,
              backgroundColor: 'rgba(188,140,255,0.08)',
              tension: 0.4,
              ...lineDatasetCurrentPointStyle('#bc8cff'),
            },
          ],
        },
        options: {
          ...chartDefaults,
          scales: {
            ...chartDefaults.scales,
            x: {
              display: true,
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#6e7681', font: { size: 9 }, maxRotation: 45 },
            },
          },
        },
      });
    }
    if (!histGpuChart.current) {
      histGpuChart.current = new Chart(elG.getContext('2d'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              borderColor: '#f0883e',
              borderWidth: 1.5,
              fill: true,
              backgroundColor: 'rgba(240,136,62,0.08)',
              /* No tension: null samples (rows before GPU column) must not be interpolated across. */
              tension: 0,
              spanGaps: false,
              ...lineDatasetCurrentPointStyle('#f0883e'),
            },
          ],
        },
        options: {
          ...chartDefaults,
          interaction: { mode: 'index', intersect: false },
          scales: {
            ...chartDefaults.scales,
            x: {
              display: true,
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#6e7681', font: { size: 9 }, maxRotation: 45 },
            },
          },
        },
      });
    }
  }, []);

  const updateHistCharts = useCallback(() => {
    initHistCharts();
    const labels = histPoints.map((p) => {
      try {
        return new Date(p.timestamp).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return p.timestamp;
      }
    });
    const cpus = histPoints.map((p) => p.cpu);
    const rams = histPoints.map((p) => p.memory);
    const gpus = histPoints.map((p) => {
      if (p.gpu == null || p.gpu === '') return null;
      const v = Number(p.gpu);
      return Number.isFinite(v) ? v : null;
    });
    if (histCpuChart.current) {
      histCpuChart.current.data.labels = labels;
      histCpuChart.current.data.datasets[0].data = cpus;
      histCpuChart.current.update('none');
    }
    if (histRamChart.current) {
      histRamChart.current.data.labels = labels;
      histRamChart.current.data.datasets[0].data = rams;
      histRamChart.current.update('none');
    }
    if (histGpuChart.current) {
      histGpuChart.current.data.labels = labels;
      histGpuChart.current.data.datasets[0].data = gpus;
      histGpuChart.current.update('none');
    }
    requestAnimationFrame(() => {
      histCpuChart.current?.resize();
      histRamChart.current?.resize();
      histGpuChart.current?.resize();
    });
  }, [histPoints, initHistCharts]);

  useEffect(() => {
    if (activeTab !== 'history') return;
    const t = requestAnimationFrame(() => updateHistCharts());
    return () => cancelAnimationFrame(t);
  }, [activeTab, histPoints, updateHistCharts]);

  useEffect(() => {
    if (activeTab !== 'history') return;
    const resizeHistoryCharts = () => {
      requestAnimationFrame(() => {
        histCpuChart.current?.resize();
        histRamChart.current?.resize();
        histGpuChart.current?.resize();
      });
    };
    const row = histChartsRowRef.current;
    let ro;
    if (row && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resizeHistoryCharts);
      ro.observe(row);
    }
    window.addEventListener('resize', resizeHistoryCharts);
    resizeHistoryCharts();
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', resizeHistoryCharts);
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'history') {
      histCpuChart.current?.destroy();
      histRamChart.current?.destroy();
      histGpuChart.current?.destroy();
      histCpuChart.current = null;
      histRamChart.current = null;
      histGpuChart.current = null;
    }
  }, [activeTab]);

  const closeModal = useCallback(() => {
    setModalProc(null);
    setModalDetailLoading(false);
  }, []);

  const openProcessModal = useCallback(
    async (p) => {
      setModalProc(p);
      setModalDetailLoading(true);
      try {
        const { data } = await api.get(`/processes/${p.pid}`);
        setModalProc(data);
      } catch (err) {
        toast.error(formatApiError(err));
      } finally {
        setModalDetailLoading(false);
      }
    },
    [api],
  );

  const fetchTick = useCallback(async () => {
    if (pausedRef.current) return;
    try {
      const sysRes = await api.get('/system');
      setSystemData(sysRes.data);
      const cpuVal = Math.min(100, Number(sysRes.data.cpu_usage_avg) || 0);
      const ramVal = Math.min(100, Number(sysRes.data.memory_percent) || 0);
      const rawGpu = sysRes.data.gpu_usage_avg;
      const gpuVal =
        rawGpu != null && rawGpu !== ''
          ? Math.min(100, Number(rawGpu))
          : null;
      const label = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setLiveCpu((prev) => [...prev.slice(-59), cpuVal]);
      setLiveRam((prev) => [...prev.slice(-59), ramVal]);
      setLiveGpu((prev) => [...prev.slice(-59), gpuVal]);
      setLiveLabels((prev) => [...prev.slice(-59), label]);
      setLoading(false);

      const procRes = await api.get('/processes/');
      setProcesses(procRes.data);
    } catch (e) {
      console.error(e);
      setLoading(false);
      const now = Date.now();
      if (now - lastFetchErrToast.current > 15000) {
        lastFetchErrToast.current = now;
        toast.error('Could not reach Process Manager API — check the server and URL in Settings');
      }
    }
  }, [api]);

  useEffect(() => {
    fetchTick();
    const ms = Math.max(1, settings.refreshSec) * 1000;
    const id = setInterval(fetchTick, ms);
    return () => clearInterval(id);
  }, [fetchTick, settings.refreshSec]);

  const loadHistory = useCallback(
    async (fromOverride, toOverride) => {
      const from = fromOverride ?? histFrom;
      const to = toOverride ?? histTo;
      try {
        const params = {};
        if (from) params.from = from;
        if (to) params.to = to;
        const { data } = await api.get('/history/', { params });
        setHistPoints(data.points || []);
      } catch (e) {
        console.error(e);
        toast.error('Could not load Process Manager history');
      }
    },
    [api, histFrom, histTo],
  );

  const onTab = (id) => {
    setActiveTab(id);
    if (id === 'history') loadHistory();
  };

  const filteredSorted = useMemo(() => {
    let procs = [...processes];
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      procs = procs.filter(
        (p) =>
          (p.name || '').toLowerCase().includes(q) ||
          String(p.pid).includes(q) ||
          (p.username || '').toLowerCase().includes(q),
      );
    }
    if (activeFilter === 'highcpu') procs = procs.filter((p) => (p.cpu_percent || 0) > 50);
    if (activeFilter === 'running') procs = procs.filter((p) => p.status === 'running');
    if (activeFilter === 'user') {
      procs = procs.filter((p) => {
        const u = (p.username || '').toUpperCase();
        return u && u !== '—' && !SERVICE_USERS.has(u);
      });
    }

    const mult = sortDir === 'desc' ? -1 : 1;
    const key = sortKey;
    procs.sort((a, b) => {
      let va;
      let vb;
      if (key === 'name') {
        return mult * String(a.name || '').localeCompare(String(b.name || ''));
      }
      va = Number(a[key] ?? 0);
      vb = Number(b[key] ?? 0);
      if (va < vb) return -1 * mult;
      if (va > vb) return 1 * mult;
      return 0;
    });
    return procs.slice(0, settings.maxProcs);
  }, [processes, searchTerm, activeFilter, sortKey, sortDir, settings.maxProcs]);

  const runningCount = useMemo(
    () => processes.filter((p) => p.status === 'running').length,
    [processes],
  );
  const sleepingCount = useMemo(() => Math.max(0, processes.length - runningCount), [processes, runningCount]);

  const topProc = useMemo(() => {
    if (!processes.length) return null;
    return [...processes].sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0))[0];
  }, [processes]);

  const cpuStats = useMemo(() => statsMinAvgMax(liveCpu), [liveCpu]);
  const ramStats = useMemo(() => statsMinAvgMax(liveRam), [liveRam]);
  const gpuStats = useMemo(() => statsMinAvgMax(liveGpu), [liveGpu]);

  const onSortSelect = (e) => {
    const v = e.target.value;
    const lastDash = v.lastIndexOf('-');
    const sk = v.slice(0, lastDash);
    const sd = v.slice(lastDash + 1);
    if (sk === 'cpu') setSortKey('cpu_percent');
    else if (sk === 'ram') setSortKey('memory_percent');
    else if (sk === 'name') setSortKey('name');
    else if (sk === 'pid') setSortKey('pid');
    setSortDir(sd);
  };

  const headerSort = (col) => {
    const map = { pid: 'pid', name: 'name', cpu: 'cpu_percent', ram: 'memory_percent' };
    const k = map[col];
    if (sortKey === k) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(k);
      setSortDir(col === 'name' || col === 'pid' ? 'asc' : 'desc');
    }
  };

  const exportCSV = () => {
    const header = ['PID', 'Name', 'CPU%', 'RAM%', 'Status', 'User'];
    const rows = filteredSorted.map((p) => [
      p.pid,
      p.name,
      p.cpu_percent,
      p.memory_percent,
      p.status,
      p.username,
    ]);
    const csv = [header, ...rows].map(csvEscapeRow).join('\n');
    downloadBlob('process-manager-processes.csv', csv, 'text/csv');
    toast.success('Exported process-manager-processes.csv');
  };

  const exportJSON = () => {
    downloadBlob('process-manager-processes.json', JSON.stringify(filteredSorted, null, 2), 'application/json');
    toast.success('Exported process-manager-processes.json');
  };

  const exportHistCSV = () => {
    if (!histPoints.length) {
      toast.error('No history data yet');
      return;
    }
    const rows = [
      ['Timestamp', 'CPU%', 'RAM%', 'GPU%'],
      ...histPoints.map((d) => [d.timestamp, d.cpu, d.memory, d.gpu ?? '']),
    ];
    downloadBlob('process-manager-history.csv', rows.map(csvEscapeRow).join('\n'), 'text/csv');
    toast.success('Exported process-manager-history.csv');
  };

  const killProcess = async (p, treeOverride) => {
    // Only omit the second arg to use settings.killTree; `false`/`true` are explicit (?? would treat false as "use default").
    const tree = treeOverride === undefined ? settings.killTree : treeOverride;
    const msg = `Kill ${p.name} (PID ${p.pid})${tree ? ' and its children' : ''}?`;
    if (settings.confirmKill && !window.confirm(msg)) return;
    setKillBusyPid(p.pid);
    try {
      await api.post(`/processes/kill/${p.pid}`, { force: settings.forceKill, tree });
      toast.success(`${settings.forceKill ? 'Force-killed' : 'Terminated'} ${p.name} (${p.pid})`);
      closeModal();
      requestAnimationFrame(() => {
        fetchTick();
      });
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setKillBusyPid(null);
    }
  };

  const saveSettings = async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    try {
      localStorage.removeItem(LEGACY_SETTINGS_KEY);
    } catch {
      /* ignore */
    }
    try {
      await api.post('/history/retention', { days: settings.retentionDays });
      toast.success('Settings saved');
    } catch {
      toast.error('Saved locally only — could not reach Process Manager API for retention');
    }
  };

  const setHistRangeHours = (h) => {
    const now = new Date();
    const from = new Date(now.getTime() - h * 3600000);
    const iso = (d) =>
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const fromS = iso(from);
    const toS = iso(now);
    setHistFrom(fromS);
    setHistTo(toS);
    loadHistory(fromS, toS);
  };

  const sortArrow = (col) => {
    const map = { pid: 'pid', name: 'name', cpu: 'cpu_percent', ram: 'memory_percent' };
    const active = sortKey === map[col];
    if (!active) return '↕';
    return sortDir === 'desc' ? '▼' : '▲';
  };

  const thSorted = (col) => {
    const map = { pid: 'pid', name: 'name', cpu: 'cpu_percent', ram: 'memory_percent' };
    return sortKey === map[col] ? 'sorted' : '';
  };

  return (
    <>
      <h2 className="sr-only">
        Process Manager — live process list, performance charts, and system metrics
      </h2>
      <Toaster position="bottom-right" toastOptions={{ style: { background: '#161b22', color: '#e6edf3' } }} />

      <div className="topbar">
        <div className="topbar-left">
          <div className="logo-brand" aria-label="Process Manager">
            <Cog
              className="logo-mark"
              size={17}
              color="var(--c-accent)"
              strokeWidth={2}
              aria-hidden
            />
            <span className="logo">Process Manager</span>
          </div>
          <span className="version-badge">v1.0</span>
          <span className="status-dot" aria-hidden />
          <span style={{ fontSize: 11, color: 'var(--c-muted)' }}>{liveTime}</span>
        </div>
        <div className="topbar-right">
          <span style={{ fontSize: 11, color: 'var(--c-muted)' }}>{processes.length} processes</span>
          <button type="button" className="btn btn-sm" onClick={exportCSV}>
            ↓ CSV
          </button>
          <button type="button" className="btn btn-sm" onClick={exportJSON}>
            ↓ JSON
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </div>

      <div className="nav">
        <button
          type="button"
          className={clsx('nav-tab', activeTab === 'dashboard' && 'active')}
          onClick={() => onTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={clsx('nav-tab', activeTab === 'history' && 'active')}
          onClick={() => onTab('history')}
        >
          History
        </button>
        <button
          type="button"
          className={clsx('nav-tab', activeTab === 'settings' && 'active')}
          onClick={() => onTab('settings')}
        >
          Settings
        </button>
      </div>

      <div id="page-dashboard" className={clsx('page', activeTab === 'dashboard' && 'active')}>
        <div className="metrics-row">
          <div className="metric-card">
            <div className="metric-label">CPU Usage</div>
            <div
              className="metric-value"
              style={{ color: cpuColor(Number(systemData.cpu_usage_avg) || 0) }}
            >
              {systemData.cpu_usage_avg != null ? `${Number(systemData.cpu_usage_avg).toFixed(1)}%` : '—'}
            </div>
            <div className="metric-sub">System-wide average</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Memory Usage</div>
            <div className="metric-value" style={{ color: 'var(--c-purple)' }}            >
              {systemData.memory_percent != null ? `${Number(systemData.memory_percent).toFixed(1)}%` : '—'}
            </div>
            <div className="metric-sub">
              {systemData.memory_used_gb != null && systemData.total_ram_gb != null
                ? `${systemData.memory_used_gb} / ${systemData.total_ram_gb} GB`
                : '—'}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Processes</div>
            <div className="metric-value" style={{ color: 'var(--c-green)' }}>
              {processes.length || '—'}
            </div>
            <div className="metric-sub">
              {processes.length ? `${runningCount} running / ${sleepingCount} other` : '—'}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Top Process</div>
            <div className="metric-value" style={{ fontSize: 14, color: 'var(--c-yellow)' }}>
              {topProc ? topProc.name : '—'}
            </div>
            <div className="metric-sub">
              {topProc ? `${Number(topProc.cpu_percent ?? 0).toFixed(1)}% CPU` : 'Highest CPU'}
            </div>
          </div>
        </div>

        <div className="charts-row" ref={dashChartsRowRef}>
          <div className="chart-card">
            <div className="chart-title">
              <span>CPU History</span>
              <div className="chart-stat">
                <span>
                  min: <b>{cpuStats.min}</b>%
                </span>
                <span>
                  avg: <b>{cpuStats.avg}</b>%
                </span>
                <span>
                  max: <b>{cpuStats.max}</b>%
                </span>
              </div>
            </div>
            <div
              className="chart-hw-name"
              title={systemData.cpu_name || undefined}
              style={!systemData.cpu_name ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
            >
              {systemData.cpu_name || '—'}
            </div>
            <div className="chart-canvas-wrap">
              <canvas ref={dashCpuCanvas} aria-label="CPU usage history" />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title">
              <span>RAM History</span>
              <div className="chart-stat">
                <span>
                  min: <b>{ramStats.min}</b>%
                </span>
                <span>
                  avg: <b>{ramStats.avg}</b>%
                </span>
                <span>
                  max: <b>{ramStats.max}</b>%
                </span>
              </div>
            </div>
            <div
              className="chart-hw-name"
              title={systemData.ram_hardware || undefined}
              style={!systemData.ram_hardware ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
            >
              {systemData.ram_hardware || '—'}
            </div>
            <div className="chart-canvas-wrap">
              <canvas ref={dashRamCanvas} aria-label="RAM usage history" />
            </div>
          </div>
          <div className="chart-card">
            <div className="chart-title">
              <span>GPU History</span>
              <div className="chart-stat">
                <span>
                  min: <b>{gpuStats.min}</b>%
                </span>
                <span>
                  avg: <b>{gpuStats.avg}</b>%
                </span>
                <span>
                  max: <b>{gpuStats.max}</b>%
                </span>
              </div>
            </div>
            <div
              className="chart-hw-name"
              title={systemData.gpu_name || undefined}
              style={!systemData.gpu_name ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
            >
              {systemData.gpu_name || '—'}
            </div>
            <div className="chart-canvas-wrap">
              <canvas ref={dashGpuCanvas} aria-label="GPU usage history" />
            </div>
          </div>
        </div>

        <div className="toolbar">
          <input
            className="search-box"
            type="search"
            placeholder="Search processes..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {['all', 'highcpu', 'running', 'user'].map((f) => (
            <button
              key={f}
              type="button"
              className={clsx('filter-chip', activeFilter === f && 'active')}
              onClick={() => setActiveFilter(f)}
            >
              {f === 'all' && 'All'}
              {f === 'highcpu' && 'High CPU (>50%)'}
              {f === 'running' && 'Running'}
              {f === 'user' && 'User'}
            </button>
          ))}
          <span className="sort-label">Sort:</span>
          <select className="sort-select" value={sortSelectValue} onChange={onSortSelect}>
            <option value="cpu-desc">CPU ▼</option>
            <option value="cpu-asc">CPU ▲</option>
            <option value="ram-desc">RAM ▼</option>
            <option value="ram-asc">RAM ▲</option>
            <option value="name-asc">Name A-Z</option>
            <option value="name-desc">Name Z-A</option>
            <option value="pid-asc">PID ▲</option>
            <option value="pid-desc">PID ▼</option>
          </select>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th id="col-pid" className={thSorted('pid')} onClick={() => headerSort('pid')}>
                  <span>PID</span>
                  <span className="sort-arrow">{sortArrow('pid')}</span>
                </th>
                <th id="col-name" className={thSorted('name')} onClick={() => headerSort('name')}>
                  <span>Process Name</span>
                  <span className="sort-arrow">{sortArrow('name')}</span>
                </th>
                <th id="col-cpu" className={thSorted('cpu')} onClick={() => headerSort('cpu')}>
                  <span>CPU %</span>
                  <span className="sort-arrow">{sortArrow('cpu')}</span>
                </th>
                <th id="col-ram" className={thSorted('ram')} onClick={() => headerSort('ram')}>
                  <span>RAM %</span>
                  <span className="sort-arrow">{sortArrow('ram')}</span>
                </th>
                <th id="col-status">
                  <span>Status</span>
                </th>
                <th id="col-user">
                  <span>User</span>
                </th>
                <th id="col-actions" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="empty-state">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
                      <div className="loading-skeleton" style={{ width: '80%' }} />
                      <div className="loading-skeleton" style={{ width: '65%' }} />
                      <div className="loading-skeleton" style={{ width: '75%' }} />
                    </div>
                  </td>
                </tr>
              ) : filteredSorted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-state">
                    No processes match your filter
                  </td>
                </tr>
              ) : (
                filteredSorted.map((p, i) => (
                  <tr
                    key={p.pid}
                    className={clsx(i % 2 === 0 && 'even')}
                    onClick={() => openProcessModal(p)}
                  >
                    <td className="pid-cell">{p.pid}</td>
                    <td className="name-cell">{p.name}</td>
                    <td>
                      <div className="cpu-bar-wrap">
                        <div className="cpu-bar">
                          <div
                            className="cpu-fill"
                            style={{
                              width: `${Math.min(100, p.cpu_percent || 0)}%`,
                              background: cpuColor(p.cpu_percent || 0),
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            minWidth: 36,
                            textAlign: 'right',
                            color: cpuColor(p.cpu_percent || 0),
                          }}
                        >
                          {Number(p.cpu_percent ?? 0).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="ram-cell" style={{ color: cpuColor((p.memory_percent || 0) * 5) }}>
                      {Number(p.memory_percent ?? 0).toFixed(1)}%
                    </td>
                    <td>
                      <span className={clsx('status-badge', statusBadgeClass(p.status))}>
                        {statusLabel(p.status)}
                      </span>
                    </td>
                    <td style={{ color: 'var(--c-muted)' }}>{p.username}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={killBusyPid != null}
                        onClick={(e) => {
                          e.stopPropagation();
                          killProcess(p);
                        }}
                      >
                        {killBusyPid === p.pid ? 'Killing…' : 'Kill'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--c-muted)',
            marginTop: 8,
            textAlign: 'right',
          }}
        >
          Showing {filteredSorted.length} of {processes.length} processes
        </div>
      </div>

      <div id="page-history" className={clsx('page', activeTab === 'history' && 'active')}>
        <div className="history-controls">
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>Range:</span>
          <input
            type="date"
            className="date-input"
            value={histFrom}
            onChange={(e) => setHistFrom(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>to</span>
          <input
            type="date"
            className="date-input"
            value={histTo}
            onChange={(e) => setHistTo(e.target.value)}
          />
          <button type="button" className="btn btn-sm" onClick={loadHistory}>
            Apply
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setHistRangeHours(1)}>
            1H
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setHistRangeHours(24)}>
            24H
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setHistRangeHours(168)}>
            7D
          </button>
        </div>
        {activeTab === 'history' && (
          <div className="charts-row" style={{ marginBottom: 20 }} ref={histChartsRowRef}>
            <div className="chart-card">
              <div className="chart-title">
                <span>CPU History (long-term)</span>
              </div>
              <div
                className="chart-hw-name"
                title={systemData.cpu_name || undefined}
                style={!systemData.cpu_name ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
              >
                {systemData.cpu_name || '—'}
              </div>
              <div className="chart-canvas-wrap-tall">
                <canvas ref={histCpuCanvas} aria-label="Long-term CPU usage" />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <span>RAM History (long-term)</span>
              </div>
              <div
                className="chart-hw-name"
                title={systemData.ram_hardware || undefined}
                style={!systemData.ram_hardware ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
              >
                {systemData.ram_hardware || '—'}
              </div>
              <div className="chart-canvas-wrap-tall">
                <canvas ref={histRamCanvas} aria-label="Long-term RAM usage" />
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <span>GPU History (long-term)</span>
              </div>
              <div
                className="chart-hw-name"
                title={systemData.gpu_name || undefined}
                style={!systemData.gpu_name ? { color: 'var(--c-muted)', opacity: 1 } : undefined}
              >
                {systemData.gpu_name || '—'}
              </div>
              <div className="chart-canvas-wrap-tall">
                <canvas ref={histGpuCanvas} aria-label="Long-term GPU usage" />
              </div>
            </div>
          </div>
        )}
        <div
          style={{
            background: 'var(--c-surface)',
            border: '1px solid var(--c-border)',
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--c-muted)',
              marginBottom: 12,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Process Manager — saved metrics (database)
          </div>
          {!histPoints.length ? (
            <div style={{ fontSize: 12, color: 'var(--c-muted)', textAlign: 'center', padding: 20 }}>
              No saved metric history yet. Process Manager records a sample about every 5 seconds while this
              dashboard is open and the Process Manager API is polled.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: 11,
                      color: 'var(--c-muted)',
                      borderBottom: '1px solid var(--c-border)',
                    }}
                  >
                    Time
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '6px 10px',
                      fontSize: 11,
                      color: 'var(--c-muted)',
                      borderBottom: '1px solid var(--c-border)',
                    }}
                  >
                    CPU
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '6px 10px',
                      fontSize: 11,
                      color: 'var(--c-muted)',
                      borderBottom: '1px solid var(--c-border)',
                    }}
                  >
                    RAM
                  </th>
                  <th
                    style={{
                      textAlign: 'right',
                      padding: '6px 10px',
                      fontSize: 11,
                      color: 'var(--c-muted)',
                      borderBottom: '1px solid var(--c-border)',
                    }}
                  >
                    GPU
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...histPoints].slice(-20).reverse().map((d) => (
                  <tr key={d.timestamp}>
                    <td style={{ padding: '6px 10px', fontSize: 12, color: 'var(--c-muted)' }}>
                      {d.timestamp}
                    </td>
                    <td
                      style={{
                        padding: '6px 10px',
                        fontSize: 12,
                        textAlign: 'right',
                        color: cpuColor(d.cpu),
                      }}
                    >
                      {Number(d.cpu).toFixed(1)}%
                    </td>
                    <td
                      style={{
                        padding: '6px 10px',
                        fontSize: 12,
                        textAlign: 'right',
                        color: 'var(--c-purple)',
                      }}
                    >
                      {Number(d.memory).toFixed(1)}%
                    </td>
                    <td
                      style={{
                        padding: '6px 10px',
                        fontSize: 12,
                        textAlign: 'right',
                        color: d.gpu != null && d.gpu !== '' ? '#f0883e' : 'var(--c-muted)',
                      }}
                    >
                      {d.gpu != null && d.gpu !== '' ? `${Number(d.gpu).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="export-row">
          <button type="button" className="btn" onClick={exportCSV}>
            ↓ Export process list (CSV)
          </button>
          <button type="button" className="btn" onClick={exportJSON}>
            ↓ Export process list (JSON)
          </button>
          <button type="button" className="btn" onClick={exportHistCSV}>
            ↓ Export metric history (CSV)
          </button>
        </div>
      </div>

      <div id="page-settings" className={clsx('page', activeTab === 'settings' && 'active')}>
        <div className="settings-section">
          <div className="settings-title">Refresh &amp; Performance</div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Refresh Rate</div>
              <div className="setting-desc">How often to poll process data</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                className="range-input"
                min={1}
                max={10}
                step={1}
                value={settings.refreshSec}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, refreshSec: Number(e.target.value) }))
                }
              />
              <span style={{ fontSize: 12, color: 'var(--c-accent)', minWidth: 30 }}>
                {settings.refreshSec}s
              </span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Max Processes Shown</div>
              <div className="setting-desc">Limit table rows for performance</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                className="range-input"
                min={10}
                max={200}
                step={10}
                value={settings.maxProcs}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, maxProcs: Number(e.target.value) }))
                }
              />
              <span style={{ fontSize: 12, color: 'var(--c-accent)', minWidth: 30 }}>
                {settings.maxProcs}
              </span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">History Retention</div>
              <div className="setting-desc">Server deletes DB records older than N days (on each snapshot)</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                className="range-input"
                min={1}
                max={30}
                step={1}
                value={settings.retentionDays}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, retentionDays: Number(e.target.value) }))
                }
              />
              <span style={{ fontSize: 12, color: 'var(--c-accent)', minWidth: 30 }}>
                {settings.retentionDays}d
              </span>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-title">Kill Options</div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Force Kill</div>
              <div className="setting-desc">Use hard kill instead of graceful terminate</div>
            </div>
            <button
              type="button"
              className={clsx('toggle', settings.forceKill && 'on')}
              aria-pressed={settings.forceKill}
              onClick={() => setSettings((s) => ({ ...s, forceKill: !s.forceKill }))}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Kill Process Tree</div>
              <div className="setting-desc">Also terminate child processes (when killing from modal)</div>
            </div>
            <button
              type="button"
              className={clsx('toggle', settings.killTree && 'on')}
              aria-pressed={settings.killTree}
              onClick={() => setSettings((s) => ({ ...s, killTree: !s.killTree }))}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Confirm Before Kill</div>
              <div className="setting-desc">Show confirmation dialog</div>
            </div>
            <button
              type="button"
              className={clsx('toggle', settings.confirmKill && 'on')}
              aria-pressed={settings.confirmKill}
              onClick={() => setSettings((s) => ({ ...s, confirmKill: !s.confirmKill }))}
            />
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-title">Process Manager API (FastAPI)</div>
          <div className="setting-row">
            <div>
              <div className="setting-label">API endpoint</div>
              <div className="setting-desc">Base URL for the Process Manager API server</div>
            </div>
            <input
              className="search-box"
              style={{ width: 200 }}
              value={settings.apiBase}
              onChange={(e) => setSettings((s) => ({ ...s, apiBase: e.target.value.trim() }))}
              placeholder="http://127.0.0.1:8000"
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">WebSocket Mode</div>
              <div className="setting-desc">Not implemented — app uses HTTP polling</div>
            </div>
            <button
              type="button"
              className="toggle"
              aria-pressed={false}
              title="Not available"
              onClick={() => toast('WebSocket mode is not available in this build')}
            />
          </div>
        </div>
        <button type="button" className="btn" style={{ marginTop: 4 }} onClick={saveSettings}>
          Save Settings
        </button>
      </div>

      {modalProc && (
        <div
          className="modal-bg"
          role="dialog"
          aria-modal
          aria-labelledby="modal-title"
          onClick={(e) => e.target === e.currentTarget && closeModal()}
        >
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title" id="modal-title">
                {modalProc.name} (PID {modalProc.pid})
              </span>
              <button type="button" className="modal-close" onClick={closeModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="detail-grid">
                <div className="detail-row">
                  <div className="detail-key">PID</div>
                  <div className="detail-val">{modalProc.pid}</div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">Parent PID</div>
                  <div className="detail-val">{modalProc.ppid}</div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">CPU Usage</div>
                  <div className="detail-val" style={{ color: cpuColor(modalProc.cpu_percent) }}>
                    {Number(modalProc.cpu_percent ?? 0).toFixed(1)}%
                  </div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">Memory</div>
                  <div className="detail-val" style={{ color: 'var(--c-purple)' }}>
                    {Number(modalProc.memory_percent ?? 0).toFixed(1)}% (
                    {modalProc.memory_rss_mb != null ? `${modalProc.memory_rss_mb} MB RSS` : '—'})
                  </div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">Status</div>
                  <div className="detail-val">{statusLabel(modalProc.status)}</div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">Threads</div>
                  <div className="detail-val">{modalProc.num_threads}</div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">User</div>
                  <div className="detail-val">{modalProc.username}</div>
                </div>
                <div className="detail-row">
                  <div className="detail-key">Started</div>
                  <div className="detail-val">{modalProc.started || '—'}</div>
                </div>
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontSize: 11,
                  color: 'var(--c-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  marginBottom: 6,
                }}
              >
                Command Line
              </div>
              <div className="cmdline-box">
                {modalDetailLoading ? 'Loading command line…' : modalProc.cmdline || '—'}
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={killBusyPid != null}
                  onClick={() => killProcess(modalProc, false)}
                >
                  {killBusyPid === modalProc.pid ? 'Killing…' : '■ Kill Process'}
                </button>
                {settings.killTree && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={killBusyPid != null}
                    onClick={() => killProcess(modalProc, true)}
                  >
                    {killBusyPid === modalProc.pid ? 'Killing…' : 'Kill Tree'}
                  </button>
                )}
                <button type="button" className="btn" onClick={closeModal}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
