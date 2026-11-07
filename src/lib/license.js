'use strict';

// hotanvoice - client license ONLINE.
//
// App KHÔNG giữ secret tạo KEY. Toàn bộ xác thực nằm ở server:
// - KEY (HMAC) chỉ server kiểm tra.
// - Server cấp "lease" ký ECDSA P-256; app xác thực bằng public key nhúng bên dưới.
// - KEY trả phí: lease 7 ngày, hết hạn lease mới bắt buộc online lại.
// - Bản dùng thử: server quyết định 10 phút/ngày và bắt buộc online.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const DEFAULT_GRACE_DAYS = 7;
const TRIAL_MINUTES = 10;
const TRIAL_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

// Public key của license server (ECDSA P-256). Đổi khi tạo cặp khóa mới.
const LICENSE_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'Zsx0RETbmJRaxsxNBTGukXoc2tHKv4QvNsp3WDEWKNM',
  y: 't5DovugEEOPtMyVLuRPqZalqvWIG7D70IlopKQBHm3I'
};

const PLAN_LABELS = { P: 'Cá nhân', S: 'Studio', C: 'Thương mại', T: 'Dùng thử' };

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
  return {
    uuid: uuid.replace(/[^A-Za-z0-9-]/gu, ''),
    guid: guid.replace(/.*MachineGuid\s+REG_SZ\s+/iu, '').replace(/[^A-Za-z0-9-]/gu, '')
  };
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

function normalizeKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function formatKeyInput(value) {
  const raw = normalizeKey(value).slice(0, 29);
  const groups = raw.match(/.{1,5}/gu) || [];
  return groups.join('-');
}

function b64urlToBuffer(value) {
  const text = String(value).replace(/-/gu, '+').replace(/_/gu, '/');
  return Buffer.from(text, 'base64');
}

function dayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sameDay(a, b) {
  try { return dayStamp(new Date(a)) === dayStamp(new Date(b)); } catch { return false; }
}

function formatDate(ms) {
  try {
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));
  } catch {
    return '';
  }
}

