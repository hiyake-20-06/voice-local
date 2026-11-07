'use strict';

/* =========================================================================
   hotanvoice v1.0 — renderer controller
   Không dùng thư viện ngoài. Toàn bộ giao tiếp qua window.hotan (preload).
   ========================================================================= */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  ready: false,
  demo: false,
  appInfo: null,
  license: null,
  models: [],
  model: null,
  voices: [],
  languages: [],
  language: null,
  refAudio: null,
  history: [],
  currentItem: null,
  busy: false,
  gpu: false,
  presets: null,
  catalog: {},
  view: 'studio'
};

const el = {
  gate: $('#license-gate'),
  app: $('#app-shell'),
  licenseDevice: $('#license-device'),
  licenseKey: $('#license-key'),
  licenseForm: $('#license-form'),
  licenseSubmit: $('#license-submit'),
  licenseError: $('#license-error'),
  licenseCopy: $('#license-copy-device'),
  licenseChip: $('#license-chip'),
  trialBtn: $('#license-trial'),
  trialNote: $('#trial-note'),
  gateServer: $('#gate-server'),
  gateServerDot: $('#gate-server-dot'),
  gateServerText: $('#gate-server-text'),
  licenseRetry: $('#license-retry'),
  engineDot: $('#engine-dot'),
  engineName: $('#engine-name'),
  engineSub: $('#engine-sub'),
  navCount: $('#nav-count'),
  pageKicker: $('#page-kicker'),
  pageTitle: $('#page-title'),
  text: $('#text-input'),
  charCount: $('#char-count'),
  langHint: $('#lang-hint'),
  modelSelect: $('#model-select'),
  modelMeta: $('#model-meta'),
  languageField: $('#language-field'),
  languageSelect: $('#language-select'),
  languageMeta: $('#language-meta'),
  voiceSelect: $('#voice-select'),
  voiceMeta: $('#voice-meta'),
  preview: $('#preview-voice'),
  speed: $('#speed-range'),
  speedValue: $('#speed-value'),
  crossfade: $('#crossfade-range'),
  crossfadeValue: $('#crossfade-value'),
  clonePanel: $('#clone-panel'),
  refName: $('#ref-audio-name'),
  clearRef: $('#clear-ref-audio'),
  gpu: $('#gpu-toggle'),
  hint: $('#hint'),
  generate: $('#generate-button'),
  progress: $('#progress'),
  progressMsg: $('#progress-msg'),
  progressPct: $('#progress-pct'),
  progressBar: $('#progress-bar'),
  heroModel: $('#hero-model'),
  heroDevice: $('#hero-device'),
  outputIdle: $('#output-idle'),
  outputResult: $('#output-result'),
  outputDuration: $('#output-duration'),
  resultVoice: $('#result-voice'),
  resultMeta: $('#result-meta'),
  audio: $('#player-audio'),
  playerToggle: $('#player-toggle'),
  playerBar: $('#player-bar'),
  playerFill: $('#player-fill'),
  playerCurrent: $('#player-current'),
  playerDuration: $('#player-duration'),
  phonemeBox: $('#phoneme-box'),
  recentList: $('#recent-list'),
  libraryList: $('#library-list'),
  libraryCount: $('#library-count'),
  librarySearch: $('#library-search'),
  presetModel: $('#preset-model'),
  presetVoice: $('#preset-voice'),
  presetSpeed: $('#preset-speed'),
  presetCrossfade: $('#preset-crossfade'),
  presetDefaultModel: $('#preset-default-model'),
  presetDefaultVoice: $('#preset-default-voice'),
  presetStatus: $('#preset-status'),
  mossLabel: $('#moss-label'),
  mossList: $('#moss-list'),
  aboutVersion: $('#about-version'),
  aboutDevice: $('#about-device'),
  aboutLicense: $('#about-license'),
  aboutTech: $('#about-tech')
};

const successSound = new Audio(new URL('../assets/sounds/success.mp3', document.baseURI).toString());
const failSound = new Audio(new URL('../assets/sounds/fail.mp3', document.baseURI).toString());
const previewAudio = new Audio();
let micRecorder = null;
let micStream = null;
let micChunks = [];
let toastTimer = null;

const VIEWS = {
  studio: { kicker: 'STUDIO', title: 'Tạo giọng nói' },
  library: { kicker: 'LIBRARY', title: 'Thư viện audio' },
  presets: { kicker: 'PRESETS', title: 'Thiết lập preset' },
  about: { kicker: 'ABOUT', title: 'Giới thiệu' }
};

/* ------------------------------------------------------------------ utils */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}
function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return ''; }
}
function shortModelName(modelOrId) {
  const id = typeof modelOrId === 'object' ? modelOrId?.id : String(modelOrId || '');
  const name = typeof modelOrId === 'object' ? modelOrId?.name : '';
  const value = `${id} ${name}`;
  if (/kokoro/iu.test(value)) return 'Kokoro';
  if (/vieneu/iu.test(value)) return 'VietNeu v3';
  if (/moss/iu.test(value)) return 'MOSS Nano';
  return name || 'TTS';
}
function playSound(audio) { try { audio.currentTime = 0; audio.play().catch(() => {}); } catch {} }

