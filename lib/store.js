'use strict';
// Ayarlar ve aktivite kayıtları için küçük JSON deposu.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    startWithWindows: false,
    minimizeToTray: true,
    alerts: true,
    cpuAlert: 90,
    ramAlert: 90,
    diskAlert: 10,
    interval: 2
  },
  activities: [],
  lastClean: null,
  totalFreed: 0
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'sysmonitor.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
    } catch (e) { /* ilk açılış */ }
    this.timer = null;
  }
  get settings() { return this.data.settings; }
  setSettings(patch) { Object.assign(this.data.settings, patch); this.save(); return this.data.settings; }
  log(type, title, text) {
    const a = { t: Date.now(), type, title, text };
    this.data.activities.unshift(a);
    this.data.activities = this.data.activities.slice(0, 200);
    this.save();
    return a;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { /* yazılamadıysa sessizce geç */ }
  }
}

module.exports = Store;
