'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bioassayDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron,
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  onUpdateStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
}));
