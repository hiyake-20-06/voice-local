'use strict';

// hotanvoice - module tạo/kiểm tra KEY cho keygen nội bộ.
// LICENSE_SECRET phải trùng server license; app khách không chứa secret này.
//
// Cơ chế:
// - KEY trả phí: HTV1-XXXXX-... gắn với Device ID, có thể vĩnh viễn hoặc hết hạn.
// - Dùng thử: server quyết định 10 phút/ngày, keygen không phát KEY thử.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Secret KHÔNG được hardcode trong repo (sẽ lộ cho mọi người).
// Thứ tự tìm:
//   1. biến môi trường HOTANVOICE_LICENSE_SECRET
//   2. keygen\config.json          (đã nằm trong .gitignore)
//   3. server\node\config.json     (khi chạy trong cùng monorepo)
let cachedSecret = null;

function readSecretFrom(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
    return String(parsed.licenseSecret || '').trim();
  } catch {
    return '';
  }
}

function loadLicenseSecret() {
  if (cachedSecret) return cachedSecret;

  const candidates = [
    () => String(process.env.HOTANVOICE_LICENSE_SECRET || '').trim(),
    () => readSecretFrom(path.join(__dirname, '..', 'config.json')),
    () => readSecretFrom(path.join(__dirname, '..', '..', 'server', 'node', 'config.json'))
  ];

  for (const read of candidates) {
    const value = read();
    if (value) { cachedSecret = value; return cachedSecret; }
  }

  throw new Error(
    'Chưa cấu hình LICENSE_SECRET. Tạo file keygen/config.json từ config.example.json ' +
    'hoặc đặt biến môi trường HOTANVOICE_LICENSE_SECRET (phải trùng server license).'
  );
}

const PREFIX = 'HTV1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (bỏ I, L, O, U)
const PLAN_LABELS = { P: 'Cá nhân', S: 'Studio', C: 'Thương mại', T: 'Dùng thử' };
const PERPETUAL = '000000';

const TRIAL_KEY = 'HTV1-TRIAL-10MIN';
const TRIAL_KEY_NORMALIZED = 'HTV1TRIAL10MIN';
const TRIAL_MINUTES = 10;

function base32(buffer, length) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (output.length >= length) return output;
    }
    if (bits > 0) value &= (1 << bits) - 1;
    else value = 0;
  }
  if (bits > 0 && output.length < length) output += ALPHABET[(value << (5 - bits)) & 31];
  return output.slice(0, length);
}

function hmac(payload) {
  return crypto.createHmac('sha256', loadLicenseSecret()).update(String(payload)).digest();
}

function safeExec(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 6000 });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function windowsIdentity() {
  if (process.platform !== 'win32') return { uuid: os.hostname(), guid: os.platform() };
  const uuid = safeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID']) || safeExec('wmic.exe', ['csproduct', 'get', 'uuid']);
  const guid = safeExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"]) || safeExec('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  return { uuid: uuid.replace(/[^A-Za-z0-9-]/gu, ''), guid: guid.replace(/.*MachineGuid\s+REG_SZ\s+/iu, '').replace(/[^A-Za-z0-9-]/gu, '') };
}

let cachedDeviceId = null;
function deviceId() {
  if (!cachedDeviceId) {
    const identity = windowsIdentity();
    cachedDeviceId = crypto.createHash('sha256').update(`${os.hostname()}|${identity.uuid}|${identity.guid}`).digest('hex');
  }
  return cachedDeviceId;
}

function shortDeviceId(value = deviceId()) {
  return String(value).toUpperCase().slice(0, 16).replace(/(.{4})(?=.)/gu, '$1-');
}

function deviceCode(value) {
  return base32(hmac(`device:${value}`), 8);
}

function todayCode() {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year').slice(-2)}${get('month')}${get('day')}`;
}

function dayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isValidAlphabet(text) {
  return [...text].every((char) => ALPHABET.includes(char));
}

function makeKey(deviceValue, expires = PERPETUAL, plan = 'P') {
  const expiry = String(expires || PERPETUAL).replace(/[^0-9]/gu, '').slice(0, 6).padEnd(6, '0');
  const planCode = String(plan || 'P').toUpperCase().slice(0, 1);
  if (!PLAN_LABELS[planCode] || planCode === 'T') throw new Error('Plan không hợp lệ (P/S/C).');
  const payload = `${deviceCode(deviceValue)}${expiry}${planCode}`;
  const signature = base32(hmac(`key:${payload}`), 10);
  const body = `${payload}${signature}`;
  const groups = body.match(/.{1,5}/gu) || [];
  return `${PREFIX}-${groups.join('-')}`;
}

function normalizeKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function isTrialKey(value) {
  return normalizeKey(value) === TRIAL_KEY_NORMALIZED;
}

