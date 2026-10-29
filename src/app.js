'use strict';
/* SysMonitor arayüzü */
const api = window.sysmon;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  page: 'overview',
  info: null,
  latest: null,
  history: [],
  hw: null,
  range: 60,
  procs: null,
  procSort: 'cpu',
  procQuery: '',
  procTimer: null,
  scan: null,
  selected: new Set(['userTemp', 'winTemp', 'crash', 'thumbs']),
  busy: false,
  store: null
};

const PAGES = {
  overview: { eyebrow: 'SİSTEM MERKEZİ', title: 'Genel Bakış', sub: 'Bilgisayarının durumunu tek yerden takip et.' },
  hardware: { eyebrow: 'CİHAZ', title: 'Donanım', sub: 'Bilgisayarının içinde neler olduğunu gör.' },
  performance: { eyebrow: 'CANLI', title: 'Performans', sub: 'Kaynakları en çok kullanan uygulamaları bul.' },
  activity: { eyebrow: 'GEÇMİŞ', title: 'Aktiviteler', sub: 'Uyarılar, temizlikler ve önemli olaylar.' },
  maintenance: { eyebrow: 'BAKIM', title: 'Temizlik', sub: 'Gereksiz dosyalardan kurtul, disk alanı kazan.' },
  tools: { eyebrow: 'BAKIM', title: 'Araçlar', sub: 'Windows\'un bakım ve onarım araçları tek tıkta.' },
  startup: { eyebrow: 'BAKIM', title: 'Başlangıç', sub: 'Bilgisayar açılırken çalışan uygulamalar.' },
  settings: { eyebrow: 'TERCİHLER', title: 'Ayarlar', sub: 'SysMonitor\'u kendine göre ayarla.' }
};

