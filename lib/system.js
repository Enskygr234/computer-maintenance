'use strict';
// Canlı sistem verileri: CPU, RAM, GPU, disk, ağ, donanım bilgisi ve işlemler.
const os = require('os');
const { spawn, execFile } = require('child_process');
const si = require('systeminformation');

const IS_WIN = process.platform === 'win32';
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
const safe = (p, fallback = null) => p.then(v => v, () => fallback);

// ---------------- CPU ----------------
let prevCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  if (!prevCpu) { prevCpu = { idle, total }; return 0; }
  const di = idle - prevCpu.idle;
  const dt = total - prevCpu.total;
  prevCpu = { idle, total };
  return dt > 0 ? clamp(100 * (1 - di / dt)) : 0;
}

// ---------------- GPU ----------------
// Windows'ta GPU kullanımını dil bağımsız CIM sınıfından okuyan kalıcı bir PowerShell süreci.
let gpuValue = null;
let gpuProc = null;
let gpuFallbackTimer = null;

function powershellEncoded(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function startGpuMonitor() {
  if (IS_WIN) {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $rows = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
  $v = -1
  if ($rows) {
    $v = ($rows | Where-Object { $_.Name -like '*engtype_3D*' } | Measure-Object -Property UtilizationPercentage -Sum).Sum
    if ($v -eq $null) { $v = 0 }
  }
  [Console]::Out.WriteLine([string][math]::Round([double]$v, 1))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1500
}`;
    try {
      gpuProc = spawn('powershell.exe', powershellEncoded(script), { windowsHide: true });
      let buf = '';
      gpuProc.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) {
          const n = parseFloat(l.replace(',', '.'));
          if (!Number.isNaN(n)) gpuValue = n < 0 ? null : clamp(n);
        }
      });
      gpuProc.on('error', () => { gpuProc = null; startGpuFallback(); });
      gpuProc.on('exit', () => { gpuProc = null; });
      return;
    } catch (e) { /* aşağıdaki yedeğe düş */ }
  }
  startGpuFallback();
}

function startGpuFallback() {
  if (gpuFallbackTimer) return;
  const tick = async () => {
    const g = await safe(si.graphics(), null);
    const c = g && g.controllers && g.controllers.find(x => typeof x.utilizationGpu === 'number');
    gpuValue = c ? clamp(c.utilizationGpu) : null;
  };
  tick();
  gpuFallbackTimer = setInterval(tick, 5000);
}

function stopGpuMonitor() {
  if (gpuProc) { try { gpuProc.kill(); } catch (e) {} gpuProc = null; }
  if (gpuFallbackTimer) { clearInterval(gpuFallbackTimer); gpuFallbackTimer = null; }
}

// ---------------- Disk & ağ (önbellekli) ----------------
let diskCache = { t: 0, data: [] };
async function disks() {
  if (Date.now() - diskCache.t < 15000) return diskCache.data;
  const fs = await safe(si.fsSize(), []);
  const seen = new Set();
  const data = (fs || [])
    .filter(d => d.size > 0 && !seen.has(d.mount) && seen.add(d.mount))
    .map(d => ({ mount: d.mount || d.fs, fs: d.fs, type: d.type, size: d.size, used: d.used, use: clamp(d.use || (d.used / d.size) * 100) }));
  diskCache = { t: Date.now(), data };
  return data;
}

let netPrimed = false;
async function network() {
  const stats = await safe(si.networkStats('*'), []);
  if (!netPrimed) { netPrimed = true; return { rx: 0, tx: 0 }; }
  let rx = 0, tx = 0;
  for (const s of stats || []) {
    if (s.rx_sec > 0) rx += s.rx_sec;
    if (s.tx_sec > 0) tx += s.tx_sec;
  }
  return { rx, tx };
}

// ---------------- Anlık özet ----------------
async function snapshot() {
  const total = os.totalmem();
  let free = os.freemem();
  // Linux'ta "available" daha doğru; Windows'ta freemem zaten kullanılabilir belleği verir.
  if (!IS_WIN) {
    const m = await safe(si.mem(), null);
    if (m && m.available) free = m.available;
  }
  const [dsk, net] = await Promise.all([disks(), network()]);
  return {
    t: Date.now(),
    cpu: Math.round(cpuPercent() * 10) / 10,
    mem: { total, used: total - free, pct: clamp(((total - free) / total) * 100) },
    gpu: gpuValue,
    disks: dsk,
    net,
    uptime: os.uptime()
  };
}

// ---------------- Donanım (bir kez okunur) ----------------
let hwCache = null;
async function hardware(force = false) {
  if (hwCache && !force) return hwCache;
  const [cpu, memLayout, graphics, diskLayout, osInfo, system, board, battery, nets, temp] = await Promise.all([
    safe(si.cpu(), {}), safe(si.memLayout(), []), safe(si.graphics(), { controllers: [] }),
    safe(si.diskLayout(), []), safe(si.osInfo(), {}), safe(si.system(), {}), safe(si.baseboard(), {}),
    safe(si.battery(), {}), safe(si.networkInterfaces(), []), safe(si.cpuTemperature(), {})
  ]);
  const gpus = (graphics.controllers || []).filter(g => g.model && !/basic display|microsoft remote/i.test(g.model));
  hwCache = {
    cpu: {
      brand: [cpu.manufacturer, cpu.brand].filter(Boolean).join(' ').trim() || (os.cpus()[0] || {}).model || 'Bilinmiyor',
      cores: cpu.physicalCores || null,
      threads: cpu.cores || os.cpus().length,
      speed: cpu.speedMax || cpu.speed || null,
      temp: typeof temp.main === 'number' && temp.main > 0 ? temp.main : null
    },
    mem: {
      total: os.totalmem(),
      modules: (memLayout || []).filter(m => m.size > 0).map(m => ({ size: m.size, type: m.type, clock: m.clockSpeed, maker: m.manufacturer }))
    },
    gpus: gpus.map(g => ({ model: g.model, vendor: g.vendor, vram: g.vram || null })),
    disks: (diskLayout || []).map(d => ({ name: d.name, type: d.type, size: d.size, iface: d.interfaceType, smart: d.smartStatus })),
    os: {
      name: [osInfo.distro, osInfo.release].filter(Boolean).join(' ') || os.type(),
      build: osInfo.build || '',
      arch: osInfo.arch || os.arch(),
      host: osInfo.hostname || os.hostname()
    },
    system: { maker: system.manufacturer || '', model: system.model || '' },
    board: { maker: board.manufacturer || '', model: board.model || '' },
    battery: battery && battery.hasBattery ? { percent: battery.percent, charging: battery.isCharging } : null,
    net: (nets || []).filter(n => !n.internal && (n.ip4 || n.ip6) && n.operstate !== 'down')
      .map(n => ({ name: n.ifaceName || n.iface, ip: n.ip4 || n.ip6, type: n.type, speed: n.speed }))
  };
  return hwCache;
}

// ---------------- İşlemler ----------------
async function processes() {
  const p = await safe(si.processes(), { list: [] });
  const total = os.totalmem();
  const groups = new Map();
  for (const x of p.list || []) {
    if (!x.name || x.pid === 0 || /^(System Idle Process|Idle)$/i.test(x.name)) continue;
    const key = x.name.toLowerCase();
    const g = groups.get(key) || { name: x.name.replace(/\.exe$/i, ''), pids: [], cpu: 0, mem: 0, count: 0 };
    g.pids.push(x.pid);
    g.cpu += x.cpu || 0;
    g.mem += (x.memRss || 0) * 1024;
    g.count++;
    groups.set(key, g);
  }
  const list = [...groups.values()].map(g => ({ ...g, cpu: Math.round(g.cpu * 10) / 10, memPct: (g.mem / total) * 100 }));
  return { total: (p.list || []).length, list };
}

function killPids(pids) {
  return Promise.all(pids.map(pid => new Promise(resolve => {
    if (IS_WIN) {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, err => resolve(!err));
    } else {
      try { process.kill(pid); resolve(true); } catch (e) { resolve(false); }
    }
  }))).then(r => ({ ok: r.filter(Boolean).length, fail: r.filter(x => !x).length }));
}

// ---------------- Başlangıç uygulamaları ----------------
function startupApps() {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve([]);
    const script = `Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Json -Compress`;
    execFile('powershell.exe', powershellEncoded(script), { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err || !out.trim()) return resolve([]);
      try {
        let v = JSON.parse(out);
        if (!Array.isArray(v)) v = [v];
        resolve(v.filter(x => x && x.Name).map(x => ({ name: x.Name, command: x.Command || '', location: x.Location || '', user: x.User || '' })));
      } catch (e) { resolve([]); }
    });
  });
}

module.exports = { snapshot, hardware, processes, killPids, startupApps, startGpuMonitor, stopGpuMonitor, powershellEncoded, IS_WIN };
