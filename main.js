'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sys = require('./lib/system');
const cleaner = require('./lib/cleaner');
const tools = require('./lib/tools');
const Store = require('./lib/store');

const SHOT = process.env.SYSMON_SHOT || null; // test: ekran görüntüsü alıp çık
const SELFTEST = process.env.SYSMON_SELFTEST || null; // CI: verileri ve sayfaları kaydedip çık
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let store = null;
let quitting = false;
let trayHintShown = false;

// Son 60 dakikanın örnekleri
const history = [];
const HISTORY_MS = 60 * 60 * 1000;
let latest = null;
let sampler = null;

// Uyarı sayaçları
const alertState = { cpuSince: 0, ramSince: 0, lastCpu: 0, lastRam: 0, lastDisk: 0 };

function iconPath(name = 'icon.png') {
  const p = path.join(__dirname, 'build', name);
  return fs.existsSync(p) ? p : undefined;
}

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0f19',
    title: 'SysMonitor',
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1421', symbolColor: '#edf0ff', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: SHOT ? { page: process.env.SYSMON_PAGE || 'overview' } : {} });
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());

  win.on('close', e => {
    if (!quitting && store.settings.minimizeToTray && tray && !SHOT && !SELFTEST) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'SysMonitor arka planda', body: 'Simge tepsisinden tekrar açabilirsin.', icon: iconPath() }).show();
      }
    }
  });

  if (SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SHOT, img.toPNG());
        quitting = true;
        app.quit();
      }, parseInt(process.env.SYSMON_WAIT || '7000', 10));
    });
  }
}

function showWindow() {
  if (!win) createWindow(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const p = iconPath('icon.png');
  if (!p) return;
  const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('SysMonitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SysMonitor\'u aç', click: showWindow },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: iconPath() }).show();
}

function pushActivity(type, title, text) {
  const a = store.log(type, title, text);
  if (win && !win.isDestroyed()) win.webContents.send('activity', a);
}

function checkAlerts(s) {
  const st = store.settings;
  if (!st.alerts) return;
  const now = Date.now();
  // CPU 30 saniye boyunca eşiğin üstündeyse
  if (s.cpu >= st.cpuAlert) {
    alertState.cpuSince = alertState.cpuSince || now;
    if (now - alertState.cpuSince > 30000 && now - alertState.lastCpu > 10 * 60000) {
      alertState.lastCpu = now;
      notify('İşlemci yükü yüksek', `CPU %${Math.round(s.cpu)} seviyesinde. İşlemler sayfasından neyin yorduğuna bakabilirsin.`);
      pushActivity('warn', 'İşlemci yükü yüksek', `CPU 30 saniyedir %${st.cpuAlert} üzerinde (%${Math.round(s.cpu)}).`);
    }
  } else alertState.cpuSince = 0;

  if (s.mem.pct >= st.ramAlert) {
    alertState.ramSince = alertState.ramSince || now;
    if (now - alertState.ramSince > 30000 && now - alertState.lastRam > 10 * 60000) {
      alertState.lastRam = now;
      notify('Bellek dolmak üzere', `RAM %${Math.round(s.mem.pct)} dolu.`);
      pushActivity('warn', 'Bellek dolmak üzere', `RAM kullanımı %${Math.round(s.mem.pct)} seviyesine çıktı.`);
    }
  } else alertState.ramSince = 0;

  if (now - alertState.lastDisk > 60 * 60000) {
    const low = s.disks.filter(d => 100 - d.use < st.diskAlert);
    if (low.length) {
      alertState.lastDisk = now;
      const names = low.map(d => d.mount).join(', ');
      notify('Disk alanı azaldı', `${names} sürücüsünde boş alan %${st.diskAlert} altında.`);
      pushActivity('warn', 'Disk alanı azaldı', `${names} sürücüsünde boş alan %${st.diskAlert} altına indi. Bakım sayfasından temizlik yapabilirsin.`);
    }
  }
}

async function sample() {
  try {
    const s = await sys.snapshot();
    latest = s;
    history.push({ t: s.t, cpu: s.cpu, ram: s.mem.pct, gpu: s.gpu });
    while (history.length && s.t - history[0].t > HISTORY_MS) history.shift();
    checkAlerts(s);
    if (tray) tray.setToolTip(`SysMonitor\nCPU %${Math.round(s.cpu)} · RAM %${Math.round(s.mem.pct)}${s.gpu != null ? ` · GPU %${Math.round(s.gpu)}` : ''}`);
    if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('stats', s);
  } catch (e) { /* bir örnek kaçarsa sorun değil */ }
}

function startSampler() {
  clearInterval(sampler);
  const sec = Math.max(1, Math.min(10, store.settings.interval || 2));
  sampler = setInterval(sample, sec * 1000);
}

