'use strict';
// Bakım araçları: yalnızca bu listedeki sabit komutlar çalıştırılabilir.
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');
const { powershellEncoded, IS_WIN } = require('./system');

// Yönetici izni gerektiren komutları ayrı, görünür bir PowerShell penceresinde açar.
function elevated(command) {
  const inner = `${command}; Write-Host ''; Write-Host 'Islem bitti. Pencereyi kapatabilirsiniz.' -ForegroundColor Green`;
  const outer = `Start-Process powershell -Verb RunAs -ArgumentList @('-NoExit','-NoProfile','-EncodedCommand','${Buffer.from(inner, 'utf16le').toString('base64')}')`;
  return run('powershell.exe', powershellEncoded(outer));
}

function run(cmd, args = []) {
  return new Promise(resolve => {
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve({ ok: false }));
      p.unref();
      setTimeout(() => resolve({ ok: true }), 400);
    } catch (e) { resolve({ ok: false }); }
  });
}

const TOOLS = {
  flushdns: {
    name: 'DNS önbelleğini temizle',
    exec: () => new Promise(resolve => execFile('ipconfig', ['/flushdns'], { windowsHide: true }, err => resolve({ ok: !err, message: err ? 'DNS önbelleği temizlenemedi' : 'DNS önbelleği temizlendi' })))
  },
  sfc: { name: 'Sistem dosyası denetimi', exec: () => elevated('sfc /scannow') },
  dism: { name: 'Windows görüntü onarımı', exec: () => elevated('DISM /Online /Cleanup-Image /RestoreHealth') },
  chkdsk: { name: 'Disk hata taraması', exec: () => elevated('chkdsk C: /scan') },
  restore: { name: 'Geri yükleme noktası', exec: () => elevated("Checkpoint-Computer -Description 'SysMonitor' -RestorePointType 'MODIFY_SETTINGS'") },
  cleanmgr: { name: 'Disk Temizleme', exec: () => run('cleanmgr.exe') },
  defrag: { name: 'Sürücüleri iyileştir', exec: () => run('dfrgui.exe') },
  taskmgr: { name: 'Görev Yöneticisi', exec: () => run('taskmgr.exe') },
  storage: { name: 'Depolama ayarları', exec: () => shell.openExternal('ms-settings:storagesense').then(() => ({ ok: true })) },
  update: { name: 'Windows Update', exec: () => shell.openExternal('ms-settings:windowsupdate').then(() => ({ ok: true })) },
  startup: { name: 'Başlangıç uygulamaları', exec: () => shell.openExternal('ms-settings:startupapps').then(() => ({ ok: true })) },
  defender: { name: 'Virüs taraması', exec: () => shell.openExternal('windowsdefender://threat').then(() => ({ ok: true })) },
  power: { name: 'Güç seçenekleri', exec: () => run('control.exe', ['powercfg.cpl']) }
};

async function runTool(id) {
  const t = TOOLS[id];
  if (!t) return { ok: false, message: 'Bilinmeyen araç' };
  if (!IS_WIN) return { ok: false, message: 'Bu araç yalnızca Windows\'ta çalışır' };
  try {
    const r = await t.exec();
    return { ok: r.ok !== false, message: r.message || (r.ok === false ? `${t.name} açılamadı` : `${t.name} başlatıldı`), name: t.name };
  } catch (e) {
    return { ok: false, message: `${t.name} açılamadı`, name: t.name };
  }
}

module.exports = { runTool };