function toast(message, kind = '') {
  const node = $('#toast');
  $('#toast-text').textContent = message;
  node.className = `toast ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4200);
}

function setEngine(kind, name, sub) {
  el.engineDot.className = `engine-dot ${kind || ''}`.trim();
  if (name) el.engineName.textContent = name;
  if (sub) el.engineSub.textContent = sub;
}

function setHint(text) {
  el.hint.innerHTML = `<svg class="icon icon-sm"><use href="#i-info"></use></svg>${escapeHtml(text)}`;
}

function setProgress(message, percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  el.progress.classList.remove('hidden');
  el.progressMsg.textContent = message;
  el.progressPct.textContent = `${Math.round(value)}%`;
  el.progressBar.style.width = `${value}%`;
}

/* ------------------------------------------------------------------ views */
function openView(name) {
  if (!VIEWS[name]) return;
  state.view = name;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  el.pageKicker.textContent = VIEWS[name].kicker;
  el.pageTitle.textContent = VIEWS[name].title;
  if (name === 'library') renderLibrary();
  if (name === 'presets') renderPresetView();
  if (name === 'about') renderAbout();
}

/* ------------------------------------------------------------------ license */
function formatKeyInput(value) {
  const clean = String(value || '').toUpperCase().replace(/[^A-Z0-9]/gu, '').slice(0, 29);
  if (clean.length <= 4) return clean;
  const prefix = clean.slice(0, 4);
  const body = (clean.slice(4).match(/.{1,5}/gu) || []).join('-');
  return `${prefix}-${body}`;
}

function showLicenseError(message) {
  el.licenseError.textContent = message;
  el.licenseError.classList.remove('hidden');
}

async function copyDeviceId() {
  const value = state.license?.deviceId || el.licenseDevice.textContent;
  try {
    await navigator.clipboard.writeText(value);
    toast('Đã sao chép Device ID.', 'success');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    document.body.appendChild(helper);
    helper.select();
    try { document.execCommand('copy'); toast('Đã sao chép Device ID.', 'success'); }
    catch { toast('Không sao chép được. Hãy chọn thủ công.', 'error'); }
    helper.remove();
  }
}

function licenseServerHost(status) {
  try { return new URL(status?.serverUrl || '').host; } catch { return ''; }
}

function licenseNowMs() {
  return Date.now() + Number(state.license?.serverOffset || 0);
}

function trialRemainingMs(status) {
  const until = Date.parse(status?.trialUntil || '');
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - licenseNowMs());
}

function formatLeaseDate(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  try {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(time));
  } catch {
    return '';
  }
}

function updateGateServer(status) {
  if (!el.gateServerDot) return;
  const host = licenseServerHost(status);
  const reachable = status?.serverReachable;
  el.gateServerDot.classList.remove('ok', 'err');
  if (reachable === true) {
    el.gateServerDot.classList.add('ok');
    el.gateServerText.textContent = host ? `Server ${host} · đã kết nối` : 'Đã kết nối server license';
  } else if (reachable === false) {
    el.gateServerDot.classList.add('err');
    el.gateServerText.textContent = host ? `Không kết nối được ${host}` : 'Không kết nối được server license';
  } else {
    el.gateServerText.textContent = host ? `Đang kiểm tra ${host}...` : 'Đang kiểm tra server license...';
  }
}

function renderLicenseChip(status) {
  if (status?.plan === 'T' && status.trialUntil) {
    const remaining = trialRemainingMs(status);
    const total = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    el.licenseChip.innerHTML = `<svg class="icon icon-sm"><use href="#i-clock"></use></svg><div><strong>Dùng thử</strong><span>còn ${mm}:${ss}</span></div>`;
    return;
  }
  const plan = status?.planLabel || (status?.activated ? 'Đã kích hoạt' : 'Chưa kích hoạt');
  let expiry;
  if (status?.offline && status?.leaseValidUntil) expiry = `offline đến ${formatLeaseDate(status.leaseValidUntil)}`;
  else if (status?.expires && status.expires !== '000000') expiry = `hết hạn ${status.expires}`;
  else expiry = 'vĩnh viễn';
  el.licenseChip.innerHTML = `<svg class="icon icon-sm"><use href="#i-lock"></use></svg><div><strong>${escapeHtml(plan)}</strong><span>${escapeHtml(expiry)}</span></div>`;
}

function updateGateInfo(status) {
  if (status) state.license = status;
  const current = state.license || {};
  el.licenseDevice.textContent = current.deviceShort || '—';
  const canTrial = current.trialAvailableToday !== false;
  el.trialBtn.disabled = !canTrial;
  el.trialNote.textContent = canTrial
    ? `Mỗi ngày 1 lần · ${current.trialMinutes || 10} phút · cần Internet.`
    : 'Bạn đã dùng bản dùng thử hôm nay. Nhập KEY để tiếp tục.';
  updateGateServer(current);
}

function showGate(status, message) {
  if (status) state.license = status;
  el.gate.classList.remove('hidden');
  el.app.classList.add('hidden');
  const reason = message || state.license?.reason || '';
  if (reason) showLicenseError(reason); else el.licenseError.classList.add('hidden');
  updateGateInfo(state.license);
  renderLicenseChip(state.license || {});
  el.licenseKey.focus();
}

function enterApp() {
  el.licenseError.classList.add('hidden');
  el.gate.classList.add('hidden');
  el.app.classList.remove('hidden');
  initApp().catch((error) => {
    setEngine('err', 'Engine lỗi', 'không khởi động được');
    setHint(error.message || 'Lỗi khởi động.');
    toast(error.message || 'Không khởi động được engine.', 'error');
  });
}

function applyLicenseStatus(status) {
  if (!status) return;
  const wasActivated = Boolean(state.license?.activated);
  state.license = status;
  updateGateServer(status);
  if (status.activated) {
    renderLicenseChip(status);
    el.licenseDevice.textContent = status.deviceShort || '—';
    if (!wasActivated || !el.gate.classList.contains('hidden')) {
      enterApp();
      if (!wasActivated && status.offline && status.leaseValidUntil) {
        toast(`Đã xác thực trước đó · dùng offline đến ${formatLeaseDate(status.leaseValidUntil)}.`);
      }
    }
    if (state.appInfo) renderAbout();
    return;
  }
  if (wasActivated || el.gate.classList.contains('hidden')) {
    showGate(status, status.reason);
  } else {
    updateGateInfo(status);
  }
}

async function bootLicense() {
  try {
    const status = await window.hotan.getLicenseStatus();
    state.license = status;
    if (status.activated) {
      renderLicenseChip(status);
      el.licenseDevice.textContent = status.deviceShort || '—';
      enterApp();
    } else {
      showGate(status);
    }
  } catch (error) {
    showLicenseError(error.message || 'Không đọc được trạng thái license.');
  }
  // Xác thực lại với server ở nền, không chặn giao diện.
  window.hotan.syncLicense()
    .then((status) => applyLicenseStatus(status))
    .catch(() => {});
}

function startLicenseTicker() {
  setInterval(() => {
    if (!state.license?.activated || state.license.plan !== 'T' || !state.license.trialUntil) return;
    renderLicenseChip(state.license);
    if (trialRemainingMs(state.license) <= 0) {
      state.license.activated = false;
      showGate(state.license, `Bản dùng thử ${state.license.trialMinutes || 10} phút đã hết. Nhập KEY để tiếp tục sử dụng.`);
      window.hotan.getLicenseStatus()
        .then((status) => updateGateInfo(status))
        .catch(() => {});
    }
  }, 1000);
}

/* ------------------------------------------------------------------ init */
async function initApp() {
  if (state.ready) return;
  state.ready = true;
  setEngine('', 'Đang tải cấu hình', 'ONNX engine');
  state.presets = await window.hotan.getPresetSettings();
  state.appInfo = await window.hotan.getAppInfo();
  state.models = await window.hotan.listModels();
  el.modelSelect.innerHTML = state.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(shortModelName(model))}</option>`).join('');
  const preferredModel = state.presets.defaultModelId && state.models.some((m) => m.id === state.presets.defaultModelId) ? state.presets.defaultModelId : state.models[0]?.id;
  await selectModel(preferredModel, state.presets.defaultVoices?.[preferredModel]);
  await loadHistory();
  renderAbout();
  setEngine('ok', shortModelName(state.model), `${state.gpu ? 'DirectML GPU' : 'CPU'} · local`);
}