function applyLogin() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.startWithWindows, args: ['--hidden'] });
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    host: os.hostname(),
    user: os.userInfo().username,
    isWin: process.platform === 'win32'
  }));
  ipcMain.handle('stats:latest', () => latest);
  ipcMain.handle('stats:history', () => history);
  ipcMain.handle('hw:get', (e, force) => sys.hardware(!!force));
  ipcMain.handle('procs:get', () => sys.processes());
  ipcMain.handle('procs:kill', async (e, item) => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Sonlandır', 'Vazgeç'], defaultId: 1, cancelId: 1,
      title: 'İşlemi sonlandır', message: `${item.name} kapatılsın mı?`,
      detail: 'Kaydedilmemiş veriler kaybolabilir. Sistem işlemlerini kapatmak Windows\'u kararsız hale getirebilir.'
    });
    if (r.response !== 0) return { cancelled: true };
    const res = await sys.killPids(item.pids || []);
    pushActivity(res.ok ? 'info' : 'warn', res.ok ? 'İşlem sonlandırıldı' : 'İşlem sonlandırılamadı',
      res.ok ? `${item.name} kapatıldı.` : `${item.name} kapatılamadı; yönetici izni gerekebilir.`);
    return res;
  });
  ipcMain.handle('startup:get', () => sys.startupApps());
  ipcMain.handle('clean:scan', async () => {
    const r = await cleaner.scan(id => win.webContents.send('clean:progress', id));
    const total = r.reduce((a, b) => a + b.size, 0);
    pushActivity('info', 'Tarama tamamlandı', `${formatBytes(total)} temizlenebilir alan bulundu.`);
    return r;
  });
  ipcMain.handle('clean:run', async (e, ids) => {
    if (!Array.isArray(ids) || !ids.length) return { freed: 0, removed: 0, skipped: 0 };
    const names = cleaner.categories().filter(c => ids.includes(c.id)).map(c => '• ' + c.name).join('\n');
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Temizle', 'Vazgeç'], defaultId: 0, cancelId: 1,
      title: 'Temizlik', message: 'Seçili dosyalar kalıcı olarak silinecek.', detail: names
    });
    if (r.response !== 0) return { cancelled: true };
    const res = await cleaner.clean(ids, id => win.webContents.send('clean:progress', id));
    store.data.lastClean = Date.now();
    store.data.totalFreed = (store.data.totalFreed || 0) + res.freed;
    store.save();
    pushActivity('success', 'Temizlik tamamlandı', `${formatBytes(res.freed)} boşaltıldı, ${res.removed} dosya silindi${res.skipped ? `, kullanımdaki ${res.skipped} dosya atlandı` : ''}.`);
    return res;
  });
  ipcMain.handle('tool:run', async (e, id) => {
    const r = await tools.runTool(id);
    if (r.name) pushActivity(r.ok ? 'info' : 'warn', r.name, r.message);
    return r;
  });
  ipcMain.handle('store:get', () => ({ settings: store.settings, activities: store.data.activities, lastClean: store.data.lastClean, totalFreed: store.data.totalFreed }));
  ipcMain.handle('settings:set', (e, patch) => {
    const s = store.setSettings(patch || {});
    if ('interval' in patch) startSampler();
    if ('startWithWindows' in patch) applyLogin();
    return s;
  });
  ipcMain.handle('activities:clear', () => { store.data.activities = []; store.save(); return true; });
}

function formatBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// Windows derleme makinesinde gerçek verilerle uçtan uca kontrol
async function runSelfTest(dir) {
  const report = { errors: [] };
  const step = async (name, fn) => {
    const t = Date.now();
    try { report[name] = await fn(); } catch (e) { report.errors.push(`${name}: ${e && e.stack || e}`); }
    report[name + '_ms'] = Date.now() - t;
  };
  fs.mkdirSync(dir, { recursive: true });
  await new Promise(r => setTimeout(r, 6000));
  await step('snapshot', () => sys.snapshot());
  await step('hardware', () => sys.hardware(true));
  await step('processes', async () => { const p = await sys.processes(); return { total: p.total, top: p.list.sort((a, b) => b.mem - a.mem).slice(0, 5) }; });
  await step('startup', () => sys.startupApps());
  await step('scan', () => cleaner.scan());
  await step('flushdns', () => tools.runTool('flushdns'));
  report.historyLength = history.length;
  for (const page of ['overview', 'hardware', 'performance', 'maintenance', 'tools', 'startup']) {
    try {
      await win.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      if (page === 'maintenance') await win.webContents.executeJavaScript(`document.querySelector('#btn-scan').click()`);
      await new Promise(r => setTimeout(r, page === 'maintenance' ? 15000 : 4000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${page}.png`), img.toPNG());
    } catch (e) { report.errors.push(`shot ${page}: ${e}`); }
  }
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  quitting = true;
  app.quit();
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; if (store) store.flush(); sys.stopGpuMonitor(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.whenReady().then(async () => {
  app.setAppUserModelId('com.enskygr234.sysmonitor');
  store = new Store(app.getPath('userData'));
  registerIpc();
  sys.startGpuMonitor();
  await sample();
  startSampler();
  createTray();
  applyLogin();
  const hidden = process.argv.includes('--hidden');
  createWindow(hidden);
  if (SELFTEST) runSelfTest(SELFTEST);
  if (!store.data.activities.length) pushActivity('success', 'SysMonitor kuruldu', 'Bilgisayarının durumu artık canlı olarak izleniyor.');
  pushActivity('info', 'Panel başlatıldı', `${os.hostname()} izlenmeye başladı.`);
});
