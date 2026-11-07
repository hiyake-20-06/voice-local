'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const license = require('./lib/license');

const PRODUCT = 'hotanvoice';
const PRODUCT_TITLE = 'hotanvoice v1.0';

// ---------------------------------------------------------------------------
// Portable paths: toàn bộ dữ liệu nằm cạnh file exe, không phụ thuộc app khác.
// ---------------------------------------------------------------------------
function appRoot() {
  if (process.env.HOTANVOICE_ROOT) return path.resolve(process.env.HOTANVOICE_ROOT);
  if (!app.isPackaged) return app.getAppPath();
  return path.dirname(process.execPath);
}
function dataRoot() { return path.join(appRoot(), 'hotanvoice-data'); }

function configurePaths() {
  const data = dataRoot();
  app.setPath('userData', data);
  app.setPath('sessionData', path.join(data, 'session'));
  app.setPath('logs', path.join(data, 'logs'));
  app.setPath('crashDumps', path.join(data, 'crashes'));
  app.setPath('temp', path.join(data, 'temp'));
}
configurePaths();

app.setName(PRODUCT);
app.setAppUserModelId('studio.hotanvoice.desktop');

let mainWindow = null;
let worker = null;
let workerBuffer = '';
let workerReady = false;
let workerStderr = '';
let workerReadyPromise = null;
let workerReadyResolve = null;
let workerReadyReject = null;
let startupError = null;
let previewManifestCache = null;
let requestCounter = 0;
const pendingRequests = new Map();

function paths() {
  const root = dataRoot();
  return {
    root,
    outputs: path.join(root, 'outputs'),
    history: path.join(root, 'history.json'),
    presets: path.join(root, 'presets.json'),
    customVoices: path.join(root, 'custom-voices'),
    workerOutput: path.join(root, 'worker-output'),
    asrTemp: path.join(root, 'asr-temp'),
    license: path.join(root, 'license.json')
  };
}

// ---------------------------------------------------------------------------
// Nhập văn bản TXT / SRT
// ---------------------------------------------------------------------------
function stripSrt(content) {
  return String(content || '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^\s*\d+\s*$/u.test(line) && !/^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}/u.test(line))
    .join('\n')
    .replace(/<\/?(?:i|b|u|font|c)(?:\s[^>]*)?>/giu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

async function readImportedTextFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  let content;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) content = buffer.subarray(2).toString('utf16le');
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) { swapped[i - 2] = buffer[i + 1]; swapped[i - 1] = buffer[i]; }
    content = swapped.toString('utf16le');
  } else content = buffer.toString('utf8');
  return /\.srt$/iu.test(filePath) ? stripSrt(content) : content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
}

// ---------------------------------------------------------------------------
// Preset settings
// ---------------------------------------------------------------------------
function defaultPresetSettings() {
  return { version: 1, defaultModelId: '', defaultVoices: {}, defaultLanguages: {}, presets: {}, customVoices: { moss: [] } };
}

function normalizePresetSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const settings = defaultPresetSettings();
  settings.defaultModelId = typeof source.defaultModelId === 'string' ? source.defaultModelId : '';
  settings.defaultVoices = source.defaultVoices && typeof source.defaultVoices === 'object' ? { ...source.defaultVoices } : {};
  settings.defaultLanguages = source.defaultLanguages && typeof source.defaultLanguages === 'object' ? { ...source.defaultLanguages } : {};
  settings.presets = source.presets && typeof source.presets === 'object' ? source.presets : {};
  const custom = Array.isArray(source.customVoices?.moss) ? source.customVoices.moss : [];
  settings.customVoices.moss = custom
    .filter((voice) => voice && typeof voice.id === 'string' && typeof voice.label === 'string' && typeof voice.refAudioPath === 'string')
    .map((voice) => ({ id: voice.id, label: voice.label, refAudioPath: voice.refAudioPath, custom: true }));
  return settings;
}

async function readPresetSettings() {
  await ensureDataDirs();
  try { return normalizePresetSettings(JSON.parse(await fsp.readFile(paths().presets, 'utf8'))); } catch { return defaultPresetSettings(); }
}