// ---------------- yardımcılar ----------------
function bytes(b, d = 1) {
  if (b == null || isNaN(b)) return '–';
  if (b < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : (v >= 100 ? 0 : d)).replace('.', ',')} ${u[i]}`;
}
function gb(b) { return (b / 1073741824).toFixed(1).replace('.', ','); }
function pct(v) { return v == null ? '–' : Math.round(v); }
function level(v) { return v == null ? 'Bilinmiyor' : v >= 85 ? 'Yoğun' : v >= 60 ? 'Orta' : 'Normal'; }
function ago(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.floor(s / 60)} dk. önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa. önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}
function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d} gün ${h} sa.` : h ? `${h} sa. ${m} dk.` : `${m} dk.`;
}
function speed(bps) {
  if (bps >= 1048576) return [(bps / 1048576).toFixed(1).replace('.', ','), 'MB/s'];
  return [Math.round(bps / 1024), 'KB/s'];
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function bind(key, value) { $$(`[data-bind="${key}"]`).forEach(el => { el.textContent = value; }); }
function bar(key, v) { $$(`[data-bar="${key}"]`).forEach(el => { el.style.width = `${Math.max(0, Math.min(100, v || 0))}%`; }); }

// ---------------- gezinme ----------------
function go(page) {
  if (!PAGES[page]) return;
  state.page = page;
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  const p = PAGES[page];
  $('#page-eyebrow').textContent = p.eyebrow;
  $('#page-title').textContent = p.title;
  $('#page-subtitle').textContent = p.sub;
  window.scrollTo(0, 0);

  clearInterval(state.procTimer);
  if (page === 'performance') {
    renderSparks();
    loadProcesses();
    state.procTimer = setInterval(loadProcesses, 4000);
  }
  if (page === 'hardware') renderHardware();
  if (page === 'overview') renderChart();
  if (page === 'startup') loadStartup();
  if (page === 'activity') renderActivities();
}

document.addEventListener('click', e => {
  const nav = e.target.closest('[data-page]');
  if (nav) { e.preventDefault(); go(nav.dataset.page); return; }
  const g = e.target.closest('[data-goto]');
  if (g) { go(g.dataset.goto); return; }
  const tool = e.target.closest('[data-tool]');
  if (tool) runTool(tool.dataset.tool);
});

// ---------------- canlı veriler ----------------
function onStats(s) {
  if (!s) return;
  state.latest = s;
  state.history.push({ t: s.t, cpu: s.cpu, ram: s.mem.pct, gpu: s.gpu });
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();

  bind('cpu', pct(s.cpu)); bar('cpu', s.cpu); bind('cpu-state', level(s.cpu));
  bind('ram', pct(s.mem.pct)); bar('ram', s.mem.pct); bind('ram-detail', `${gb(s.mem.used)} / ${gb(s.mem.total)} GB`);
  bind('gpu', s.gpu == null ? '–' : pct(s.gpu)); bar('gpu', s.gpu || 0);
  bind('gpu-state', s.gpu == null ? 'Okunamadı' : level(s.gpu));
  const [rx, rxu] = speed(s.net.rx); const [tx, txu] = speed(s.net.tx);
  bind('rx', rx); bind('rx-unit', rxu); bind('tx', tx); bind('tx-unit', txu);

  renderStatus();
  if (state.page === 'overview') renderChart();
  if (state.page === 'performance') renderSparks();
  if (state.hw && state.page === 'overview') renderHwSummary();
}

function renderStatus() {
  const s = state.latest;
  if (!s) return;
  const st = (state.store && state.store.settings) || { cpuAlert: 90, ramAlert: 90, diskAlert: 10 };
  const issues = [];
  if (s.cpu >= st.cpuAlert) issues.push(`işlemci %${pct(s.cpu)} yükte`);
  if (s.mem.pct >= st.ramAlert) issues.push(`bellek %${pct(s.mem.pct)} dolu`);
  const low = s.disks.filter(d => 100 - d.use < st.diskAlert);
  if (low.length) issues.push(`${low.map(d => d.mount).join(', ')} sürücüsünde yer azaldı`);
  const temp = state.hw && state.hw.cpu.temp;
  if (temp && temp >= 90) issues.push(`işlemci ${Math.round(temp)}°C`);

  const banner = $('#status-banner');
  banner.classList.toggle('warn', issues.length > 0);
  if (issues.length) {
    $('#status-icon').textContent = '!';
    $('#status-title').textContent = 'Dikkat edilmesi gereken durumlar var';
    $('#status-text').textContent = issues.map(x => x[0].toUpperCase() + x.slice(1)).join(' · ') + '.';
    $('#status-badge').textContent = 'DİKKAT';
  } else {
    $('#status-icon').textContent = '✓';
    $('#status-title').textContent = 'Sistemin sağlıklı görünüyor';
    const last = state.store && state.store.lastClean;
    $('#status-text').textContent = `Açık kalma süresi ${uptime(s.uptime)}. ${last ? `Son temizlik ${ago(last)}.` : 'Henüz temizlik yapılmadı; Temizlik sayfasından yer açabilirsin.'}`;
    $('#status-badge').textContent = 'İYİ';
  }
}

// ---------------- grafik ----------------
function seriesFor(minutes) {
  const now = Date.now();
  const span = minutes * 60000;
  const pts = state.history.filter(p => now - p.t <= span);
  // en fazla ~120 nokta: aralık içinde ortalama al
  const buckets = 120;
  const size = span / buckets;
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const a = now - span + i * size, b = a + size;
    const inB = pts.filter(p => p.t >= a && p.t < b);
    if (!inB.length) continue;
    const avg = k => { const v = inB.map(p => p[k]).filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    out.push({ t: (a + b) / 2, cpu: avg('cpu'), ram: avg('ram'), gpu: avg('gpu') });
  }
  return { out, now, span };
}

function renderChart() {
  const { out, now, span } = seriesFor(state.range);
  $('#chart-empty').style.display = out.length < 2 ? 'grid' : 'none';
  const X = t => ((t - (now - span)) / span) * 500;
  const Y = v => 160 - (v / 100) * 150;
  const line = k => out.filter(p => p[k] != null).map(p => `${X(p.t).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
  $('#line-cpu').setAttribute('points', line('cpu'));
  $('#line-ram').setAttribute('points', line('ram'));
  $('#line-gpu').setAttribute('points', line('gpu'));
  if (out.length > 1) {
    const first = X(out[0].t), last = X(out[out.length - 1].t);
    $('#chart-area').setAttribute('d', `M${first} 165 L${out.map(p => `${X(p.t).toFixed(1)} ${Y(p.cpu).toFixed(1)}`).join(' L')} L${last} 165 Z`);
  } else $('#chart-area').setAttribute('d', '');
  state.chartData = { out, now, span, X };
  const r = state.range;
  const labels = r === 60 ? ['60 dk. önce', '45 dk.', '30 dk.', '15 dk.', 'Şimdi'] : r === 15 ? ['15 dk. önce', '11 dk.', '7 dk.', '4 dk.', 'Şimdi'] : ['5 dk. önce', '4 dk.', '2,5 dk.', '1 dk.', 'Şimdi'];
  $('#chart-labels').innerHTML = labels.map(l => `<span>${l}</span>`).join('');
}

$('#range-pills').addEventListener('click', e => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.range = +b.dataset.range;
  $$('#range-pills .pill').forEach(x => x.classList.toggle('active', x === b));
  renderChart();
});

$('#chart').addEventListener('mousemove', e => {
  const d = state.chartData;
  if (!d || d.out.length < 2) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 500;
  let best = d.out[0];
  for (const p of d.out) if (Math.abs(d.X(p.t) - x) < Math.abs(d.X(best.t) - x)) best = p;
  const cx = d.X(best.t);
  const cur = $('#chart-cursor');
  cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.style.display = 'block';
  const tip = $('#chart-tip');
  const time = new Date(best.t).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  tip.innerHTML = `<b>${time}</b><br><i style="background:#9870ff"></i>CPU %${pct(best.cpu)}<br><i style="background:#42caff"></i>RAM %${pct(best.ram)}${best.gpu != null ? `<br><i style="background:#4de0ad"></i>GPU %${pct(best.gpu)}` : ''}`;
  tip.style.display = 'block';
  const px = (cx / 500) * rect.width;
  tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, px + 12))}px`;
});
$('#chart').addEventListener('mouseleave', () => { $('#chart-cursor').style.display = 'none'; $('#chart-tip').style.display = 'none'; });

function renderSparks() {
  const pts = state.history.slice(-60);
  ['cpu', 'ram', 'gpu'].forEach(k => {
    const el = $(`[data-spark="${k}"]`);
    const v = pts.filter(p => p[k] != null);
    el.setAttribute('points', v.map((p, i) => `${((i / Math.max(1, v.length - 1)) * 120).toFixed(1)},${(32 - (p[k] / 100) * 30).toFixed(1)}`).join(' '));
  });
}

// ---------------- donanım ----------------
function renderHwSummary() {
  const hw = state.hw, s = state.latest;
  const rows = $$('#hw-summary .hardware-row');
  const set = (row, small, value) => {
    const sm = $('small', row); sm.textContent = small; sm.classList.remove('skeleton');
    $('.hardware-value', row).textContent = value;
  };
  set(rows[0], hw.cpu.brand, `${hw.cpu.cores || hw.cpu.threads} çekirdek`);
  const mods = hw.mem.modules;
  set(rows[1], mods.length ? `${mods.length} modül · ${[mods[0].type, mods[0].clock ? mods[0].clock + ' MHz' : ''].filter(Boolean).join(' ')}` : 'Sistem belleği', `${Math.round(hw.mem.total / 1073741824)} GB`);
  const g = hw.gpus[0];
  set(rows[2], g ? g.model : 'Ekran kartı bulunamadı', g && g.vram ? `${g.vram >= 1024 ? Math.round(g.vram / 1024) + ' GB' : g.vram + ' MB'}` : 'GPU');
  const disks = s ? s.disks : [];
  const total = disks.reduce((a, d) => a + d.size, 0), used = disks.reduce((a, d) => a + d.used, 0);
  const types = [...new Set(hw.disks.map(d => d.type).filter(Boolean))].join(' + ');
  set(rows[3], disks.length ? `${disks.length} sürücü · ${bytes(total - used)} boş` : 'Disk bilgisi', types || bytes(total));
}

function renderHardware() {
  const hw = state.hw;
  if (!hw) return;
  const s = state.latest || { disks: [] };
  const kv = pairs => `<dl class="kv">${pairs.filter(p => p[1] != null && p[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  const card = (icon, cls, title, body, wide) => `<section class="panel hw-card ${wide ? 'hw-wide' : ''}"><h3><span class="stat-icon ${cls}">${icon}</span>${title}</h3>${body}</section>`;
  const html = [];
  html.push(card('◉', 'purple-ic', 'İşlemci', kv([
    ['Model', hw.cpu.brand], ['Fiziksel çekirdek', hw.cpu.cores], ['Mantıksal işlemci', hw.cpu.threads],
    ['En yüksek hız', hw.cpu.speed ? `${String(hw.cpu.speed).replace('.', ',')} GHz` : null],
    ['Sıcaklık', hw.cpu.temp ? `${Math.round(hw.cpu.temp)}°C` : 'Sensör okunamadı']
  ])));
  html.push(card('▤', 'blue-ic', 'Bellek', kv([
    ['Toplam', `${gb(hw.mem.total)} GB`],
    ['Kullanımda', state.latest ? `${gb(state.latest.mem.used)} GB (%${pct(state.latest.mem.pct)})` : null],
    ...hw.mem.modules.map((m, i) => [`Modül ${i + 1}`, [bytes(m.size, 0), m.type, m.clock ? `${m.clock} MHz` : '', m.maker].filter(Boolean).join(' · ')])
  ])));
  html.push(card('◈', 'green-ic', 'Ekran kartı', hw.gpus.length ? hw.gpus.map(g => kv([
    ['Model', g.model], ['Üretici', g.vendor], ['Bellek', g.vram ? (g.vram >= 1024 ? `${(g.vram / 1024).toFixed(0)} GB` : `${g.vram} MB`) : null]
  ])).join('<div style="height:14px"></div>') : '<p class="empty">Ekran kartı bilgisi okunamadı.</p>'));
  html.push(card('⌂', 'purple-ic', 'Sistem', kv([
    ['İşletim sistemi', hw.os.name], ['Sürüm', hw.os.build], ['Mimari', hw.os.arch], ['Bilgisayar adı', hw.os.host],
    ['Üretici', [hw.system.maker, hw.system.model].filter(Boolean).join(' ')],
    ['Anakart', [hw.board.maker, hw.board.model].filter(Boolean).join(' ')],
    ['Açık kalma', state.latest ? uptime(state.latest.uptime) : null],
    ['Pil', hw.battery ? `%${hw.battery.percent}${hw.battery.charging ? ' · şarj oluyor' : ''}` : null]
  ])));
  const disksHtml = s.disks.map(d => `
    <div class="disk">
      <div class="disk-head"><strong>${esc(d.mount)} <small>${esc(d.type || '')}</small></strong><small>${bytes(d.size - d.used)} boş · toplam ${bytes(d.size)}</small></div>
      <div class="progress"><div class="progress-fill ${d.use > 90 ? 'red-fill' : d.use > 75 ? 'amber-fill' : 'blue-fill'}" style="width:${d.use}%"></div></div>
    </div>`).join('');
  const physical = hw.disks.length ? kv(hw.disks.map(d => [d.name || 'Disk', [d.type, bytes(d.size, 0), d.iface, d.smart && d.smart !== 'unknown' ? `SMART: ${d.smart === 'Ok' ? 'Sağlıklı' : d.smart}` : ''].filter(Boolean).join(' · ')])) : '';
  html.push(card('▰', 'blue-ic', 'Depolama', (disksHtml || '<p class="empty">Sürücü bulunamadı.</p>') + (physical ? `<div style="height:14px"></div>${physical}` : ''), true));
  if (hw.net.length) html.push(card('⇅', 'green-ic', 'Ağ bağdaştırıcıları', kv(hw.net.map(n => [n.name, [n.ip, n.type === 'wireless' ? 'Kablosuz' : n.type === 'wired' ? 'Kablolu' : n.type, n.speed ? `${n.speed} Mbit/s` : ''].filter(Boolean).join(' · ')])), true));
  $('#hw-detail').innerHTML = html.join('');
}

// ---------------- işlemler ----------------
const COLORS = ['#9870ff', '#42caff', '#4de0ad', '#ffb547', '#ff6fae', '#7aa2ff'];
async function loadProcesses() {
  const r = await api.processes();
  state.procs = r;
  renderProcesses();
}
function renderProcesses() {
  const r = state.procs;
  if (!r) return;
  const q = state.procQuery.toLowerCase();
  let list = r.list.filter(p => !q || p.name.toLowerCase().includes(q));
  list.sort((a, b) => state.procSort === 'cpu' ? b.cpu - a.cpu || b.mem - a.mem : b.mem - a.mem);
  list = list.slice(0, 40);
  $('#proc-summary').textContent = `${r.list.length} uygulama · ${r.total} işlem çalışıyor`;
  const cores = (state.hw && state.hw.cpu.threads) || 1;
  $('#proc-table').innerHTML = `<div class="trow head"><span>UYGULAMA</span><span>CPU</span><span>BELLEK</span><span></span></div>` + list.map(p => {
    const color = COLORS[p.name.length % COLORS.length];
    const cpu = Math.min(100, p.cpu);
    return `<div class="trow">
      <div class="name"><span class="app-dot" style="background:${color}22;color:${color}">${esc(p.name[0] || '?').toUpperCase()}</span><b title="${esc(p.name)}">${esc(p.name)}</b>${p.count > 1 ? `<small>×${p.count}</small>` : ''}</div>
      <span>%${cpu.toFixed(1).replace('.', ',')}</span>
      <div class="bar-cell"><div class="progress"><div class="progress-fill blue-fill" style="width:${Math.min(100, p.memPct * 4)}%"></div></div><span>${bytes(p.mem)}</span></div>
      <button class="kill" data-kill="${esc(p.name)}">Sonlandır</button>
    </div>`;
  }).join('');
  void cores;
}
$('#proc-search').addEventListener('input', e => { state.procQuery = e.target.value; renderProcesses(); });
$('#proc-sort').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  state.procSort = b.dataset.sort;
  $$('#proc-sort .pill').forEach(x => x.classList.toggle('active', x === b));
  renderProcesses();
});
$('#proc-table').addEventListener('click', async e => {
  const b = e.target.closest('[data-kill]');
  if (!b) return;
  const item = state.procs.list.find(p => p.name === b.dataset.kill);
  if (!item) return;
  const r = await api.killProcess({ name: item.name, pids: item.pids });
  if (r.cancelled) return;
  toast(r.ok ? `${item.name} kapatıldı` : `${item.name} kapatılamadı (yönetici izni gerekebilir)`);
  loadProcesses();
});

// ---------------- başlangıç ----------------
async function loadStartup() {
  const list = await api.startup();
  if (!list.length) {
    $('#startup-table').innerHTML = `<p class="empty">${state.info && state.info.isWin ? 'Başlangıçta açılan uygulama bulunamadı.' : 'Bu bölüm Windows\'ta çalışır.'}</p>`;
    return;
  }
  const loc = l => /Startup/i.test(l) ? 'Başlangıç klasörü' : /HKLM|HKU\\.DEFAULT/i.test(l) ? 'Tüm kullanıcılar' : /HKU|HKCU/i.test(l) ? 'Bu kullanıcı' : l;
  $('#startup-table').innerHTML = `<div class="trow head startup-row"><span>UYGULAMA</span><span>KOMUT</span><span>KONUM</span></div>` + list.map(x => `
    <div class="trow startup-row">
      <div class="name"><span class="app-dot" style="background:#9870ff22;color:#9870ff">${esc((x.name[0] || '?').toUpperCase())}</span><b>${esc(x.name)}</b></div>
      <code title="${esc(x.command)}">${esc(x.command)}</code>
      <span style="color:var(--muted)">${esc(loc(x.location))}</span>
    </div>`).join('');
}

// ---------------- aktiviteler ----------------
const DOT = { success: '#4de0ad', info: '#9870ff', warn: '#ffb547', blue: '#42caff' };
function activityHtml(a) {
  return `<div class="activity"><i class="activity-dot" style="background:${DOT[a.type] || DOT.info}"></i><div><strong>${esc(a.title)}<time>${ago(a.t)}</time></strong><p>${esc(a.text)}</p></div></div>`;
}
function renderActivities() {
  const list = (state.store && state.store.activities) || [];
  $('#activity-mini').innerHTML = list.slice(0, 4).map(activityHtml).join('') || '<p class="empty">Henüz kayıt yok.</p>';
  $('#activity-full').innerHTML = list.map(activityHtml).join('') || '<p class="empty">Henüz kayıt yok.</p>';
}
$('#clear-activity').addEventListener('click', async () => {
  await api.clearActivities();
  state.store.activities = [];
  renderActivities();
});

// ---------------- temizlik ----------------
function renderClean(workingId) {
  const scan = state.scan;
  const list = $('#clean-list');
  if (!scan) {
    list.innerHTML = '<p class="empty">Taramayı başlattığında temizlenebilecek alanlar burada listelenir.</p>';
    return;
  }
  list.innerHTML = scan.map(c => `
    <div class="clean-item ${state.selected.has(c.id) ? 'on' : ''} ${workingId === c.id ? 'working' : ''}" data-cat="${c.id}">
      <span class="check">✓</span>
      <div class="hardware-info"><strong>${esc(c.name)}</strong><small>${esc(c.desc)}${c.count ? ` · ${c.count.toLocaleString('tr-TR')} dosya` : ''}</small></div>
      <span class="size">${c.size == null ? '…' : bytes(c.size)}</span>
    </div>`).join('');
  const sel = scan.filter(c => state.selected.has(c.id) && c.size != null).reduce((a, c) => a + c.size, 0);
  const total = scan.reduce((a, c) => a + (c.size || 0), 0);
  if (!state.busy) {
    $('#clean-total').textContent = bytes(sel);
    $('#clean-total-label').textContent = `seçili · toplam ${bytes(total)}`;
    $('#btn-clean').disabled = sel <= 0;
    $('#ring-fg').style.strokeDashoffset = 327 - 327 * Math.min(1, total ? sel / total : 0);
  }
}
$('#clean-list').addEventListener('click', e => {
  const it = e.target.closest('[data-cat]');
  if (!it || state.busy) return;
  const id = it.dataset.cat;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderClean();
});
function setBusy(b, label) {
  state.busy = b;
  $('#clean-ring').classList.toggle('busy', b);
  $('#btn-scan').disabled = b;
  $('#btn-clean').disabled = b || !state.scan;
  if (b) { $('#clean-total').textContent = '…'; $('#clean-total-label').textContent = label; $('#clean-state').textContent = label; }
}
$('#btn-scan').addEventListener('click', async () => {
  setBusy(true, 'Taranıyor…');
  state.scan = null;
  renderClean();
  const r = await api.scan();
  state.scan = r;
  setBusy(false);
  $('#clean-state').textContent = `${r.length} kategori tarandı`;
  renderClean();
});
$('#btn-clean').addEventListener('click', async () => {
  const ids = [...state.selected].filter(id => state.scan && state.scan.some(c => c.id === id && c.size > 0));
  if (!ids.length) return;
  setBusy(true, 'Temizleniyor…');
  const r = await api.clean(ids);
  setBusy(false);
  if (r.cancelled) { renderClean(); $('#clean-state').textContent = 'İptal edildi'; return; }
  toast(`${bytes(r.freed)} boşaltıldı ✓`);
  $('#clean-state').textContent = `${bytes(r.freed)} boşaltıldı`;
  state.store = await api.store();
  updateCleanMeta();
  // yeniden tara ki kalan boyutlar görünsün
  const again = await api.scan();
  state.scan = again;
  renderClean();
  $('#clean-total-label').textContent = `boşaltıldı: ${bytes(r.freed)}`;
});
api.onCleanProgress(id => { if (state.busy && state.scan) renderClean(id); });
function updateCleanMeta() {
  const st = state.store;
  $('#clean-meta').textContent = st && st.lastClean ? `Son temizlik: ${ago(st.lastClean)} · Bugüne kadar toplam ${bytes(st.totalFreed)} boşaltıldı.` : 'Henüz temizlik yapılmadı.';
}

// ---------------- araçlar ----------------
const TOOLS = [
  { id: 'flushdns', icon: '⟳', cls: 'blue-card', name: 'DNS önbelleğini temizle', desc: 'Sitelere bağlanma sorunlarında ilk yapılacak şey.' },
  { id: 'cleanmgr', icon: '✧', cls: 'purple-card', name: 'Disk Temizleme', desc: 'Windows\'un kendi temizleme aracı; sistem dosyalarını da temizleyebilir.' },
  { id: 'sfc', icon: '🛡', cls: 'green-card', name: 'Sistem dosyası denetimi', desc: 'Bozuk Windows dosyalarını bulup onarır (sfc /scannow).', admin: true },
  { id: 'dism', icon: '⚕', cls: 'green-card', name: 'Windows görüntü onarımı', desc: 'SFC onaramazsa Windows bileşenlerini onarır (DISM).', admin: true },
  { id: 'chkdsk', icon: '▰', cls: 'blue-card', name: 'Disk hata taraması', desc: 'C: sürücüsünü yeniden başlatmadan hatalara karşı tarar.', admin: true },
  { id: 'restore', icon: '⟲', cls: 'purple-card', name: 'Geri yükleme noktası', desc: 'Büyük değişikliklerden önce bilgisayarın yedeğini alır.', admin: true },
  { id: 'defrag', icon: '⇶', cls: 'amber-card', name: 'Sürücüleri iyileştir', desc: 'SSD için TRIM, HDD için birleştirme yapar.' },
  { id: 'defender', icon: '⛨', cls: 'green-card', name: 'Virüs taraması', desc: 'Windows Güvenlik ile tehditleri tara.' },
  { id: 'update', icon: '⇪', cls: 'blue-card', name: 'Windows Update', desc: 'Güvenlik güncellemelerini kontrol et.' },
  { id: 'storage', icon: '◔', cls: 'amber-card', name: 'Depolama ayarları', desc: 'Depolama Algılayıcı ile otomatik temizliği aç.' },
  { id: 'power', icon: '⚡', cls: 'pink-card', name: 'Güç seçenekleri', desc: 'Performans ve pil dengesi için güç planını seç.' },
  { id: 'taskmgr', icon: '▦', cls: 'purple-card', name: 'Görev Yöneticisi', desc: 'Windows\'un ayrıntılı işlem ve performans ekranı.' }
];
function renderTools() {
  $('#tools-grid').innerHTML = TOOLS.map(t => `
    <button class="panel tool ${t.cls}" data-tool="${t.id}">
      <span class="stat-icon">${t.icon}</span>
      <strong>${t.name}${t.admin ? ' <small title="Yönetici izni gerekir">🛡</small>' : ''}</strong>
      <p>${t.desc}</p>
      <span class="go">Çalıştır →</span>
    </button>`).join('');
}
async function runTool(id) {
  const r = await api.tool(id);
  toast(r.message || (r.ok ? 'Başlatıldı' : 'Çalıştırılamadı'));
}

// ---------------- ayarlar ----------------
function renderSettings() {
  const s = state.store.settings;
  $$('[data-setting]').forEach(el => {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else {
      el.value = s[k];
      const out = el.parentElement.querySelector('b');
      out.textContent = k === 'interval' ? `${s[k]} sn` : `%${s[k]}`;
    }
  });
}
$$('[data-setting]').forEach(el => {
  const k = el.dataset.setting;
  el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', async () => {
    const v = el.type === 'checkbox' ? el.checked : +el.value;
    if (el.type !== 'checkbox') el.parentElement.querySelector('b').textContent = k === 'interval' ? `${v} sn` : `%${v}`;
    clearTimeout(el._t);
    el._t = setTimeout(async () => {
      state.store.settings = await api.setSettings({ [k]: v });
      renderStatus();
    }, 250);
  });
});

// ---------------- başlangıç ----------------
async function init() {
  const [info, latest, history, store] = await Promise.all([api.info(), api.latest(), api.history(), api.store()]);
  state.info = info; state.store = store; state.history = history.slice();
  $('#pc-name').textContent = info.host;
  $('#sb-version').textContent = `SysMonitor v${info.version}`;
  $('#about-version').textContent = `v${info.version}`;
  renderTools();
  renderSettings();
  renderActivities();
  renderClean();
  updateCleanMeta();
  if (latest) { state.history.pop(); onStats(latest); }
  api.onStats(onStats);
  api.onActivity(a => { state.store.activities.unshift(a); renderActivities(); });
  setInterval(renderActivities, 60000);

  state.hw = await api.hardware();
  $('#pc-os').textContent = state.hw.os.name || 'Yerel cihaz';
  renderHwSummary();
  renderStatus();
  if (state.page === 'hardware') renderHardware();

  const q = new URLSearchParams(location.search).get('page');
  if (q && PAGES[q]) go(q);
}
init();
