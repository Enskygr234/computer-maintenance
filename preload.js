'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = channel => cb => {
  const fn = (e, data) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('sysmon', {
  info: () => ipcRenderer.invoke('app:info'),
  latest: () => ipcRenderer.invoke('stats:latest'),
  history: () => ipcRenderer.invoke('stats:history'),
  hardware: force => ipcRenderer.invoke('hw:get', force),
  processes: () => ipcRenderer.invoke('procs:get'),
  killProcess: item => ipcRenderer.invoke('procs:kill', item),
  startup: () => ipcRenderer.invoke('startup:get'),
  scan: () => ipcRenderer.invoke('clean:scan'),
  clean: ids => ipcRenderer.invoke('clean:run', ids),
  tool: id => ipcRenderer.invoke('tool:run', id),
  store: () => ipcRenderer.invoke('store:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  clearActivities: () => ipcRenderer.invoke('activities:clear'),
  onStats: on('stats'),
  onActivity: on('activity'),
  onCleanProgress: on('clean:progress')
});