function inspectKey(value, deviceValue = deviceId()) {
  const normalized = normalizeKey(value);
  if (isTrialKey(normalized)) return { valid: false, trial: true, reason: 'Đây là KEY dùng thử. Hãy bấm nút "Dùng thử 10 phút".' };
  if (!normalized.startsWith(PREFIX)) return { valid: false, reason: 'KEY phải bắt đầu bằng HTV1.' };
  const body = normalized.slice(PREFIX.length);
  if (body.length !== 25) return { valid: false, reason: 'Độ dài KEY không đúng.' };
  if (!isValidAlphabet(body)) return { valid: false, reason: 'KEY chứa ký tự không hợp lệ.' };
  const dev = body.slice(0, 8);
  const expires = body.slice(8, 14);
  const plan = body.slice(14, 15);
  const signature = body.slice(15);
  if (dev !== deviceCode(deviceValue)) return { valid: false, reason: 'KEY được cấp cho thiết bị khác.' };
  if (!PLAN_LABELS[plan] || plan === 'T') return { valid: false, reason: 'Loại license không hợp lệ.' };
  if (expires !== PERPETUAL) {
    const today = todayCode();
    if (!/^\d{6}$/u.test(expires)) return { valid: false, reason: 'Ngày hết hạn không hợp lệ.' };
    if (expires < today) return { valid: false, reason: 'KEY đã hết hạn.' };
  }
  const expected = base32(hmac(`key:${dev}${expires}${plan}`), 10);
  const left = Buffer.from(signature, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { valid: false, reason: 'Chữ ký KEY không hợp lệ.' };
  return { valid: true, reason: 'License hợp lệ.', expires, plan, planLabel: PLAN_LABELS[plan] };
}

function formatKeyInput(value) {
  const raw = normalizeKey(value).slice(0, PREFIX.length + 25);
  const body = raw.slice(0, PREFIX.length + 25);
  const groups = body.match(/.{1,5}/gu) || [];
  return groups.join('-');
}

function secretFingerprint() {
  try {
    return crypto.createHash('sha256').update(loadLicenseSecret()).digest('hex').slice(0, 12).toUpperCase();
  } catch {
    return 'CHUA-CAU-HINH';
  }
}

function createStore(dataDir) {
  const filePath = path.join(dataDir, 'license.json');
  const trialPath = path.join(dataDir, 'trial.json');

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  function write(record) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
  function readTrial() {
    try {
      const parsed = JSON.parse(fs.readFileSync(trialPath, 'utf8'));
      const days = Array.isArray(parsed?.days) ? parsed.days.filter((day) => /^\d{4}-\d{2}-\d{2}$/u.test(String(day))) : [];
      return { version: 1, days };
    } catch {
      return { version: 1, days: [] };
    }
  }
  function trialUsedToday() {
    return readTrial().days.includes(dayStamp());
  }
  function markTrialUsed() {
    const data = readTrial();
    const today = dayStamp();
    if (!data.days.includes(today)) data.days.push(today);
    data.days = data.days.slice(-60);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(trialPath, `${JSON.stringify({ version: 1, days: data.days, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  function status() {
    const currentDevice = deviceId();
    const usedToday = trialUsedToday();
    const base = {
      activated: false,
      deviceId: currentDevice,
      deviceShort: shortDeviceId(currentDevice),
      filePath,
      trialKey: TRIAL_KEY,
      trialMinutes: TRIAL_MINUTES,
      trialUsedToday: usedToday,
      trialAvailableToday: !usedToday
    };
    const record = read();
    if (!record) return { ...base, reason: `Chưa kích hoạt trên thiết bị này. Bạn có thể dùng thử ${TRIAL_MINUTES} phút hoặc nhập KEY.` };
    if (record.deviceId && record.deviceId !== currentDevice) return { ...base, reason: 'KEY này được cấp cho thiết bị khác. Hãy nhập KEY đúng với máy này.' };
    if (record.mode === 'trial') {
      const remainingMs = Number(record.expiresAt || 0) - Date.now();
      if (!(remainingMs > 0)) {
        return { ...base, reason: `Bản dùng thử ${TRIAL_MINUTES} phút đã hết. Nhập KEY để tiếp tục sử dụng.`, trialExpired: true };
      }
      return {
        ...base,
        activated: true,
        reason: 'Đang dùng bản dùng thử.',
        plan: 'T',
        planLabel: 'Dùng thử',
        expires: 'TRIAL',
        trial: true,
        trialRemainingMs: remainingMs,
        trialUntil: new Date(record.expiresAt).toISOString(),
        activatedAt: record.startedAt || null,
        trialAvailableToday: false
      };
    }
    const result = inspectKey(record.key, currentDevice);
    if (!result.valid) return { ...base, reason: result.reason };
    return { ...base, activated: true, reason: result.reason, plan: result.plan, planLabel: result.planLabel, expires: result.expires, activatedAt: record.activatedAt || null };
  }

  function startTrial() {
    if (trialUsedToday()) throw new Error('Hôm nay bạn đã dùng bản dùng thử. Vui lòng nhập KEY để tiếp tục.');
    markTrialUsed();
    const now = Date.now();
    write({ version: 2, mode: 'trial', deviceId: deviceId(), startedAt: new Date(now).toISOString(), expiresAt: now + TRIAL_MINUTES * 60 * 1000 });
    return status();
  }

  function activate(rawKey) {
    if (isTrialKey(rawKey)) return startTrial();
    const result = inspectKey(rawKey);
    if (!result.valid) throw new Error(result.reason);
    const record = { version: 1, key: normalizeKey(rawKey), deviceId: deviceId(), plan: result.plan, expires: result.expires, activatedAt: new Date().toISOString() };
    write(record);
    return status();
  }

  return { status, activate, startTrial, trialUsedToday, filePath, trialPath };
}

module.exports = {
  loadLicenseSecret, PREFIX, ALPHABET, PLAN_LABELS, PERPETUAL,
  TRIAL_KEY, TRIAL_KEY_NORMALIZED, TRIAL_MINUTES,
  deviceId, shortDeviceId, makeKey, inspectKey, formatKeyInput, createStore, todayCode, dayStamp,
  isTrialKey, secretFingerprint
};