function updateGpuUi() {
  el.heroDevice.textContent = state.gpu ? 'GPU' : 'CPU';
  el.gpu.checked = state.gpu;
  const device = state.gpu ? 'DirectML GPU' : 'CPU';
  el.modelMeta.textContent = `${shortModelName(state.model)} · ONNX · ${device}`;
  el.languageMeta.textContent = `Multilingual · ONNX · ${device}`;
  setEngine('ok', shortModelName(state.model), `${device} · local`);
  if (state.gpu) setHint('GPU DirectML đã bật. Nếu driver không phù hợp, engine tự dự phòng CPU.');
  else if (/moss/iu.test(state.model?.id || '')) setHint('MOSS-TTS-Nano chạy local, 48 kHz stereo, 20 ngôn ngữ.');
  else setHint('Engine chạy local trên CPU, không cần Internet.');
}

/* ------------------------------------------------------------------ model */
async function loadVoiceCatalog(model, language) {
  const key = `${model.id}::${language || ''}`;
  if (!state.catalog[key]) {
    const voices = await window.hotan.listVoices(model.id, language);
    state.catalog[key] = /moss/iu.test(model.id) ? [...voices, ...customMossVoices()] : voices;
  }
  return state.catalog[key];
}

function customMossVoices() {
  return Array.isArray(state.presets?.customVoices?.moss) ? state.presets.customVoices.moss : [];
}

function defaultVoiceForModel(model) {
  return state.presets?.defaultVoices?.[model.id] || model.defaultVoice || state.voices[0]?.id || '';
}

function displayVoiceLabel(voice) {
  if (!voice) return '';
  if (voice.id === 'clone') return 'Clone giọng';
  return voice.label || voice.id;
}

function voiceOptionLabel(voice) {
  if (voice.custom) return `${displayVoiceLabel(voice)} · custom`;
  return voice.id === 'clone' ? 'Clone giọng · audio tham chiếu' : `${displayVoiceLabel(voice)} · preset`;
}

