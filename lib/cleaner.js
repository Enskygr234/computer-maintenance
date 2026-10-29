'use strict';
// Gereksiz dosya temizliği. Yalnızca aşağıda tanımlı klasörlerin İÇERİĞİ silinir;
// sembolik bağlantılar ve bağlantı noktaları (junction) asla takip edilmez.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { powershellEncoded, IS_WIN } = require('./system');

const env = process.env;
const LOCAL = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const WINDIR = env.SystemRoot || env.windir || 'C:\\Windows';

function existing(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

// Chromium tabanlı tarayıcılarda tüm profillerin önbellek klasörleri
function chromiumCaches(userData) {
  const out = [];
  if (!existing(userData)) return out;
  let profiles = [];
  try { profiles = fs.readdirSync(userData).filter(n => n === 'Default' || /^Profile \d+$/.test(n)); } catch (e) {}
  for (const p of profiles) {
    for (const sub of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) {
      const d = path.join(userData, p, sub);
      if (existing(d)) out.push(d);
    }
  }
  return out;
}

function firefoxCaches() {
  const root = path.join(LOCAL, 'Mozilla', 'Firefox', 'Profiles');
  if (!existing(root)) return [];
  try {
    return fs.readdirSync(root).map(p => path.join(root, p, 'cache2')).filter(existing);
  } catch (e) { return []; }
}

function categories() {
  if (!IS_WIN) {
    return [
      { id: 'userTemp', name: 'Geçici dosyalar', desc: 'Uygulamaların bıraktığı geçici dosyalar', dirs: [os.tmpdir()] }
    ];
  }
  return [
    { id: 'userTemp', name: 'Kullanıcı geçici dosyaları', desc: '%TEMP% klasöründeki eski kurulum ve uygulama artıkları', dirs: [os.tmpdir()] },
    { id: 'winTemp', name: 'Windows geçici dosyaları', desc: 'Windows\\Temp klasörü (bir kısmı yönetici izni ister)', dirs: [path.join(WINDIR, 'Temp')] },
    { id: 'crash', name: 'Çökme raporları', desc: 'Uygulama çökme dökümleri ve hata raporları', dirs: [path.join(LOCAL, 'CrashDumps'), path.join(LOCAL, 'Microsoft', 'Windows', 'WER', 'ReportArchive')] },
    { id: 'browser', name: 'Tarayıcı önbellekleri', desc: 'Chrome, Edge, Brave ve Firefox önbelleği (açık tarayıcının kilitli dosyaları atlanır)', dirs: [
      ...chromiumCaches(path.join(LOCAL, 'Google', 'Chrome', 'User Data')),
      ...chromiumCaches(path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')),
      ...chromiumCaches(path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')),
      ...firefoxCaches()
    ] },
    { id: 'thumbs', name: 'Küçük resim önbelleği', desc: 'Gezginin klasör önizlemeleri; gerektiğinde yeniden oluşturulur', dirs: [path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer')], filter: n => /^(thumbcache|iconcache)_.*\.db$/i.test(n), shallow: true },
    { id: 'wu', name: 'Windows Update indirmeleri', desc: 'Kurulmuş güncellemelerin indirme artıkları (yönetici izni ister)', dirs: [path.join(WINDIR, 'SoftwareDistribution', 'Download')] },
    { id: 'recycle', name: 'Geri Dönüşüm Kutusu', desc: 'Kutudaki dosyalar kalıcı olarak silinir', special: 'recycle' }
  ];
}

// Klasörü dolaşıp dosyaları listeler (sembolik bağlantı yok, derinlik ve adet sınırlı)
async function walk(dir, onFile, opts = {}, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (opts.shallow) continue;
      let st;
      try { st = await fsp.lstat(full); } catch (er) { continue; }
      if (st.isSymbolicLink()) continue;
      await walk(full, onFile, opts, depth + 1);
    } else if (e.isFile()) {
      if (opts.filter && !opts.filter(e.name)) continue;
      let st;
      try { st = await fsp.lstat(full); } catch (er) { continue; }
      await onFile(full, st.size);
    }
  }
}

function recycleSize() {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve({ size: 0, count: 0 });
    const script = `$s = (New-Object -ComObject Shell.Application).NameSpace(10); $n = 0; $t = [double]0; foreach ($i in $s.Items()) { $n++; $t += [double]$i.ExtendedProperty('Size') }; Write-Output "$n|$t"`;
    execFile('powershell.exe', powershellEncoded(script), { windowsHide: true, timeout: 30000 }, (err, out) => {
      if (err) return resolve({ size: 0, count: 0 });
      const [n, t] = String(out).trim().split('|');
      resolve({ size: parseFloat(t) || 0, count: parseInt(n, 10) || 0 });
    });
  });
}

function emptyRecycle() {
  return new Promise(resolve => {
    if (!IS_WIN) return resolve(false);
    execFile('powershell.exe', powershellEncoded('Clear-RecycleBin -Force -ErrorAction SilentlyContinue'), { windowsHide: true, timeout: 60000 }, err => resolve(!err));
  });
}

async function scan(onProgress) {
  const cats = categories();
  const result = [];
  for (const c of cats) {
    if (onProgress) onProgress(c.id);
    if (c.special === 'recycle') {
      const r = await recycleSize();
      result.push({ id: c.id, name: c.name, desc: c.desc, size: r.size, count: r.count });
      continue;
    }
    let size = 0, count = 0;
    for (const d of c.dirs) {
      if (!existing(d)) continue;
      await walk(d, (f, s) => { size += s; count++; }, { filter: c.filter, shallow: c.shallow });
    }
    result.push({ id: c.id, name: c.name, desc: c.desc, size, count });
  }
  return result;
}

async function clean(ids, onProgress) {
  const cats = categories().filter(c => ids.includes(c.id));
  let freed = 0, removed = 0, skipped = 0;
  for (const c of cats) {
    if (onProgress) onProgress(c.id);
    if (c.special === 'recycle') {
      const before = await recycleSize();
      if (await emptyRecycle()) { freed += before.size; removed += before.count; }
      continue;
    }
    for (const d of c.dirs) {
      if (!existing(d)) continue;
      await walk(d, async (f, s) => {
        try { await fsp.unlink(f); freed += s; removed++; } catch (e) { skipped++; }
      }, { filter: c.filter, shallow: c.shallow });
      if (!c.shallow) await pruneEmptyDirs(d, true);
    }
  }
  return { freed, removed, skipped };
}

// Boş kalan alt klasörleri kaldırır; kök klasörün kendisine dokunmaz.
async function pruneEmptyDirs(dir, isRoot, depth = 0) {
  if (depth > 24) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) await pruneEmptyDirs(path.join(dir, e.name), false, depth + 1);
  }
  if (!isRoot) { try { await fsp.rmdir(dir); } catch (e) {} }
}

module.exports = { scan, clean, categories };