async function writePresetSettings(value) {
  const settings = normalizePresetSettings(value);
  await ensureDataDirs();
  await fsp.writeFile(paths().presets, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

// ---------------------------------------------------------------------------
// Data dirs / history
// ---------------------------------------------------------------------------
async function cleanupWorkerOutput() {
  try {
    const entries = await fsp.readdir(paths().workerOutput, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => fsp.unlink(path.join(paths().workerOutput, entry.name)).catch(() => {})));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[hotanvoice] worker-output cleanup:', error.message);
  }
}

async function removeTempFile(filePath) {
  if (filePath) { try { await fsp.unlink(filePath); } catch {} }
}

async function ensureDataDirs() {
  const p = paths();
  await Promise.all([
    fsp.mkdir(p.root, { recursive: true }),
    fsp.mkdir(p.outputs, { recursive: true }),
    fsp.mkdir(p.customVoices, { recursive: true }),
    fsp.mkdir(p.workerOutput, { recursive: true }),
    fsp.mkdir(p.asrTemp, { recursive: true })
  ]);
  await cleanupWorkerOutput();
  try { await fsp.access(p.history); } catch { await fsp.writeFile(p.history, '[]\n', 'utf8'); }
  try { await fsp.access(p.presets); } catch { await fsp.writeFile(p.presets, `${JSON.stringify(defaultPresetSettings(), null, 2)}\n`, 'utf8'); }
}

async function readHistory() {
  await ensureDataDirs();
  try {
    const parsed = JSON.parse(await fsp.readFile(paths().history, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeHistory(items) {
  await ensureDataDirs();
  await fsp.writeFile(paths().history, `${JSON.stringify(items.slice(0, 100), null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Speech-to-text (Whisper.cpp local)
// ---------------------------------------------------------------------------
function resolveWhisperPath() {
  return path.join(app.getAppPath(), 'assets', 'asr', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
}
function resolveWhisperModelPath() {
  return path.join(app.getAppPath(), 'assets', 'asr', 'models', 'ggml-base-q5_1.bin');
}
function resolveFfmpegPath() {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'ffmpeg', binaryName),
    path.join(__dirname, 'assets', 'ffmpeg', binaryName),
    process.platform === 'win32' ? path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe') : ffmpegPath,
    ffmpegPath
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || ffmpegPath;
}

async function transcribeAudioBytes(audioBytes) {
  const bytes = Buffer.from(audioBytes || []);
  if (!bytes.length) throw new Error('Không nhận được dữ liệu microphone.');
  if (bytes.length > 24 * 1024 * 1024) throw new Error('Đoạn ghi âm quá lớn; hãy ghi từng đoạn ngắn hơn.');
  const tempDir = paths().asrTemp;
  await fsp.mkdir(tempDir, { recursive: true });
  const id = crypto.randomUUID();
  const inputPath = path.join(tempDir, `${id}.webm`);
  const wavPath = path.join(tempDir, `${id}.wav`);
  const outputBase = path.join(tempDir, id);
  const jsonPath = `${outputBase}.json`;
  try {
    const ffmpeg = resolveFfmpegPath();
    const whisper = resolveWhisperPath();
    const model = resolveWhisperModelPath();
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error(`Không tìm thấy ffmpeg đi kèm: ${ffmpeg || 'unknown'}`);
    if (!fs.existsSync(whisper) || !fs.existsSync(model)) throw new Error('Thiếu runtime hoặc model speech-to-text trong assets/asr.');
    await fsp.writeFile(inputPath, bytes);
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Không thể chuyển audio sang WAV: ${stderr.trim() || `ffmpeg exit ${code}`}`)));
    });
    const threads = Math.max(1, Math.min(8, (os.cpus()?.length || 4) - 1));
    await new Promise((resolve, reject) => {
      const child = spawn(whisper, ['-m', model, '-f', wavPath, '-l', 'auto', '-oj', '-ojf', '-nt', '-np', '-ng', '-t', String(threads), '-of', outputBase], { cwd: path.dirname(whisper), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-5000); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Whisper nhận dạng thất bại: ${stderr.trim() || `exit ${code}`}`)));
    });
    const parsed = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    const segments = Array.isArray(parsed.transcription) ? parsed.transcription : (Array.isArray(parsed.segments) ? parsed.segments : []);
    const text = segments.map((segment) => String(segment.text || '')).join(' ').replace(/\s+/gu, ' ').trim();
    return { text, model: 'Whisper.cpp base-q5_1 · CPU', language: parsed.result?.language || parsed.language || 'auto' };
  } finally {
    await Promise.all([inputPath, wavPath, jsonPath].map((filePath) => removeTempFile(filePath)));
  }
}

// ---------------------------------------------------------------------------
// Worker (model engine)
// ---------------------------------------------------------------------------
function workerPath() { return path.join(app.getAppPath(), 'node', 'worker.js'); }

function sendWorker(action, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!worker || worker.killed) { reject(new Error('Engine chưa sẵn sàng.')); return; }
    const id = `req_${Date.now()}_${++requestCounter}`;
    pendingRequests.set(id, { resolve, reject });
    worker.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`);
  });
}

function handleWorkerLine(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { console.warn('[worker]', line); return; }
  if (message.event === 'status') {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('worker-status', message);
    return;
  }
  if (message.event === 'ready') {
    workerReady = true;
    startupError = null;
    if (workerReadyResolve) workerReadyResolve(message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('worker-ready', message);
    return;
  }
  const pending = pendingRequests.get(message.id);
  if (!pending) return;
  pendingRequests.delete(message.id);
  if (message.ok === false) pending.reject(new Error(message.error || 'Worker error'));
  else pending.resolve(message);
}

function startWorker() {
  if (worker && !worker.killed && workerReadyPromise) return workerReadyPromise;
  workerReady = false;
  workerStderr = '';
  startupError = null;
  workerReadyPromise = new Promise((resolve, reject) => { workerReadyResolve = resolve; workerReadyReject = reject; });
  const assets = path.join(app.getAppPath(), 'assets');
  const env = {
    ...process.env,
    HOTANVOICE_APP_DATA: dataRoot(),
    HOTANVOICE_FFMPEG_PATH: path.join(assets, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    KOKORO_MODEL_DIR: path.join(assets, 'model'),
    VIENEU_MODEL_DIR: path.join(assets, 'model', 'vieneu-v3-int8'),
    VIENEU_CODEC_DIR: path.join(assets, 'model', 'moss-onnx'),
    MOSS_TTS_MODEL_DIR: path.join(assets, 'model', 'moss-tts-nano'),
    MOSS_CODEC_DIR: path.join(assets, 'model', 'moss-onnx'),
    NODE_PATH: path.join(app.getAppPath(), 'node_modules'),
    ELECTRON_RUN_AS_NODE: '1',
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '4',
    MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '4',
    ORT_INTRA_OP_NUM_THREADS: process.env.ORT_INTRA_OP_NUM_THREADS || '4',
    ORT_INTER_OP_NUM_THREADS: process.env.ORT_INTER_OP_NUM_THREADS || '1'
  };
  worker = spawn(process.execPath, [workerPath()], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => {
    workerBuffer += chunk;
    const lines = workerBuffer.split('\n');
    workerBuffer = lines.pop() || '';
    for (const line of lines) handleWorkerLine(line);
  });
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk) => { workerStderr = `${workerStderr}${chunk}`.slice(-6000); console.warn('[hotanvoice-engine]', chunk.trim()); });
  worker.on('error', (error) => {
    workerReady = false;
    startupError = error;
    if (workerReadyReject) workerReadyReject(error);
    workerReadyPromise = null;
    workerReadyResolve = null;
    workerReadyReject = null;
    for (const request of pendingRequests.values()) request.reject(error);
    pendingRequests.clear();
  });
  worker.on('exit', (code, signal) => {
    workerReady = false;
    const detail = workerStderr.trim();
    const error = new Error(`Engine đã dừng (code=${code}, signal=${signal || 'none'}).${detail ? `\n\nChi tiết:\n${detail}` : ''}`);
    startupError = error;
    if (workerReadyReject) workerReadyReject(error);
    workerReadyPromise = null;
    workerReadyResolve = null;
    workerReadyReject = null;
    for (const request of pendingRequests.values()) request.reject(error);
    pendingRequests.clear();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('worker-status', { level: 'error', message: error.message });
  });
  return workerReadyPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(value) {
  return String(value || 'voice').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/Đ/gu, 'D').replace(/đ/gu, 'd').replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').toUpperCase() || 'VOICE';
}
function modelCode(modelId, modelLabel) {
  const value = `${modelId || ''} ${modelLabel || ''}`;
  if (/kokoro/iu.test(value)) return 'KOKORO';
  if (/vieneu/iu.test(value)) return 'VNEU';
  if (/moss/iu.test(value)) return 'MOSS';
  return 'TTS';
}
function fileTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function resolvePreviewPath(modelId, voice) {
  if (!previewManifestCache) {
    try { previewManifestCache = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'assets', 'previews', 'manifest.json'), 'utf8')); }
    catch { previewManifestCache = { models: {} }; }
  }
  const entry = previewManifestCache.models?.[modelId]?.voices?.find((item) => item.voice === voice);
  if (!entry?.file) return null;
  const candidate = path.join(app.getAppPath(), 'assets', 'previews', entry.file);
  return fs.existsSync(candidate) ? candidate : null;
}