function populateVoices(preferred) {
  el.voiceSelect.innerHTML = state.voices.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voiceOptionLabel(voice))}</option>`).join('');
  const wanted = preferred && state.voices.some((voice) => voice.id === preferred) ? preferred : defaultVoiceForModel(state.model || {});
  el.voiceSelect.value = state.voices.some((voice) => voice.id === wanted) ? wanted : (state.voices[0]?.id || '');
  updateVoiceMeta();
  applySelectedPreset();
}

function updateVoiceMeta() {
  const selected = state.voices.find((voice) => voice.id === el.voiceSelect.value);
  const isMoss = /moss/iu.test(state.model?.id || '');
  el.voiceMeta.textContent = selected?.custom ? 'Custom · audio tham chiếu' : selected?.id === 'clone' ? (isMoss ? 'Audio tham chiếu · 3–12 giây' : 'Audio tham chiếu · 3–8 giây') : 'Preset local';
  const blocked = !selected || selected.id === 'clone' || selected.custom || state.busy;
  el.preview.disabled = blocked;
  el.preview.title = blocked ? 'Không preview voice clone/custom' : 'Nghe thử preset';
}

function populateLanguages() {
  el.languageSelect.innerHTML = state.languages.map((language) => `<option value="${escapeHtml(language.id)}">${escapeHtml(language.label)}</option>`).join('');
  if (state.languages.length) {
    el.languageSelect.value = state.languages.some((item) => item.id === state.language) ? state.language : (state.model?.defaultLanguage || state.languages[0].id);
    state.language = el.languageSelect.value;
  }
}

function renderCloneState() {
  const enabled = Boolean(state.model?.capabilities?.voiceCloning);
  el.clonePanel.classList.toggle('hidden', !enabled);
  if (!enabled) {
    state.refAudio = null;
    el.refName.textContent = 'Chưa chọn file';
    el.clearRef.classList.add('hidden');
    return;
  }
  el.refName.textContent = state.refAudio?.fileName || 'Chưa chọn file';
  el.clearRef.classList.toggle('hidden', !state.refAudio);
}

async function selectModel(modelId, preferredVoice) {
  const model = state.models.find((entry) => entry.id === modelId) || state.models[0];
  if (!model) return;
  state.model = model;
  el.modelSelect.value = model.id;
  el.heroModel.textContent = shortModelName(model);
  const isLanguageModel = Boolean(model.capabilities?.languageSelection);
  el.languageField.classList.toggle('hidden', !isLanguageModel);
  state.languages = isLanguageModel ? (model.languages || []) : [];
  if (isLanguageModel) {
    state.language = state.language && state.languages.some((item) => item.id === state.language) ? state.language : (model.defaultLanguage || state.languages[0]?.id);
    populateLanguages();
    el.langHint.textContent = state.languages.find((item) => item.id === state.language)?.label || 'Multilingual';
    el.text.placeholder = 'Nhập nội dung theo ngôn ngữ đã chọn...';
  } else {
    state.language = null;
    el.langHint.textContent = 'Tiếng Việt';
    el.text.placeholder = 'Nhập nội dung tiếng Việt cần đọc...';
  }
  renderCloneState();
  setEngine('', `Đang tải ${shortModelName(model)}`, 'chuẩn bị model');
  state.voices = await loadVoiceCatalog(model, state.language);
  populateVoices(preferredVoice);
  if (state.refAudio && model.capabilities?.voiceCloning) el.voiceSelect.value = 'clone';
  updateVoiceMeta();
  updateGpuUi();
}

function applySelectedPreset() {
  if (!state.model || !el.voiceSelect.value) return;
  const settings = state.presets?.presets?.[`${state.model.id}::${el.voiceSelect.value}`] || { speed: 1, crossfadeMs: 50 };
  const speed = Math.min(2, Math.max(0.5, Number(settings.speed) || 1));
  const crossfade = Math.min(150, Math.max(0, Number(settings.crossfadeMs) || 0));
  el.speed.value = String(speed);
  el.crossfade.value = String(crossfade);
  el.speedValue.textContent = `${speed.toFixed(2)}×`;
  el.crossfadeValue.textContent = `${crossfade} ms`;
}

/* ------------------------------------------------------------------ preview */
function stopPreview() {
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  el.preview.classList.remove('is-playing');
  updateVoiceMeta();
}

async function previewVoice() {
  if (state.busy || !state.model) return;
  const selected = state.voices.find((voice) => voice.id === el.voiceSelect.value);
  if (!selected || selected.id === 'clone' || selected.custom) return;
  el.preview.disabled = true;
  el.preview.classList.add('is-playing');
  setEngine('', 'Đang tạo mẫu', displayVoiceLabel(selected));
  try {
    const result = await window.hotan.previewVoice(state.model.id, selected.id, state.language, state.gpu);
    previewAudio.src = result.previewUrl;
    previewAudio.onended = () => { stopPreview(); setEngine('ok', shortModelName(state.model), `${state.gpu ? 'DirectML GPU' : 'CPU'} · local`); };
    await previewAudio.play();
    setEngine('ok', `Nghe thử · ${displayVoiceLabel(selected)}`, 'preset local');
  } catch (error) {
    stopPreview();
    toast(error.message || 'Không nghe thử được.', 'error');
  }
}

/* ------------------------------------------------------------------ history */
async function loadHistory() {
  state.history = await window.hotan.getHistory();
  renderRecent();
  renderLibrary();
  el.navCount.textContent = String(state.history.length);
  el.libraryCount.textContent = `${state.history.length} audio`;
}

function historyItemHtml(item) {
  return `<article class="history-row" data-id="${escapeHtml(item.id)}">
    <div class="history-cover"><svg class="icon"><use href="#i-wave"></use></svg></div>
    <div class="history-main">
      <div class="history-top">
        <span class="history-voice">${escapeHtml(item.voiceLabel || item.voice)}</span>
        <span class="history-date">${escapeHtml(formatDate(item.createdAt))}</span>
      </div>
      <div class="history-text">${escapeHtml(item.text)}</div>
      <div class="history-meta">
        <span>${escapeHtml(shortModelName(item.modelId))}</span><span>·</span>
        <span>${escapeHtml(formatDuration(item.durationMs))}</span><span>·</span>
        <span>${Number(item.speed || 1).toFixed(2)}×</span>
      </div>
    </div>
    <div class="history-actions">
      <button class="icon-action" data-act="play" data-id="${escapeHtml(item.id)}" title="Phát"><svg class="icon icon-sm"><use href="#i-play"></use></svg></button>
      <button class="icon-action" data-act="wav" data-id="${escapeHtml(item.id)}" title="Lưu WAV"><svg class="icon icon-sm"><use href="#i-download"></use></svg></button>
      <button class="icon-action" data-act="mp3" data-id="${escapeHtml(item.id)}" title="Lưu MP3"><svg class="icon icon-sm"><use href="#i-download"></use></svg></button>
      <button class="icon-action danger" data-act="delete" data-id="${escapeHtml(item.id)}" title="Xóa"><svg class="icon icon-sm"><use href="#i-trash"></use></svg></button>
    </div>
  </article>`;
}

function renderLibrary() {
  if (!el.libraryList) return;
  const query = (el.librarySearch?.value || '').trim().toLowerCase();
  const items = state.history.filter((item) => !query || `${item.text} ${item.voiceLabel || ''} ${item.modelId || ''}`.toLowerCase().includes(query));
  el.libraryCount.textContent = `${items.length} audio`;
  if (!items.length) {
    el.libraryList.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg class="icon"><use href="#i-wave"></use></svg></div>
      <strong>${query ? 'Không tìm thấy audio phù hợp' : 'Chưa có audio nào'}</strong>
      <span>${query ? 'Thử từ khóa khác hoặc xóa bộ lọc.' : 'Audio bạn tạo trong Studio sẽ được lưu tại đây.'}</span>
    </div>`;
    return;
  }
  el.libraryList.innerHTML = items.map(historyItemHtml).join('');
}

function renderRecent() {
  if (!el.recentList) return;
  const items = state.history.slice(0, 3);
  if (!items.length) {
    el.recentList.innerHTML = '<div class="recent-empty">Chưa có audio gần đây.</div>';
    return;
  }
  el.recentList.innerHTML = items.map((item) => `<div class="recent-item" data-id="${escapeHtml(item.id)}">
    <button class="recent-play" data-act="play" data-id="${escapeHtml(item.id)}" title="Phát"><svg class="icon icon-sm"><use href="#i-play"></use></svg></button>
    <div class="recent-info">
      <span class="recent-text">${escapeHtml(item.text)}</span>
      <span class="recent-meta">${escapeHtml(item.voiceLabel || item.voice)} · ${escapeHtml(formatDuration(item.durationMs))}</span>
    </div>
  </div>`).join('');
}

