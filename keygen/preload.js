'use strict';

const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('keygen', {
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  issueKey: (payload) => ipcRenderer.invoke('issue-key', payload),
  getHistory: () => ipcRenderer.invoke('history'),
  deleteHistory: (id) => ipcRenderer.invoke('delete-history', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  copyText: (text) => { clipboard.writeText(String(text || '')); return true; },
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close')
});
