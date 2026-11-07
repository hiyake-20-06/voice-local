'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hotan', {
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  getLegalInfo: () => ipcRenderer.invoke('legal-info'),

  getLicenseStatus: () => ipcRenderer.invoke('license-status'),
  checkLicense: () => ipcRenderer.invoke('license-check'),
  syncLicense: () => ipcRenderer.invoke('license-sync'),
  getLicenseDeviceStatus: () => ipcRenderer.invoke('license-device-status'),
  activateLicense: (key) => ipcRenderer.invoke('license-activate', key),
  startTrial: () => ipcRenderer.invoke('license-start-trial'),

  getPresetSettings: () => ipcRenderer.invoke('preset-settings'),
  savePresetSettings: (settings) => ipcRenderer.invoke('save-preset-settings', settings),

  listModels: () => ipcRenderer.invoke('list-models'),
  listVoices: (modelId, language) => ipcRenderer.invoke('list-voices', { modelId, language }),
  previewVoice: (modelId, voice, language, useGpu = false) => ipcRenderer.invoke('preview-voice', { modelId, voice, language, useGpu }),

  selectRefAudio: () => ipcRenderer.invoke('select-ref-audio'),
  importTextFile: () => ipcRenderer.invoke('import-text-file'),
  transcribeAudio: (audioBytes) => ipcRenderer.invoke('transcribe-audio', audioBytes),

  selectCustomVoiceAudio: () => ipcRenderer.invoke('select-custom-voice-audio'),
  saveCustomMossVoice: (payload) => ipcRenderer.invoke('save-custom-moss-voice', payload),
  removeCustomMossVoice: (voiceId) => ipcRenderer.invoke('remove-custom-moss-voice', voiceId),

  generate: (payload) => ipcRenderer.invoke('generate', payload),

  getHistory: () => ipcRenderer.invoke('history'),
  deleteHistoryItem: (id) => ipcRenderer.invoke('delete-history-item', id),
  previewHistory: (id) => ipcRenderer.invoke('preview-history', id),
  saveCopy: (id, format) => ipcRenderer.invoke('save-copy', { id, format }),

  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),

  onWorkerStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('worker-status', listener);
    return () => ipcRenderer.removeListener('worker-status', listener);
  },
  onWorkerReady: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('worker-ready', listener);
    return () => ipcRenderer.removeListener('worker-ready', listener);
  },
  onLicenseExpired: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('license-expired', listener);
    return () => ipcRenderer.removeListener('license-expired', listener);
  },
  onLicenseStatusUpdate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('license-status-update', listener);
    return () => ipcRenderer.removeListener('license-status-update', listener);
  }
});
