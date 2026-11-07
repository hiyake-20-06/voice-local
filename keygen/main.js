'use strict';

// hotanvoice Keygen - app nội bộ cấp KEY license.
// LICENSE_SECRET phải trùng server license (server\node\config.json hoặc secret Cloudflare).
// KHÔNG phát hành app này cho khách.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const license = require('./lib/license');

const PRODUCT = 'hotanvoice-keygen';
const PRODUCT_TITLE = 'hotanvoice Keygen v1.0';

function appRoot() {
  if (process.env.HOTANVOICE_KEYGEN_ROOT) return path.resolve(process.env.HOTANVOICE_KEYGEN_ROOT);
  if (!app.isPackaged) return app.getAppPath();
  return path.dirname(process.execPath);
}
function dataRoot() { return path.join(appRoot(), 'keygen-data'); }

function configurePaths() {
  const data = dataRoot();
  fs.mkdirSync(data, { recursive: true });
  app.setPath('userData', data);
  app.setPath('sessionData', path.join(data, 'session'));
  app.setPath('logs', path.join(data, 'logs'));
}
configurePaths();

app.setName(PRODUCT);
app.setAppUserModelId('studio.hotanvoice.keygen');

let mainWindow = null;
const historyPath = () => path.join(dataRoot(), 'issued.json');

function normalizeDeviceId(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/gu, '');
}

async function readHistory() {
  try {
    const parsed = JSON.parse(await fsp.readFile(historyPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(items) {
  await fsp.mkdir(dataRoot(), { recursive: true });
  await fsp.writeFile(historyPath(), `${JSON.stringify(items.slice(0, 500), null, 2)}\n`, 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 700,
    show: false,
    title: PRODUCT_TITLE,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#080b14',
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWindow.once('ready-to-show', () => { mainWindow.maximize(); mainWindow.show(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('app-info', async () => ({
  name: PRODUCT_TITLE,
  version: app.getVersion(),
  deviceId: license.deviceId(),
  deviceShort: license.shortDeviceId(),
  secretFingerprint: license.secretFingerprint(),
  dataRoot: dataRoot(),
  electron: process.versions.electron,
  trialKey: license.TRIAL_KEY,
  trialMinutes: license.TRIAL_MINUTES
}));

ipcMain.handle('issue-key', async (_event, payload) => {
  const deviceValue = normalizeDeviceId(payload?.deviceId);
  if (deviceValue.length !== 64) throw new Error('Device ID phải gồm 64 ký tự hex (0-9, a-f).');
  const plan = String(payload?.plan || 'P').toUpperCase().slice(0, 1);
  if (!['P', 'S', 'C'].includes(plan)) throw new Error('Loại license không hợp lệ (P/S/C).');
  let expires = String(payload?.expires || license.PERPETUAL).replace(/[^0-9]/gu, '');
  if (!expires) expires = license.PERPETUAL;
  if (expires !== license.PERPETUAL && !/^\d{6}$/u.test(expires)) throw new Error('Hạn dùng phải là 6 số YYMMDD hoặc 000000.');
  const key = license.makeKey(deviceValue, expires, plan);
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    deviceId: deviceValue,
    deviceShort: license.shortDeviceId(deviceValue),
    plan,
    planLabel: license.PLAN_LABELS[plan],
    expires,
    note: String(payload?.note || '').trim().slice(0, 80),
    key
  };
  const history = await readHistory();
  await writeHistory([record, ...history]);
  return record;
});

ipcMain.handle('history', async () => readHistory());
ipcMain.handle('delete-history', async (_event, id) => {
  const history = await readHistory();
  const next = history.filter((item) => item.id !== id);
  await writeHistory(next);
  return next;
});
ipcMain.handle('clear-history', async () => { await writeHistory([]); return []; });

ipcMain.handle('open-data-folder', async () => { await fsp.mkdir(dataRoot(), { recursive: true }); await shell.openPath(dataRoot()); return dataRoot(); });

ipcMain.handle('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); return true; });
ipcMain.handle('window-toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window-close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); return true; });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