const licenseStore = { current: null };

function readLicenseServerUrl() {
  if (process.env.HOTANVOICE_LICENSE_SERVER) return String(process.env.HOTANVOICE_LICENSE_SERVER).trim();
  const candidates = [
    path.join(appRoot(), 'license-server.json'),
    path.join(app.getAppPath(), 'license-server.json'),
    path.join(app.getAppPath(), '..', '..', 'license-server.json')
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const value = String(parsed.url || parsed.serverUrl || '').trim();
      if (value) return value;
    } catch {}
  }
  return license.DEFAULT_SERVER;
}

function getLicenseStore() {
  if (!licenseStore.current) {
    licenseStore.current = license.createStore(dataRoot(), {
      serverUrl: readLicenseServerUrl(),
      appVersion: app.getVersion()
    });
  }
  return licenseStore.current;
}

// Chặn các tính năng AI khi license/dùng thử đã hết hạn.
async function requireLicense() {
  const status = getLicenseStore().status();
  if (!status.activated) {
    const error = new Error(status.reason || 'Cần kích hoạt KEY để tiếp tục sử dụng.');
    error.code = 'LICENSE_REQUIRED';
    throw error;
  }
  return status;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 720,
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

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('app-info', async () => ({
  product: PRODUCT,
  name: PRODUCT_TITLE,
  version: app.getVersion(),
  dataRoot: dataRoot(),
  platform: process.platform,
  electron: process.versions.electron,
  workerReady,
  developer: 'Ho Tan',
  technologies: [
    'Electron 31', 'Node.js engine', 'ONNX Runtime CPU', 'DirectML tùy chọn',
    'Whisper.cpp base-q5_1', 'Kokoro Vietnamese', 'VietNeu-TTS v3 Turbo', 'MOSS-TTS-Nano'
  ]
}));

ipcMain.handle('license-status', async () => getLicenseStore().status());
ipcMain.handle('license-check', async () => getLicenseStore().check());
ipcMain.handle('license-sync', async () => {
  const status = await getLicenseStore().sync();
  broadcastLicense(status);
  return status;
});
ipcMain.handle('license-device-status', async () => getLicenseStore().deviceStatus());
ipcMain.handle('license-activate', async (_event, key) => {
  try {
    const status = await getLicenseStore().activate(key);
    broadcastLicense(status);
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: error.message || 'Không thể kích hoạt.', code: error.code || null };
  }
});
ipcMain.handle('license-start-trial', async () => {
  try {
    const status = await getLicenseStore().startTrial();
    broadcastLicense(status);
    return { ok: true, status };
  } catch (error) {
    return { ok: false, error: error.message || 'Không thể bắt đầu dùng thử.', code: error.code || null };
  }
});

