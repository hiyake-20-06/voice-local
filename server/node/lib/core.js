'use strict';

// hotanvoice license server - lõi dùng chung cho Node server.
// KEY vẫn là HMAC-SHA256 (giống keygen), nhưng chỉ server giữ secret.
// Lease cấp cho app được ký ECDSA P-256; app chỉ có public key.

const crypto = require('crypto');

const PREFIX = 'HTV1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PLAN_LABELS = { P: 'Cá nhân', S: 'Studio', C: 'Thương mại', T: 'Dùng thử' };
const PERPETUAL = '000000';
const TRIAL_KEY = 'HTV1-TRIAL-10MIN';
const TRIAL_KEY_NORMALIZED = 'HTV1TRIAL10MIN';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';

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

function normalizeKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function isTrialKey(value) {
  return normalizeKey(value) === TRIAL_KEY_NORMALIZED;
}

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(String(payload)).digest();
}

function deviceCode(secret, deviceId) {
  return base32(hmac(secret, `device:${deviceId}`), 8);
}

function dayParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dayStamp(date = new Date()) {
  const { year, month, day } = dayParts(date);
  return `${year}-${month}-${day}`;
}

function todayCode(date = new Date()) {
  const { year, month, day } = dayParts(date);
  return `${year.slice(-2)}${month}${day}`;
}

// Hết hạn cuối ngày YYMMDD theo giờ Việt Nam.
function expiryEndMs(expires) {
  if (!expires || expires === PERPETUAL) return Number.MAX_SAFE_INTEGER;
  const value = String(expires);
  if (!/^\d{6}$/u.test(value)) return 0;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const startUtc = Date.UTC(year, month - 1, day) - 7 * 3600 * 1000;
  return startUtc + 24 * 3600 * 1000 - 1;
}

function makeKey(secret, deviceId, expires = PERPETUAL, plan = 'P') {
  const expiry = String(expires || PERPETUAL).replace(/[^0-9]/gu, '').slice(0, 6).padEnd(6, '0');
  const planCode = String(plan || 'P').toUpperCase().slice(0, 1);
  if (!PLAN_LABELS[planCode] || planCode === 'T') throw new Error('Plan không hợp lệ (P/S/C).');
  const payload = `${deviceCode(secret, deviceId)}${expiry}${planCode}`;
  const signature = base32(hmac(secret, `key:${payload}`), 10);
  return `${PREFIX}-${(`${payload}${signature}`.match(/.{1,5}/gu) || []).join('-')}`;
}

function inspectKey(secret, value, deviceId) {
  const normalized = normalizeKey(value);
  if (isTrialKey(normalized)) return { valid: false, trial: true, reason: 'Đây là KEY dùng thử. Hãy bấm nút "Dùng thử 10 phút".' };
  if (!normalized.startsWith(PREFIX)) return { valid: false, reason: 'KEY phải bắt đầu bằng HTV1.' };
  const body = normalized.slice(PREFIX.length);
  if (body.length !== 25) return { valid: false, reason: 'Độ dài KEY không đúng.' };
  if (![...body].every((char) => ALPHABET.includes(char))) return { valid: false, reason: 'KEY chứa ký tự không hợp lệ.' };
  const dev = body.slice(0, 8);
  const expires = body.slice(8, 14);
  const plan = body.slice(14, 15);
  const signature = body.slice(15);
  if (dev !== deviceCode(secret, deviceId)) return { valid: false, reason: 'KEY được cấp cho thiết bị khác.' };
  if (!PLAN_LABELS[plan] || plan === 'T') return { valid: false, reason: 'Loại license không hợp lệ.' };
  if (expires !== PERPETUAL) {
    if (!/^\d{6}$/u.test(expires)) return { valid: false, reason: 'Ngày hết hạn không hợp lệ.' };
    if (expires < todayCode()) return { valid: false, reason: 'KEY đã hết hạn.' };
  }
  const expected = base32(hmac(secret, `key:${dev}${expires}${plan}`), 10);
  const left = Buffer.from(signature, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { valid: false, reason: 'Chữ ký KEY không hợp lệ.' };
  return { valid: true, reason: 'License hợp lệ.', expires, plan, planLabel: PLAN_LABELS[plan] };
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

// Ký lease bằng ECDSA P-256, chữ ký dạng IEEE P1363 (r||s) để WebCrypto đọc được.
function signLease(privateJwk, payload) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  return `${b64url(data)}.${b64url(signature)}`;
}

function buildLease(privateJwk, { deviceId, plan, licenseExpires, trial, trialUntil, graceDays, trialMinutes }) {
  const now = Date.now();
  let validUntil = now + (Number(graceDays) || 7) * 24 * 3600 * 1000;
  if (trial) {
    validUntil = Number(trialUntil) || now;
  } else if (licenseExpires !== PERPETUAL) {
    validUntil = Math.min(validUntil, expiryEndMs(licenseExpires));
  }
  const payload = {
    v: 1,
    dev: deviceId,
    plan,
    licenseExpires: trial ? 'TRIAL' : licenseExpires,
    trial: Boolean(trial),
    trialUntil: trial ? Number(trialUntil) : null,
    graceDays: Number(graceDays) || 7,
    trialMinutes: Number(trialMinutes) || 10,
    issuedAt: now,
    validUntil
  };
  return { token: signLease(privateJwk, payload), payload };
}

module.exports = {
  PREFIX, ALPHABET, PLAN_LABELS, PERPETUAL, TRIAL_KEY, TRIAL_KEY_NORMALIZED, TIME_ZONE,
  base32, normalizeKey, isTrialKey, deviceCode, dayStamp, todayCode, expiryEndMs,
  makeKey, inspectKey, buildLease, signLease, b64url
};