async function playHistory(item) {
  const result = await window.hotan.previewHistory(item.id);
  state.currentItem = item;
  showResult(item, result.previewUrl);
  try { await el.audio.play(); } catch {}
}

async function handleHistoryAction(button) {
  const action = button.dataset.act;
  const id = button.dataset.id;
  const item = state.history.find((entry) => entry.id === id);
  if (!item) return;
  if (action === 'play') {
    try { await playHistory(item); } catch (error) { toast(error.message || 'Không phát được audio.', 'error'); playSound(failSound); }
    return;
  }
  if (action === 'wav' || action === 'mp3') {
    const result = await window.hotan.saveCopy(item.id, action);
    if (!result.canceled) toast(`Đã lưu ${action.toUpperCase()}.`, 'success');
    return;
  }
  if (action === 'delete') {
    if (!window.confirm('Xóa audio này khỏi thư viện? File WAV/MP3 cũng sẽ bị xóa.')) return;
    state.history = await window.hotan.deleteHistoryItem(item.id);
    if (state.currentItem?.id === item.id) {
      state.currentItem = null;
      el.audio.pause();
      el.audio.removeAttribute('src');
      el.outputResult.classList.add('hidden');
      el.outputIdle.classList.remove('hidden');
      el.outputDuration.classList.add('hidden');
    }
    renderRecent();
    renderLibrary();
    el.navCount.textContent = String(state.history.length);
    toast('Đã xóa audio.', 'success');
  }
}

/* ------------------------------------------------------------------ output */
function showResult(item, previewUrl) {
  el.outputIdle.classList.add('hidden');
  el.outputResult.classList.remove('hidden');
  el.outputDuration.classList.remove('hidden');
  el.outputDuration.textContent = formatDuration(item.durationMs);
  el.resultVoice.textContent = item.voiceLabel || item.voice || 'Audio';
  el.resultMeta.textContent = `${shortModelName(item.modelId || item.modelLabel)} · ${formatDuration(item.durationMs)} · ${Number(item.speed || 1).toFixed(2)}×`;
  el.phonemeBox.textContent = item.phonemes || 'Không có phoneme.';
  el.phonemeBox.classList.add('hidden');
  el.audio.src = previewUrl;
  el.audio.load();
  el.playerFill.style.width = '0%';
  el.playerCurrent.textContent = '0:00';
  el.playerDuration.textContent = formatDuration(item.durationMs);
  setPlayIcon(false);
}

function setPlayIcon(playing) {
  el.playerToggle.innerHTML = `<svg class="icon"><use href="#i-${playing ? 'pause' : 'play'}"></use></svg>`;
  el.playerToggle.title = playing ? 'Tạm dừng' : 'Phát';
}

/* ------------------------------------------------------------------ generate */
function validateGenerate() {
  if (!el.text.value.trim()) { el.text.focus(); toast('Hãy nhập nội dung cần đọc.', 'error'); return false; }
  if (!state.model) { toast('Chưa chọn model.', 'error'); return false; }
  const selected = state.voices.find((voice) => voice.id === el.voiceSelect.value);
  if (state.model.capabilities?.voiceCloning && el.voiceSelect.value === 'clone' && !state.refAudio) {
    toast('Hãy chọn audio tham chiếu để clone giọng.', 'error');
    return false;
  }
  if (selected?.custom && !selected.refAudioPath) {
    toast('Giọng custom thiếu audio tham chiếu.', 'error');
    return false;
  }
  return true;
}

async function generate() {
  if (state.busy || !validateGenerate()) return;
  stopPreview();
  state.busy = true;
  el.generate.disabled = true;
  updateVoiceMeta();
  setProgress('Đang bắt đầu...', 4);
  setEngine('', 'Đang tổng hợp', `${shortModelName(state.model)} · ${state.gpu ? 'GPU' : 'CPU'}`);
  const selected = state.voices.find((voice) => voice.id === el.voiceSelect.value);
  const custom = selected?.custom ? selected : null;
  try {
    const response = await window.hotan.generate({
      modelId: state.model.id,
      text: el.text.value.trim(),
      voiceId: custom ? 'clone' : el.voiceSelect.value,
      voiceLabel: selected?.label || displayVoiceLabel(selected),
      speed: Number(el.speed.value),
      crossfadeMs: Number(el.crossfade.value),
      refAudioPath: state.refAudio?.filePath || custom?.refAudioPath,
      language: state.language,
      useGpu: state.gpu
    });
    state.currentItem = response.item;
    showResult(response.item, response.previewUrl);
    await loadHistory();
    setProgress('Hoàn tất', 100);
    setEngine('ok', shortModelName(state.model), `${state.gpu ? 'DirectML GPU' : 'CPU'} · local`);
    toast('Đã tạo giọng nói xong.', 'success');
    playSound(successSound);
    setTimeout(() => el.progress.classList.add('hidden'), 700);
    el.audio.play().catch(() => {});
  } catch (error) {
    setEngine('err', 'Tạo thất bại', 'xem thông báo');
    toast(error.message || 'Không tạo được voice.', 'error');
    setHint(error.message || 'Không tạo được voice.');
    el.progress.classList.add('hidden');
    playSound(failSound);
  } finally {
    state.busy = false;
    el.generate.disabled = false;
    updateVoiceMeta();
  }
}

/* ------------------------------------------------------------------ preset */
function getPreset(modelId, voiceId) {
  return state.presets?.presets?.[`${modelId}::${voiceId}`] || { speed: 1, crossfadeMs: 50 };
}

function loadPresetFields() {
  const modelId = el.presetModel.value;
  const voiceId = el.presetVoice.value;
  if (!modelId || !voiceId) return;
  const settings = getPreset(modelId, voiceId);
  el.presetSpeed.value = Number(settings.speed ?? 1).toFixed(2);
  el.presetCrossfade.value = String(Number(settings.crossfadeMs ?? 50));
  el.presetDefaultModel.checked = state.presets.defaultModelId === modelId;
  el.presetDefaultVoice.checked = state.presets.defaultVoices?.[modelId] === voiceId;
}