ipcMain.handle('legal-info', async () => {
  try { return await fsp.readFile(path.join(app.getAppPath(), 'LEGAL-NOTICES.txt'), 'utf8'); }
  catch { return 'LEGAL-NOTICES.txt chưa được đóng gói.'; }
});

ipcMain.handle('preset-settings', async () => readPresetSettings());
ipcMain.handle('save-preset-settings', async (_event, settings) => writePresetSettings(settings));

ipcMain.handle('list-models', async () => { await startWorker(); return (await sendWorker('list_models')).models; });
ipcMain.handle('list-voices', async (_event, payload) => {
  await startWorker();
  const data = typeof payload === 'string' ? { modelId: payload } : (payload || {});
  return (await sendWorker('list_voices', { modelId: String(data.modelId || ''), language: data.language ? String(data.language) : undefined })).voices;
});

ipcMain.handle('transcribe-audio', async (_event, audioBytes) => { await requireLicense(); return transcribeAudioBytes(audioBytes); });

ipcMain.handle('select-custom-voice-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn audio giọng MOSS custom',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
});

ipcMain.handle('save-custom-moss-voice', async (_event, payload) => {
  const sourcePath = path.resolve(String(payload?.filePath || ''));
  const label = String(payload?.label || '').trim().slice(0, 80);
  if (!label) throw new Error('Hãy nhập tên cho giọng MOSS custom.');
  if (!fs.existsSync(sourcePath)) throw new Error('Không tìm thấy file audio giọng custom.');
  const extension = path.extname(sourcePath).toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.ogg', '.flac'].includes(extension)) throw new Error('Định dạng audio không được hỗ trợ.');
  await ensureDataDirs();
  const id = `htv_custom_${crypto.randomUUID().slice(0, 8)}`;
  const destination = path.join(paths().customVoices, `${id}${extension}`);
  await fsp.copyFile(sourcePath, destination);
  const settings = await readPresetSettings();
  settings.customVoices.moss.push({ id, label, refAudioPath: destination, custom: true });
  await writePresetSettings(settings);
  return settings.customVoices.moss.at(-1);
});