function verifyLease(token, expectedDeviceId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('Phiên license không hợp lệ.');
  const data = b64urlToBuffer(parts[0]);
  const signature = b64urlToBuffer(parts[1]);
  let valid = false;
  try {
    const key = crypto.createPublicKey({ key: LICENSE_PUBLIC_JWK, format: 'jwk' });
    valid = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error('Chữ ký license không hợp lệ.');
  let payload;
  try { payload = JSON.parse(data.toString('utf8')); }
  catch { throw new Error('Nội dung license không hợp lệ.'); }
  if (payload.v !== 1) throw new Error('Phiên bản license không hỗ trợ.');
  if (payload.dev !== expectedDeviceId) throw new Error('License không dành cho thiết bị này.');
  if (!(Number(payload.validUntil) > Date.now())) throw new Error('Phiên xác thực đã hết hạn.');
  return payload;
}

function createStore(dataDir, options = {}) {
  const filePath = path.join(dataDir, 'license.json');
  const serverUrl = String(options.serverUrl || DEFAULT_SERVER).replace(/\/+$/u, '');
  const appVersion = String(options.appVersion || '');
  const state = {
    lastDeviceStatus: null,
    lastDeviceStatusAt: 0,
    trialUsedDay: null,
    lastError: null,
    lastErrorCode: null,
    reachable: null,
    serverOffset: 0,
    inflightSync: null
  };

  function readCache() {
    try {
      const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeCache(record) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function clearCache() {
    try { fs.unlinkSync(filePath); } catch {}
  }

  function baseStatus() {
    const current = deviceId();
    return {
      activated: false,
      mode: 'online',
      deviceId: current,
      deviceShort: shortDeviceId(current),
      filePath,
      serverUrl,
      serverReachable: state.reachable,
      online: state.reachable === true,
      offline: state.reachable === false,
      serverOffset: state.serverOffset,
      trialMinutes: TRIAL_MINUTES,
      graceDays: DEFAULT_GRACE_DAYS,
      trialAvailableToday: state.trialUsedDay === dayStamp()
        ? false
        : (state.lastDeviceStatus ? Boolean(state.lastDeviceStatus.trialAvailableToday) : true),
      trialUsedToday: state.trialUsedDay === dayStamp()
        ? true
        : (state.lastDeviceStatus ? !state.lastDeviceStatus.trialAvailableToday : false),
      trialUntil: null,
      trialRemainingMs: 0,
      plan: null,
      planLabel: null,
      expires: null,
      leaseValidUntil: null,
      checkedAt: state.lastDeviceStatusAt ? new Date(state.lastDeviceStatusAt).toISOString() : null
    };
  }

  function status() {
    const base = baseStatus();
    const cache = readCache();
    if (!cache) {
      if (state.trialUsedDay === dayStamp()) {
        return {
          ...base,
          reason: 'Hôm nay bạn đã dùng bản dùng thử. Nhập KEY để tiếp tục sử dụng.',
          trialAvailableToday: false,
          trialUsedToday: true
        };
      }
      return {
        ...base,
        reason: state.reachable === false
          ? 'Chưa kích hoạt. Không kết nối được server license — kiểm tra Internet rồi thử lại.'
          : `Chưa kích hoạt trên thiết bị này. Bạn có thể dùng thử ${TRIAL_MINUTES} phút hoặc nhập KEY.`
      };
    }
    if (!cache.lease && cache.key) {
      return {
        ...base,
        reason: state.reachable === false
          ? 'Cần kết nối Internet để xác thực KEY trên thiết bị này.'
          : 'Đang xác thực KEY với server license...'
      };
    }

    let lease;
    try {
      lease = verifyLease(cache.lease, base.deviceId);
    } catch (error) {
      return { ...base, activated: false, reason: error.message };
    }

    const now = Date.now();
    const graceDays = Number(lease.graceDays || cache.graceDays || DEFAULT_GRACE_DAYS);
    const baseLease = {
      ...base,
      graceDays,
      plan: lease.plan,
      planLabel: PLAN_LABELS[lease.plan] || lease.plan,
      expires: lease.licenseExpires,
      trial: Boolean(lease.trial),
      leaseValidUntil: lease.validUntil,
      checkedAt: cache.lastCheckAt ? new Date(cache.lastCheckAt).toISOString() : base.checkedAt
    };

    if (lease.trial) {
      const trialUntil = Number(lease.trialUntil || 0);
      const serverNow = Date.now() + state.serverOffset;
      const remaining = Math.max(0, trialUntil - serverNow);
      const lastOnline = Number(cache.lastOnlineAt || 0);
      const onlineFresh = Date.now() - lastOnline <= TRIAL_ONLINE_WINDOW_MS;
      const trialDay = trialUntil ? dayStamp(new Date(trialUntil)) : null;
      const usedToday = trialDay === dayStamp();
      const trialBase = {
        ...baseLease,
        trialMinutes: Number(lease.trialMinutes || TRIAL_MINUTES),
        trialUntil: trialUntil ? new Date(trialUntil).toISOString() : null,
        trialRemainingMs: remaining,
        trialAvailableToday: !usedToday,
        trialUsedToday: usedToday
      };
      if (remaining <= 0) {
        return { ...trialBase, activated: false, reason: `Bản dùng thử ${trialBase.trialMinutes} phút đã hết. Nhập KEY để tiếp tục sử dụng.` };
      }
      if (!onlineFresh) {
        return { ...trialBase, activated: false, offline: true, reason: 'Bản dùng thử cần kết nối Internet để tiếp tục. Kiểm tra mạng rồi thử lại.' };
      }
      return { ...trialBase, activated: true, online: true, offline: false, reason: 'Đang dùng bản dùng thử.' };
    }

    if (state.reachable === false) {
      return {
        ...baseLease,
        activated: true,
        online: false,
        offline: true,
        reason: `Không kết nối được server license. Bản quyền đã xác thực, dùng offline đến ${formatDate(lease.validUntil)}.`
      };
    }

    return {
      ...baseLease,
      activated: true,
      online: true,
      offline: false,
      reason: lease.licenseExpires === '000000'
        ? 'License hợp lệ (vĩnh viễn).'
        : `License hợp lệ đến ${lease.licenseExpires}.`
    };
  }

  async function request(pathname, body, method = 'POST') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${serverUrl}${pathname}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw Object.assign(new Error('Server license trả về dữ liệu không hợp lệ.'), { code: 'BAD_RESPONSE' }); }
      if (!response.ok || data.ok === false) {
        throw Object.assign(new Error(data.error || `Lỗi server license (${response.status}).`), { code: data.code || `HTTP_${response.status}` });
      }
      state.reachable = true;
      state.lastError = null;
      state.lastErrorCode = null;
      if (Number(data.serverTime || data.time)) {
        state.serverOffset = Number(data.serverTime || data.time) - Date.now();
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        state.reachable = false;
        throw Object.assign(new Error('Server license không phản hồi. Kiểm tra Internet rồi thử lại.'), { code: 'NETWORK' });
      }
      if (error.code && /^(BAD_|REVOKED|TRIAL_|HTTP_)/u.test(error.code)) {
        // Server trả lỗi nghiệp vụ: vẫn là kết nối thành công.
        state.reachable = true;
        throw error;
      }
      state.reachable = false;
      throw Object.assign(new Error('Không kết nối được server license. Kiểm tra Internet.'), { code: 'NETWORK' });
    } finally {
      clearTimeout(timer);
    }
  }

  function save(data, mode, key) {
    const payload = verifyLease(data.lease, deviceId());
    const now = Date.now();
    const previous = readCache();
    const record = {
      version: 3,
      mode,
      key: key ? normalizeKey(key) : null,
      deviceId: deviceId(),
      lease: data.lease,
      plan: payload.plan,
      planLabel: PLAN_LABELS[payload.plan] || payload.plan,
      licenseExpires: payload.licenseExpires,
      trial: Boolean(payload.trial),
      trialUntil: payload.trialUntil,
      graceDays: Number(payload.graceDays || DEFAULT_GRACE_DAYS),
      savedAt: now,
      lastLocalAt: Math.max(now, Number(previous?.lastLocalAt || 0)),
      lastCheckAt: now,
      lastOnlineAt: now,
      serverOffset: state.serverOffset
    };
    writeCache(record);
    if (mode === 'trial') {
      state.trialUsedDay = dayStamp();
      state.lastDeviceStatus = { trialAvailableToday: false, trialUntil: payload.trialUntil };
      state.lastDeviceStatusAt = now;
    }
    return record;
  }

  async function refreshDeviceStatus() {
    try {
      const data = await request(`/api/status?deviceId=${deviceId()}`, null, 'GET');
      state.lastDeviceStatus = data;
      state.lastDeviceStatusAt = Date.now();
      return data;
    } catch {
      return null;
    }
  }

  async function sync() {
    if (state.inflightSync) return state.inflightSync;
    state.inflightSync = (async () => {
      try {
        const cache = readCache();

        // Nâng cấp từ bản offline cũ: cache chỉ có key, chưa có lease.
        // Đưa key lên server xác thực một lần rồi lưu lease mới.
        if (cache && !cache.lease && cache.key) {
          try {
            const data = await request('/api/activate', { key: cache.key, deviceId: deviceId(), appVersion });
            save(data, 'paid', cache.key);
            return { ...status(), synced: true, migrated: true };
          } catch (error) {
            if (error.code === 'NETWORK') {
              return { ...status(), synced: false, networkError: true };
            }
            // KEY cũ không còn hợp lệ / bị thu hồi: bỏ cache để người dùng nhập lại.
            clearCache();
            state.lastError = error.message;
            state.lastErrorCode = error.code || null;
            state.reachable = true;
            return { ...status(), synced: true, reason: error.message };
          }
        }

        if (!cache?.lease) {
          await refreshDeviceStatus();
          return { ...status(), synced: false };
        }

        try {
          if (cache.trial) {
            const data = await request('/api/session', { trial: true, deviceId: deviceId(), appVersion });
            save(data, 'trial', null);
          } else {
            const key = cache.key;
            if (!key) { clearCache(); return { ...status(), synced: true }; }
            const data = await request('/api/session', { key, deviceId: deviceId(), appVersion });
            save(data, 'paid', key);
          }
          return { ...status(), synced: true };
        } catch (error) {
          if (error.code === 'NETWORK') {
            return { ...status(), synced: false, networkError: true };
          }
          // BAD_KEY / REVOKED / TRIAL_EXPIRED: server từ chối rõ ràng.
          if (error.code === 'TRIAL_EXPIRED' || error.code === 'TRIAL_USED') {
            state.trialUsedDay = dayStamp();
          }
          clearCache();
          state.lastError = error.message;
          state.lastErrorCode = error.code || null;
          return { ...status(), synced: true, reason: error.message };
        }
      } finally {
        state.inflightSync = null;
      }
    })();
    return state.inflightSync;
  }

  async function activate(rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) throw new Error('Hãy nhập KEY kích hoạt.');
    if (!key.startsWith('HTV1')) throw new Error('KEY phải bắt đầu bằng HTV1.');
    if (key === 'HTV1TRIAL10MIN') throw new Error('Đây là KEY dùng thử. Hãy bấm nút "Dùng thử 10 phút".');
    const data = await request('/api/activate', { key, deviceId: deviceId(), appVersion });
    save(data, 'paid', key);
    state.lastDeviceStatus = null;
    state.lastDeviceStatusAt = 0;
    return status();
  }

  async function startTrial() {
    try {
      const data = await request('/api/trial', { deviceId: deviceId(), appVersion });
      save(data, 'trial', null);
      return status();
    } catch (error) {
      if (error.code === 'TRIAL_USED' || error.code === 'TRIAL_EXPIRED') {
        state.trialUsedDay = dayStamp();
        state.lastDeviceStatus = { ...(state.lastDeviceStatus || {}), trialAvailableToday: false };
        state.lastDeviceStatusAt = Date.now();
      }
      throw error;
    }
  }

  async function deviceStatus() {
    const data = await refreshDeviceStatus();
    return data ? { ...status(), trialAvailableToday: Boolean(data.trialAvailableToday) } : status();
  }

  async function check() {
    const result = await sync();
    return {
      activated: result.activated,
      reason: result.reason,
      deviceId: result.deviceId,
      deviceShort: result.deviceShort
    };
  }

  return {
    status,
    sync,
    activate,
    startTrial,
    deviceStatus,
    check,
    clearCache,
    filePath,
    serverUrl,
    deviceId,
    shortDeviceId
  };
}

module.exports = {
  LICENSE_PUBLIC_JWK,
  DEFAULT_SERVER,
  DEFAULT_GRACE_DAYS,
  TRIAL_MINUTES,
  PLAN_LABELS,
  deviceId,
  shortDeviceId,
  normalizeKey,
  formatKeyInput,
  createStore
};
