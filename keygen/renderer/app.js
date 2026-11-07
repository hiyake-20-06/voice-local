'use strict';

/* =========================================================================
   hotanvoice Keygen - renderer
   ========================================================================= */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  info: null,
  plan: 'P',
  expiryMode: 'perpetual',
  history: [],
  lastRecord: null
};

const el = {
  secretChip: $('#secret-chip'),
  trialKey: $('#trial-key'),
  trialHint: $('#trial-hint'),
  machineId: $('#machine-id'),
  deviceInput: $('#device-input'),
  deviceLength: $('#device-length'),
  noteInput: $('#note-input'),
  planGroup: $('#plan-group'),
  expiryGroup: $('#expiry-group'),
  dateRow: $('#date-row'),
  expiryDate: $('#expiry-date'),
  formError: $('#form-error'),
  submit: $('#submit'),
  resultEmpty: $('#result-empty'),
  resultBox: $('#result-box'),
  resultBadge: $('#result-badge'),
  resultKey: $('#result-key'),
  resultDevice: $('#result-device'),
  resultPlan: $('#result-plan'),
  resultExpiry: $('#result-expiry'),
  historyList: $('#history-list')
};

let toastTimer = null;

function toast(message, kind = '') {
  const node = $('#toast');
  $('#toast-text').textContent = message;
  node.className = `toast ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3500);
}

function cleanError(error) {
  return String(error?.message || error || 'Có lỗi xảy ra.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/u, '');
}

function pad(value) { return String(value).padStart(2, '0'); }

function toYymmdd(date) {
  return `${String(date.getFullYear()).slice(-2)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatExpiry(expires) {
  if (!expires || expires === '000000') return 'Vĩnh viễn';
  const value = String(expires);
  if (!/^\d{6}$/u.test(value)) return value;
  return `${value.slice(4, 6)}/${value.slice(2, 4)}/20${value.slice(0, 2)}`;
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return '';
  }
}

function normalizeDevice(value) {
  return String(value || '').toLowerCase().replace(/[^a-f0-9]/gu, '');
}

function updateDeviceLength() {
  const value = normalizeDevice(el.deviceInput.value);
  el.deviceLength.textContent = `${value.length}/64 ký tự`;
  el.deviceLength.style.color = value.length === 64 ? 'var(--success)' : '';
}

function setPlan(plan) {
  state.plan = plan;
  $$('#plan-group .segment').forEach((button) => button.classList.toggle('active', button.dataset.plan === plan));
}

function setExpiryMode(mode) {
  state.expiryMode = mode;
  $$('#expiry-group .segment').forEach((button) => button.classList.toggle('active', button.dataset.expiry === mode));
  el.dateRow.classList.toggle('hidden', mode !== 'date');
  if (mode === 'date' && !el.expiryDate.value) {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    el.expiryDate.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

function showError(message) {
  el.formError.textContent = message;
  el.formError.classList.remove('hidden');
}
function hideError() { el.formError.classList.add('hidden'); }

function renderResult(record) {
  state.lastRecord = record;
  el.resultEmpty.classList.add('hidden');
  el.resultBadge.classList.remove('hidden');
  el.resultBox.classList.remove('hidden');
  el.resultKey.textContent = record.key;
  el.resultDevice.textContent = record.deviceShort;
  el.resultPlan.textContent = record.planLabel;
  el.resultExpiry.textContent = formatExpiry(record.expires);
}

function resetResult() {
  state.lastRecord = null;
  el.resultBox.classList.add('hidden');
  el.resultBadge.classList.add('hidden');
  el.resultEmpty.classList.remove('hidden');
}

function historyItemHtml(item) {
  const expiry = formatExpiry(item.expires);
  return `<div class="history-item" data-id="${item.id}">
    <div class="history-main">
      <code class="history-key">${item.key}</code>
      <div class="history-meta">
        <b>${item.planLabel}</b><span>·</span><span>${item.deviceShort}</span><span>·</span><span>${expiry}</span><span>·</span><span>${formatDate(item.createdAt)}</span>
      </div>
    </div>
    <div class="history-actions">
      <button class="icon-action" data-act="copy" data-id="${item.id}" title="Sao chép"><svg class="icon icon-sm"><use href="#i-copy"></use></svg></button>
      <button class="icon-action danger" data-act="delete" data-id="${item.id}" title="Xóa"><svg class="icon icon-sm"><use href="#i-trash"></use></svg></button>
    </div>
  </div>`;
}

function renderHistory() {
  if (!state.history.length) {
    el.historyList.innerHTML = '<div class="history-empty">Chưa cấp KEY nào.</div>';
    return;
  }
  el.historyList.innerHTML = state.history.map(historyItemHtml).join('');
}

async function loadHistory() {
  state.history = await window.keygen.getHistory();
  renderHistory();
}

async function issueKey() {
  hideError();
  const deviceId = normalizeDevice(el.deviceInput.value);
  if (deviceId.length !== 64) { showError('Device ID phải gồm đúng 64 ký tự hex (0-9, a-f).'); return; }

  let expires = '000000';
  if (state.expiryMode === 'date') {
    const value = el.expiryDate.value;
    if (!value) { showError('Hãy chọn ngày hết hạn.'); return; }
    const [year, month, day] = value.split('-').map(Number);
    const chosen = new Date(year, month - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (chosen < today) { showError('Ngày hết hạn phải từ hôm nay trở đi.'); return; }
    expires = toYymmdd(chosen);
  }

  el.submit.disabled = true;
  try {
    const record = await window.keygen.issueKey({
      deviceId,
      plan: state.plan,
      expires,
      note: el.noteInput.value
    });
    renderResult(record);
    await loadHistory();
    toast('Đã tạo KEY. Sao chép và gửi cho khách.', 'success');
  } catch (error) {
    showError(cleanError(error));
  } finally {
    el.submit.disabled = false;
  }
}

function copyKey(value, message = 'Đã sao chép KEY.') {
  window.keygen.copyText(value);
  toast(message, 'success');
}

function bindEvents() {
  el.deviceInput.addEventListener('input', () => { updateDeviceLength(); hideError(); });
  el.expiryDate.addEventListener('change', hideError);
  el.noteInput.addEventListener('input', hideError);

  $('#use-this-pc').addEventListener('click', () => {
    el.deviceInput.value = state.info?.deviceId || '';
    updateDeviceLength();
    hideError();
  });

  $$('#plan-group .segment').forEach((button) => button.addEventListener('click', () => setPlan(button.dataset.plan)));
  $$('#expiry-group .segment').forEach((button) => button.addEventListener('click', () => setExpiryMode(button.dataset.expiry)));

  $$('.date-row .chip').forEach((button) => button.addEventListener('click', () => {
    const days = Number(button.dataset.days) || 30;
    const date = new Date();
    date.setDate(date.getDate() + days);
    el.expiryDate.value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }));

  el.submit.addEventListener('click', issueKey);
  $('#copy-key').addEventListener('click', () => { if (state.lastRecord) copyKey(state.lastRecord.key); });
  $('#reset-result').addEventListener('click', resetResult);

  el.historyList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const item = state.history.find((entry) => entry.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.act === 'copy') { copyKey(item.key); return; }
    if (button.dataset.act === 'delete') {
      state.history = await window.keygen.deleteHistory(item.id);
      renderHistory();
      toast('Đã xóa KEY khỏi lịch sử.');
    }
  });

  $('#clear-history').addEventListener('click', async () => {
    if (!state.history.length) return;
    if (!window.confirm('Xóa toàn bộ lịch sử KEY đã cấp? KEY vẫn dùng được nếu khách đã nhận.')) return;
    state.history = await window.keygen.clearHistory();
    renderHistory();
    toast('Đã xóa lịch sử KEY.');
  });

  $('#open-data').addEventListener('click', () => window.keygen.openDataFolder());
  $('#win-min').addEventListener('click', () => window.keygen.minimizeWindow());
  $('#win-max').addEventListener('click', () => window.keygen.toggleMaximizeWindow());
  $('#win-close').addEventListener('click', () => window.keygen.closeWindow());

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); issueKey(); }
  });
}

async function boot() {
  bindEvents();
  setPlan('P');
  setExpiryMode('perpetual');
  updateDeviceLength();
  try {
    state.info = await window.keygen.getAppInfo();
    el.secretChip.textContent = state.info.secretFingerprint;
    el.machineId.textContent = state.info.deviceShort;
    el.trialKey.textContent = state.info.trialKey;
    el.trialHint.textContent = `${state.info.trialMinutes} phút / ngày`;
  } catch (error) {
    toast(cleanError(error), 'error');
  }
  await loadHistory();
}

boot();