ipcMain.handle('remove-custom-moss-voice', async (_event, voiceId) => {
  const settings = await readPresetSettings();
  const index = settings.customVoices.moss.findIndex((voice) => voice.id === String(voiceId));
  if (index < 0) return settings;
  const [removed] = settings.customVoices.moss.splice(index, 1);
  const customRoot = `${path.resolve(paths().customVoices)}${path.sep}`;
  if (removed?.refAudioPath && path.resolve(removed.refAudioPath).startsWith(customRoot)) await removeTempFile(removed.refAudioPath);
  for (const modelId of Object.keys(settings.defaultVoices)) {
    if (settings.defaultVoices[modelId] === voiceId) delete settings.defaultVoices[modelId];
  }
  for (const presetId of Object.keys(settings.presets)) {
    if (presetId.endsWith(`::${voiceId}`)) delete settings.presets[presetId];
  }
  return writePresetSettings(settings);
});

ipcMain.handle('import-text-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Nhập nội dung từ TXT hoặc SRT',
    properties: ['openFile'],
    filters: [{ name: 'Văn bản và phụ đề', extensions: ['txt', 'srt'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const text = await readImportedTextFile(filePath);
  return { canceled: false, filePath, fileName: path.basename(filePath), text };
});

ipcMain.handle('select-ref-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn audio tham chiếu để clone giọng',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
});

ipcMain.handle('generate', async (_event, payload) => {
  await requireLicense();
  await startWorker();
  const modelId = String(payload.modelId || 'kokoro-vietnamese-node');
  let result;
  try {
    result = await sendWorker('generate', {
      modelId,
      text: String(payload.text || ''),
      voice: String(payload.voiceId || payload.voice || ''),
      speed: Number(payload.speed || 1),
      crossfadeMs: Number(payload.crossfadeMs ?? 50),
      refAudioPath: payload.refAudioPath ? String(payload.refAudioPath) : undefined,
      language: payload.language ? String(payload.language) : undefined,
      useGpu: Boolean(payload.useGpu),
      temperature: payload.temperature !== undefined ? Number(payload.temperature) : undefined
    });
    const id = crypto.randomUUID();
    const stem = `${modelCode(modelId, result.modelLabel || result.model)}-${slugify(result.voiceLabel || payload.voice || 'voice')}-${fileTimestamp()}-${id.slice(0, 8)}`;
    const base = path.join(paths().outputs, stem);
    const wavPath = `${base}.wav`;
    const mp3Path = `${base}.mp3`;
    await fsp.copyFile(result.wavPath, wavPath);
    await new Promise((resolve, reject) => {
      const executable = resolveFfmpegPath();
      if (!executable || !fs.existsSync(executable)) { reject(new Error(`Không tìm thấy ffmpeg để xuất MP3: ${executable || 'unknown'}`)); return; }
      const child = spawn(executable, ['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-qscale:a', '2', mp3Path], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Không thể tạo MP3, ffmpeg exit ${code}`)));
    });
    const item = {
      id,
      createdAt: new Date().toISOString(),
      text: String(payload.text || ''),
      modelId,
      modelLabel: result.modelLabel || result.model || modelId,
      voice: String(payload.voiceId || payload.voice || ''),
      voiceLabel: payload.voiceLabel ? String(payload.voiceLabel) : (result.voiceLabel || String(payload.voice || '')),
      refAudioName: payload.refAudioPath ? path.basename(String(payload.refAudioPath)) : '',
      speed: Number(payload.speed || 1),
      durationMs: Number(result.durationMs || 0),
      wavPath,
      mp3Path,
      phonemes: result.phonemes || ''
    };
    const history = await readHistory();
    await writeHistory([item, ...history]);
    const previewData = await fsp.readFile(mp3Path);
    return { item, previewUrl: `data:audio/mpeg;base64,${previewData.toString('base64')}` };
  } finally {
    await removeTempFile(result?.wavPath);
    await cleanupWorkerOutput();
  }
});

ipcMain.handle('preview-voice', async (_event, payload) => {
  await requireLicense();
  const modelId = String(payload.modelId || 'kokoro-vietnamese-node');
  const voice = String(payload.voice || '');
  const cachedPath = resolvePreviewPath(modelId, voice);
  if (cachedPath) {
    const data = await fsp.readFile(cachedPath);
    return { previewUrl: `data:audio/wav;base64,${data.toString('base64')}` , cached: true };
  }
  await startWorker();
  const result = await sendWorker('preview_voice', { modelId, voice, language: payload.language ? String(payload.language) : undefined, useGpu: Boolean(payload.useGpu) });
  try {
    const data = await fsp.readFile(result.wavPath);
    return { previewUrl: `data:audio/wav;base64,${data.toString('base64')}`, cached: false };
  } finally {
    await removeTempFile(result.wavPath);
    await cleanupWorkerOutput();
  }
});

ipcMain.handle('history', async () => readHistory());

ipcMain.handle('delete-history-item', async (_event, id) => {
  const history = await readHistory();
  const item = history.find((entry) => entry.id === id);
  if (item) {
    for (const file of [item.wavPath, item.mp3Path]) { try { await fsp.unlink(file); } catch {} }
  }
  const next = history.filter((entry) => entry.id !== id);
  await writeHistory(next);
  await cleanupWorkerOutput();
  return next;
});

ipcMain.handle('preview-history', async (_event, id) => {
  const item = (await readHistory()).find((entry) => entry.id === id);
  if (!item) throw new Error('Không tìm thấy audio trong lịch sử.');
  const data = await fsp.readFile(item.mp3Path);
  return { previewUrl: `data:audio/mpeg;base64,${data.toString('base64')}` };
});

ipcMain.handle('save-copy', async (_event, { id, format }) => {
  const item = (await readHistory()).find((entry) => entry.id === id);
  if (!item) throw new Error('Không tìm thấy audio trong lịch sử.');
  const extension = format === 'wav' ? 'wav' : 'mp3';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: `Lưu file ${extension.toUpperCase()}`,
    defaultPath: path.join(app.getPath('downloads'), `${path.basename(item.wavPath, path.extname(item.wavPath))}.${extension}`),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fsp.copyFile(extension === 'wav' ? item.wavPath : item.mp3Path, result.filePath);
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('window-minimize', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); return true; });
ipcMain.handle('window-toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window-close', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); return true; });
ipcMain.handle('open-data-folder', async () => { await ensureDataDirs(); await shell.openPath(dataRoot()); return dataRoot(); });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let licenseMonitor = null;
let lastLicenseActive = null;
let licenseTickBusy = false;

function broadcastLicense(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('license-status-update', status);
}

async function refreshLicense(reason = 'tick') {
  if (licenseTickBusy) return null;
  licenseTickBusy = true;
  try {
    const status = await getLicenseStore().sync();
    const wasActive = lastLicenseActive;
    lastLicenseActive = status.activated;
    broadcastLicense(status);
    if (!status.activated && wasActive === true) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license-expired', { ...status, reason });
    }
    return status;
  } catch (error) {
    return null;
  } finally {
    licenseTickBusy = false;
  }
}

function startLicenseMonitor() {
  if (licenseMonitor) return;
  lastLicenseActive = getLicenseStore().status().activated;
  licenseMonitor = setInterval(() => { refreshLicense('heartbeat'); }, 60_000);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    await ensureDataDirs();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media' && webContents === mainWindow?.webContents);
    });
    createWindow();
    startLicenseMonitor();
    setTimeout(() => { refreshLicense('startup'); }, 1500);
    startWorker().catch((error) => {
      startupError = error;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('worker-status', { level: 'error', message: error.message });
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  cleanupWorkerOutput().catch(() => {});
  if (worker && !worker.killed) worker.kill();
  if (process.platform !== 'darwin') app.quit();
});