async function loadPresetVoices(modelId) {
  const model = state.models.find((entry) => entry.id === modelId);
  if (!model) return;
  const language = model.id === state.model?.id ? state.language : model.defaultLanguage;
  const voices = await loadVoiceCatalog(model, language);
  el.presetVoice.innerHTML = voices.map((voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voiceOptionLabel(voice))}</option>`).join('');
  const preferred = state.presets?.defaultVoices?.[modelId] || model.defaultVoice || voices[0]?.id || '';
  el.presetVoice.value = voices.some((voice) => voice.id === preferred) ? preferred : (voices[0]?.id || '');
  loadPresetFields();
}

function renderMossList() {
  if (!el.mossList) return;
  const voices = customMossVoices();
  el.mossList.innerHTML = voices.length
    ? voices.map((voice) => `<div class="moss-item"><span>${escapeHtml(voice.label)}</span><button type="button" data-remove="${escapeHtml(voice.id)}">Xóa</button></div>`).join('')
    : '<div class="moss-empty">Chưa có giọng custom.</div>';
}

async function renderPresetView() {
  if (!state.presets) state.presets = await window.hotan.getPresetSettings();
  el.presetModel.innerHTML = state.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(shortModelName(model))}</option>`).join('');
  const preferred = state.presets.defaultModelId || state.model?.id || state.models[0]?.id || '';
  el.presetModel.value = state.models.some((model) => model.id === preferred) ? preferred : (state.models[0]?.id || '');
  await loadPresetVoices(el.presetModel.value);
  renderMossList();
  el.presetStatus.textContent = '';
}

async function savePresets() {
  const modelId = el.presetModel.value;
  const voiceId = el.presetVoice.value;
  if (!modelId || !voiceId) return;
  const speed = Math.min(2, Math.max(0.5, Number(el.presetSpeed.value) || 1));
  const crossfadeMs = Math.min(150, Math.max(0, Number(el.presetCrossfade.value) || 0));
  state.presets.presets[`${modelId}::${voiceId}`] = { speed, crossfadeMs };
  if (el.presetDefaultModel.checked) state.presets.defaultModelId = modelId;
  else if (state.presets.defaultModelId === modelId) state.presets.defaultModelId = '';
  if (el.presetDefaultVoice.checked) state.presets.defaultVoices[modelId] = voiceId;
  else if (state.presets.defaultVoices[modelId] === voiceId) delete state.presets.defaultVoices[modelId];
  state.presets = await window.hotan.savePresetSettings(state.presets);
  state.catalog = {};
  el.presetStatus.textContent = 'Đã lưu thiết lập.';
  toast('Đã lưu preset.', 'success');
  applySelectedPreset();
}

async function addMossVoice() {
  const label = el.mossLabel.value.trim();
  if (!label) { el.presetStatus.textContent = 'Hãy nhập tên giọng custom trước.'; return; }
  try {
    const selected = await window.hotan.selectCustomVoiceAudio();
    if (selected.canceled) return;
    const voice = await window.hotan.saveCustomMossVoice({ label, filePath: selected.filePath });
    state.presets.customVoices.moss = [...customMossVoices(), voice];
    state.catalog = {};
    el.mossLabel.value = '';
    renderMossList();
    await loadPresetVoices(el.presetModel.value);
    el.presetStatus.textContent = `Đã thêm ${voice.label}.`;
    toast('Đã thêm giọng MOSS custom.', 'success');
  } catch (error) {
    el.presetStatus.textContent = error.message || 'Không thêm được giọng custom.';
  }
}

async function removeMossVoice(voiceId) {
  try {
    state.presets = await window.hotan.removeCustomMossVoice(voiceId);
    state.catalog = {};
    renderMossList();
    await loadPresetVoices(el.presetModel.value);
    el.presetStatus.textContent = 'Đã xóa giọng custom.';
  } catch (error) {
    el.presetStatus.textContent = error.message || 'Không xóa được giọng custom.';
  }
}

/* ------------------------------------------------------------------ mic */
function setMicUi(recording) {
  const button = $('#mic-button');
  button.classList.toggle('is-recording', recording);
  button.title = recording ? 'Đang ghi âm — nhấn để dừng' : 'Ghi âm để nhập văn bản';
}

async function startMic() {
  if (state.busy || micRecorder) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Thiết bị không hỗ trợ microphone.', 'error');
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    micRecorder = new MediaRecorder(micStream, { mimeType });
    micChunks = [];
    micRecorder.addEventListener('dataavailable', (event) => { if (event.data?.size) micChunks.push(event.data); });
    micRecorder.start(250);
    setMicUi(true);
    setEngine('', 'Đang ghi âm', 'microphone');
    setHint('Nhấn micro lần nữa để dừng và chuyển giọng nói thành văn bản.');
  } catch (error) {
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    micRecorder = null;
    setMicUi(false);
    toast(error.message || 'Không mở được microphone.', 'error');
  }
}

async function stopMic() {
  const recorder = micRecorder;
  if (!recorder) return;
  micRecorder = null;
  const chunks = micChunks;
  const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.stop();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micStream = null;
  setMicUi(false);
  await stopped;
  if (!chunks.length) { toast('Chưa thu được âm thanh.', 'error'); return; }
  try {
    setEngine('', 'Đang nhận dạng', 'Whisper local');
    setHint('Whisper local đang xử lý bằng CPU; hỗ trợ tiếng Việt và tiếng Anh.');
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await window.hotan.transcribeAudio(bytes);
    const transcript = String(result.text || '').trim();
    if (!transcript) { toast('Không nhận diện được lời nói.', 'error'); setEngine('ok', shortModelName(state.model), 'CPU · local'); return; }
    const previous = el.text.value.trim();
    el.text.value = previous ? `${previous}\n${transcript}` : transcript;
    updateCounts();
    el.text.focus();
    toast('Đã thêm nội dung từ giọng nói.', 'success');
  } catch (error) {
    toast(error.message || 'Nhận dạng thất bại.', 'error');
  } finally {
    setEngine('ok', shortModelName(state.model), `${state.gpu ? 'DirectML GPU' : 'CPU'} · local`);
    setHint('Engine chạy local trên CPU, không cần Internet.');
  }
}

/* ------------------------------------------------------------------ about */
function renderAbout() {
  if (!state.appInfo) return;
  el.aboutVersion.textContent = `v${state.appInfo.version}`;
  el.aboutDevice.textContent = state.license?.deviceShort || '—';
  const plan = state.license?.planLabel || 'Đã kích hoạt';
  let expiry;
  if (state.license?.plan === 'T') expiry = `Dùng thử ${state.license?.trialMinutes || 10} phút`;
  else if (state.license?.offline && state.license?.leaseValidUntil) expiry = `Offline đến ${formatLeaseDate(state.license.leaseValidUntil)}`;
  else if (state.license?.expires && state.license.expires !== '000000') expiry = `Hết hạn ${state.license.expires}`;
  else expiry = 'Vĩnh viễn';
  el.aboutLicense.textContent = `${plan} · ${expiry}`;
  el.aboutTech.innerHTML = (state.appInfo.technologies || []).map((item) => `<span class="tech-tag">${escapeHtml(item)}</span>`).join('');
}

/* ------------------------------------------------------------------ text */
function updateCounts() {
  el.charCount.textContent = `${el.text.value.length.toLocaleString('vi-VN')} ký tự`;
}

/* ------------------------------------------------------------------ events */
function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => openView(button.dataset.view)));
  $$('[data-view-link]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.viewLink)));

  $('#win-min').addEventListener('click', () => window.hotan.minimizeWindow());
  $('#win-max').addEventListener('click', () => window.hotan.toggleMaximizeWindow());
  $('#win-close').addEventListener('click', () => window.hotan.closeWindow());

  el.licenseKey.addEventListener('input', () => {
    const formatted = formatKeyInput(el.licenseKey.value);
    el.licenseKey.value = formatted;
    el.licenseError.classList.add('hidden');
  });
  el.licenseForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    el.licenseSubmit.disabled = true;
    el.licenseError.classList.add('hidden');
    try {
      const result = await window.hotan.activateLicense(el.licenseKey.value);
      if (!result.ok) {
        showLicenseError(result.error || 'KEY không hợp lệ.');
        playSound(failSound);
        if (result.code === 'NETWORK') updateGateServer({ ...state.license, serverReachable: false });
        return;
      }
      applyLicenseStatus(result.status);
      toast('Kích hoạt thành công.', 'success');
    } catch (error) {
      showLicenseError(error.message || 'Không kích hoạt được.');
    } finally {
      el.licenseSubmit.disabled = false;
    }
  });
  el.licenseCopy.addEventListener('click', copyDeviceId);

  if (el.licenseRetry) {
    el.licenseRetry.addEventListener('click', async () => {
      el.licenseRetry.disabled = true;
      el.gateServerDot.classList.remove('ok', 'err');
      el.gateServerText.textContent = 'Đang kiểm tra server license...';
      try {
        const status = await window.hotan.syncLicense();
        applyLicenseStatus(status);
        if (!status.activated) updateGateServer(status);
      } catch (error) {
        showLicenseError(error.message || 'Không kết nối được server license.');
        updateGateServer({ ...state.license, serverReachable: false });
      } finally {
        el.licenseRetry.disabled = false;
      }
    });
  }

  el.trialBtn.addEventListener('click', async () => {
    el.trialBtn.disabled = true;
    el.licenseError.classList.add('hidden');
    try {
      const result = await window.hotan.startTrial();
      if (!result.ok) {
        showLicenseError(result.error || 'Không bắt đầu được dùng thử.');
        if (result.code === 'TRIAL_USED') {
          el.trialNote.textContent = 'Bạn đã dùng bản dùng thử hôm nay. Nhập KEY để tiếp tục.';
        } else if (result.code === 'NETWORK') {
          updateGateServer({ ...state.license, serverReachable: false });
          el.trialBtn.disabled = false;
        } else {
          el.trialBtn.disabled = false;
        }
        return;
      }
      applyLicenseStatus(result.status);
      toast(`Đã bật dùng thử ${result.status.trialMinutes || 10} phút.`, 'success');
    } catch (error) {
      showLicenseError(error.message || 'Không bắt đầu được dùng thử.');
      el.trialBtn.disabled = false;
    }
  });

  el.text.addEventListener('input', updateCounts);
  el.modelSelect.addEventListener('change', async () => {
    if (state.busy) return;
    try { await selectModel(el.modelSelect.value); } catch (error) { toast(error.message || 'Không tải được model.', 'error'); }
  });
  el.languageSelect.addEventListener('change', async () => {
    if (state.busy) return;
    state.language = el.languageSelect.value;
    try { await selectModel(state.model.id, el.voiceSelect.value); } catch (error) { toast(error.message || 'Không tải được ngôn ngữ.', 'error'); }
  });
  el.voiceSelect.addEventListener('change', () => {
    if (el.voiceSelect.value !== 'clone' && !state.voices.find((voice) => voice.id === el.voiceSelect.value)?.custom && state.refAudio) {
      state.refAudio = null;
      renderCloneState();
    }
    updateVoiceMeta();
    applySelectedPreset();
  });
  el.preview.addEventListener('click', previewVoice);

  el.speed.addEventListener('input', () => { el.speedValue.textContent = `${Number(el.speed.value).toFixed(2)}×`; });
  el.crossfade.addEventListener('input', () => { el.crossfadeValue.textContent = `${Number(el.crossfade.value)} ms`; });
  el.gpu.addEventListener('change', () => {
    state.gpu = el.gpu.checked;
    updateGpuUi();
    setHint(state.gpu ? 'GPU DirectML đã bật; engine sẽ tự dự phòng CPU nếu cần.' : 'Engine chạy local trên CPU, không cần Internet.');
  });

  $('#import-text').addEventListener('click', async () => {
    try {
      const result = await window.hotan.importTextFile();
      if (result.canceled) return;
      const text = String(result.text || '').trim();
      if (!text) { toast('File không có nội dung.', 'error'); return; }
      const limited = text.slice(0, 12000);
      el.text.value = limited;
      updateCounts();
      el.text.focus();
      toast(limited.length < text.length ? 'Đã nhập file, nội dung được rút gọn còn 12.000 ký tự.' : `Đã nhập ${result.fileName}.`, 'success');
    } catch (error) { toast(error.message || 'Nhập file thất bại.', 'error'); playSound(failSound); }
  });
  $('#clear-text').addEventListener('click', () => { el.text.value = ''; updateCounts(); el.text.focus(); });
  $('#mic-button').addEventListener('click', () => { if (micRecorder) stopMic(); else startMic(); });

  $('#select-ref-audio').addEventListener('click', async () => {
    if (!state.model?.capabilities?.voiceCloning) return;
    const result = await window.hotan.selectRefAudio();
    if (result.canceled) return;
    state.refAudio = result;
    el.voiceSelect.value = 'clone';
    renderCloneState();
    updateVoiceMeta();
    toast('Đã chọn audio tham chiếu.', 'success');
  });
  el.clearRef.addEventListener('click', () => {
    state.refAudio = null;
    renderCloneState();
    if (el.voiceSelect.value === 'clone') el.voiceSelect.value = state.model?.defaultVoice || state.voices[0]?.id || '';
    updateVoiceMeta();
  });

  el.generate.addEventListener('click', generate);
  $('#save-wav').addEventListener('click', async () => { if (state.currentItem) { const r = await window.hotan.saveCopy(state.currentItem.id, 'wav'); if (!r.canceled) toast('Đã lưu WAV.', 'success'); } });
  $('#save-mp3').addEventListener('click', async () => { if (state.currentItem) { const r = await window.hotan.saveCopy(state.currentItem.id, 'mp3'); if (!r.canceled) toast('Đã lưu MP3.', 'success'); } });
  $('#toggle-phonemes').addEventListener('click', () => el.phonemeBox.classList.toggle('hidden'));

  el.playerToggle.addEventListener('click', () => {
    if (!el.audio.src) return;
    if (el.audio.paused) el.audio.play().catch(() => {}); else el.audio.pause();
  });
  el.audio.addEventListener('play', () => setPlayIcon(true));
  el.audio.addEventListener('pause', () => setPlayIcon(false));
  el.audio.addEventListener('ended', () => { setPlayIcon(false); el.playerFill.style.width = '0%'; el.playerCurrent.textContent = '0:00'; });
  el.audio.addEventListener('timeupdate', () => {
    const ratio = el.audio.duration ? el.audio.currentTime / el.audio.duration : 0;
    el.playerFill.style.width = `${ratio * 100}%`;
    el.playerCurrent.textContent = formatDuration(el.audio.currentTime * 1000);
  });
  el.audio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.audio.duration)) el.playerDuration.textContent = formatDuration(el.audio.duration * 1000);
  });
  el.playerBar.addEventListener('click', (event) => {
    if (!el.audio.duration) return;
    const rect = el.playerBar.getBoundingClientRect();
    el.audio.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * el.audio.duration;
  });

  el.recentList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (button) { handleHistoryAction(button); return; }
    const row = event.target.closest('.recent-item');
    if (row) {
      const item = state.history.find((entry) => entry.id === row.dataset.id);
      if (item) playHistory(item).catch((error) => toast(error.message || 'Không phát được.', 'error'));
    }
  });
  el.libraryList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (button) handleHistoryAction(button);
  });
  el.librarySearch.addEventListener('input', renderLibrary);

  el.presetModel.addEventListener('change', async () => { el.presetStatus.textContent = ''; await loadPresetVoices(el.presetModel.value); });
  el.presetVoice.addEventListener('change', () => { el.presetStatus.textContent = ''; loadPresetFields(); });
  $('#preset-save').addEventListener('click', savePresets);
  $('#moss-add').addEventListener('click', addMossVoice);
  el.mossList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (button) removeMossVoice(button.dataset.remove);
  });

  $('#open-data-folder').addEventListener('click', () => window.hotan.openDataFolder());
  $('#open-data-2').addEventListener('click', () => window.hotan.openDataFolder());
  $('#open-legal').addEventListener('click', async () => {
    $('#legal-content').textContent = await window.hotan.getLegalInfo();
    $('#legal-modal').classList.remove('hidden');
  });
  $$('[data-close]').forEach((button) => button.addEventListener('click', () => { $(`#${button.dataset.close}`).classList.add('hidden'); }));
  $('#legal-modal').addEventListener('click', (event) => { if (event.target.id === 'legal-modal') $('#legal-modal').classList.add('hidden'); });

  window.hotan.onWorkerStatus((event) => {
    if (event?.level === 'error') { setEngine('err', 'Engine lỗi', 'xem thông báo'); if (event.message) toast(event.message, 'error'); }
    else if (event?.message) { setProgress(event.message, event.progress || 0); }
  });
  window.hotan.onWorkerReady(() => {
    if (state.model) setEngine('ok', shortModelName(state.model), `${state.gpu ? 'DirectML GPU' : 'CPU'} · local`);
    else setEngine('ok', 'Engine sẵn sàng', 'ONNX local');
  });
  window.hotan.onLicenseExpired((status) => {
    applyLicenseStatus(status);
    if (status && status.activated === false) {
      showGate(status, status.reason || 'License đã hết hạn. Nhập KEY để tiếp tục sử dụng.');
    }
    playSound(failSound);
  });
  if (window.hotan.onLicenseStatusUpdate) {
    window.hotan.onLicenseStatusUpdate((status) => applyLicenseStatus(status));
  }

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/u.test(event.target.tagName);
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); generate(); return; }
    if (typing) return;
    if (['1', '2', '3', '4'].includes(event.key)) openView(['studio', 'library', 'presets', 'about'][Number(event.key) - 1]);
  });
}

/* ------------------------------------------------------------------ boot */
bindEvents();
updateCounts();
startLicenseTicker();
bootLicense();
