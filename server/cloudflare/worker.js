// hotanvoice license server - Cloudflare Worker (chạy 24/7, miễn phí).
//
// Bindings:
//   KV namespace  HTV
// Secrets (Workers > Settings > Variables):
//   ADMIN_TOKEN      chuỗi ngẫu nhiên dài (giống config Node)
//   LICENSE_SECRET   secret ký KEY (giống keygen)
//   PRIVATE_JWK      JSON private key ECDSA P-256 (lấy trong server\node\config.json)
// Vars tùy chọn:
//   GRACE_DAYS=7, TRIAL_MINUTES=10
//
// Xem DEPLOY.md để biết cách deploy.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PLAN_LABELS = { P: 'Cá nhân', S: 'Studio', C: 'Thương mại', T: 'Dùng thử' };
const PERPETUAL = '000000';
const TRIAL_KEY = 'HTV1-TRIAL-10MIN';
const TRIAL_KEY_NORMALIZED = 'HTV1TRIAL10MIN';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const enc = new TextEncoder();

/* ------------------------------ helpers ------------------------------ */
function base32(bytes, length) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
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

function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function normalizeKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

function dayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function todayCode(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year').slice(-2)}${get('month')}${get('day')}`;
}

function expiryEndMs(expires) {
  if (!expires || expires === PERPETUAL) return Number.MAX_SAFE_INTEGER;
  const value = String(expires);
  if (!/^\d{6}$/u.test(value)) return 0;
  const startUtc = Date.UTC(2000 + Number(value.slice(0, 2)), Number(value.slice(2, 4)) - 1, Number(value.slice(4, 6))) - 7 * 3600 * 1000;
  return startUtc + 24 * 3600 * 1000 - 1;
}

async function hmacBase32(secret, payload, length) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(String(payload))));
  return base32(signature, length);
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deviceCode(secret, deviceId) {
  return hmacBase32(secret, `device:${deviceId}`, 8);
}

async function makeKey(secret, deviceId, expires = PERPETUAL, plan = 'P') {
  const expiry = String(expires || PERPETUAL).replace(/[^0-9]/gu, '').slice(0, 6).padEnd(6, '0');
  const planCode = String(plan || 'P').toUpperCase().slice(0, 1);
  if (!PLAN_LABELS[planCode] || planCode === 'T') throw new Error('Plan không hợp lệ (P/S/C).');
  const payload = `${await deviceCode(secret, deviceId)}${expiry}${planCode}`;
  const signature = await hmacBase32(secret, `key:${payload}`, 10);
  const body = `${payload}${signature}`;
  return `HTV1-${(body.match(/.{1,5}/gu) || []).join('-')}`;
}

async function inspectKey(secret, value, deviceId) {
  const normalized = normalizeKey(value);
  if (normalized === TRIAL_KEY_NORMALIZED) return { valid: false, reason: 'Đây là KEY dùng thử. Hãy bấm nút "Dùng thử 10 phút".' };
  if (!normalized.startsWith('HTV1')) return { valid: false, reason: 'KEY phải bắt đầu bằng HTV1.' };
  const body = normalized.slice(4);
  if (body.length !== 25) return { valid: false, reason: 'Độ dài KEY không đúng.' };
  if (![...body].every((char) => ALPHABET.includes(char))) return { valid: false, reason: 'KEY chứa ký tự không hợp lệ.' };
  const dev = body.slice(0, 8);
  const expires = body.slice(8, 14);
  const plan = body.slice(14, 15);
  const signature = body.slice(15);
  if (dev !== await deviceCode(secret, deviceId)) return { valid: false, reason: 'KEY được cấp cho thiết bị khác.' };
  if (!PLAN_LABELS[plan] || plan === 'T') return { valid: false, reason: 'Loại license không hợp lệ.' };
  if (expires !== PERPETUAL) {
    if (!/^\d{6}$/u.test(expires)) return { valid: false, reason: 'Ngày hết hạn không hợp lệ.' };
    if (expires < todayCode()) return { valid: false, reason: 'KEY đã hết hạn.' };
  }
  const expected = await hmacBase32(secret, `key:${dev}${expires}${plan}`, 10);
  if (expected !== signature) return { valid: false, reason: 'Chữ ký KEY không hợp lệ.' };
  return { valid: true, reason: 'License hợp lệ.', expires, plan, planLabel: PLAN_LABELS[plan] };
}

async function signLease(privateJwk, payload) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = enc.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return `${b64url(data)}.${b64url(signature)}`;
}

async function buildLease(env, { deviceId, plan, licenseExpires, trial, trialUntil }) {
  const now = Date.now();
  const graceDays = Number(env.GRACE_DAYS || 7);
  let validUntil = now + graceDays * 24 * 3600 * 1000;
  if (trial) validUntil = Number(trialUntil) || now;
  else if (licenseExpires !== PERPETUAL) validUntil = Math.min(validUntil, expiryEndMs(licenseExpires));
  const payload = {
    v: 1,
    dev: deviceId,
    plan,
    licenseExpires: trial ? 'TRIAL' : licenseExpires,
    trial: Boolean(trial),
    trialUntil: trial ? Number(trialUntil) : null,
    graceDays,
    trialMinutes: Number(env.TRIAL_MINUTES || 10),
    issuedAt: now,
    validUntil
  };
  return signLease(JSON.parse(env.PRIVATE_JWK), payload);
}

/* -------------------------------- store -------------------------------- */
const getJson = async (env, key) => env.HTV.get(key, 'json');
const putJson = async (env, key, value) => env.HTV.put(key, JSON.stringify(value));
const del = async (env, key) => env.HTV.delete(key);

async function isRevoked(env, key, deviceId) {
  const keyHash = await sha256Hex(normalizeKey(key || ''));
  const byKey = await getJson(env, `revoked:key:${keyHash}`);
  if (byKey) return true;
  const byDevice = await getJson(env, `revoked:dev:${deviceId}`);
  return Boolean(byDevice);
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
}

/* ------------------------------ responses ------------------------------ */
function send(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
const fail = (status, message, code) => send(status, { ok: false, error: message, code: code || `HTTP_${status}` });
const isDeviceId = (value) => /^[a-f0-9]{64}$/u.test(String(value || '').toLowerCase());

// So sánh chuỗi theo thời gian hằng định để tránh lộ token qua timing.
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function licensePayload(env, plan, expires, trial = false) {
  return {
    plan,
    planLabel: PLAN_LABELS[plan] || plan,
    expires,
    trial,
    graceDays: Number(env.GRACE_DAYS || 7),
    serverTime: Date.now()
  };
}

async function upsertLicense(env, request, deviceId, key, plan, expires, appVersion) {
  const previous = await getJson(env, `lic:${deviceId}`);
  const now = new Date().toISOString();
  await putJson(env, `lic:${deviceId}`, {
    deviceId,
    key: normalizeKey(key),
    plan,
    planLabel: PLAN_LABELS[plan],
    expires,
    activatedAt: previous?.activatedAt || now,
    lastSeenAt: now,
    ip: clientIp(request),
    appVersion: String(appVersion || previous?.appVersion || '').slice(0, 40)
  });
}

/* ------------------------------- routes ------------------------------- */
async function handlePublic(env, request, url, body) {
  const route = url.pathname;

  if (route === '/api/health' && request.method === 'GET') {
    return send(200, {
      ok: true,
      name: 'hotanvoice-license',
      runtime: 'cloudflare-worker',
      time: Date.now(),
      graceDays: Number(env.GRACE_DAYS || 7),
      trialMinutes: Number(env.TRIAL_MINUTES || 10)
    });
  }

  if (route === '/api/status' && request.method === 'GET') {
    const deviceId = String(url.searchParams.get('deviceId') || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    const record = await getJson(env, `trial:${deviceId}`);
    const today = dayStamp();
    const usedToday = record?.day === today;
    const active = usedToday && Number(record.until) > Date.now();
    return send(200, {
      ok: true,
      time: Date.now(),
      trialMinutes: Number(env.TRIAL_MINUTES || 10),
      graceDays: Number(env.GRACE_DAYS || 7),
      trialAvailableToday: !usedToday,
      trialActive: active,
      trialUntil: active ? record.until : null
    });
  }

  if (route === '/api/activate' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    const inspected = await inspectKey(env.LICENSE_SECRET, body.key, deviceId);
    if (!inspected.valid) return fail(403, inspected.reason, 'BAD_KEY');
    if (await isRevoked(env, body.key, deviceId)) return fail(403, 'KEY đã bị thu hồi. Liên hệ quản trị viên.', 'REVOKED');
    await upsertLicense(env, request, deviceId, body.key, inspected.plan, inspected.expires, body.appVersion);
    return send(200, {
      ok: true,
      kind: 'paid',
      lease: await buildLease(env, { deviceId, plan: inspected.plan, licenseExpires: inspected.expires, trial: false, trialUntil: null }),
      license: licensePayload(env, inspected.plan, inspected.expires),
      reason: inspected.reason
    });
  }

  if (route === '/api/trial' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    const record = await getJson(env, `trial:${deviceId}`);
    const today = dayStamp();
    const now = Date.now();

    if (record?.day === today) {
      if (Number(record.until) > now) {
        return send(200, {
          ok: true,
          kind: 'trial',
          reused: true,
          lease: await buildLease(env, { deviceId, plan: 'T', licenseExpires: 'TRIAL', trial: true, trialUntil: record.until }),
          license: licensePayload(env, 'T', 'TRIAL', true),
          trialUntil: record.until
        });
      }
      return fail(409, 'Hôm nay bạn đã dùng bản dùng thử. Vui lòng nhập KEY để tiếp tục.', 'TRIAL_USED');
    }

    const until = now + Number(env.TRIAL_MINUTES || 10) * 60 * 1000;
    await putJson(env, `trial:${deviceId}`, {
      day: today,
      startedAt: new Date(now).toISOString(),
      until,
      lastSeenAt: new Date(now).toISOString(),
      ip: clientIp(request)
    });
    return send(200, {
      ok: true,
      kind: 'trial',
      reused: false,
      lease: await buildLease(env, { deviceId, plan: 'T', licenseExpires: 'TRIAL', trial: true, trialUntil: until }),
      license: licensePayload(env, 'T', 'TRIAL', true),
      trialUntil: until
    });
  }

  if (route === '/api/session' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');

    if (body.trial) {
      const record = await getJson(env, `trial:${deviceId}`);
      const now = Date.now();
      if (!record || record.day !== dayStamp()) return fail(401, 'Phiên dùng thử đã hết hạn.', 'TRIAL_EXPIRED');
      if (Number(record.until) <= now) return fail(401, 'Bản dùng thử 10 phút đã hết. Nhập KEY để tiếp tục sử dụng.', 'TRIAL_EXPIRED');
      return send(200, {
        ok: true,
        kind: 'trial',
        lease: await buildLease(env, { deviceId, plan: 'T', licenseExpires: 'TRIAL', trial: true, trialUntil: record.until }),
        license: licensePayload(env, 'T', 'TRIAL', true),
        trialUntil: record.until,
        serverTime: now
      });
    }

    const inspected = await inspectKey(env.LICENSE_SECRET, body.key, deviceId);
    if (!inspected.valid) return fail(403, inspected.reason, 'BAD_KEY');
    if (await isRevoked(env, body.key, deviceId)) return fail(403, 'KEY đã bị thu hồi. Liên hệ quản trị viên.', 'REVOKED');
    await upsertLicense(env, request, deviceId, body.key, inspected.plan, inspected.expires, body.appVersion);
    return send(200, {
      ok: true,
      kind: 'paid',
      lease: await buildLease(env, { deviceId, plan: inspected.plan, licenseExpires: inspected.expires, trial: false, trialUntil: null }),
      license: licensePayload(env, inspected.plan, inspected.expires),
      reason: inspected.reason,
      serverTime: Date.now()
    });
  }

  return fail(404, 'Không tìm thấy API.', 'NOT_FOUND');
}

async function handleAdmin(env, request, url, body) {
  const expected = String(env.ADMIN_TOKEN || '').trim();
  // Fail closed: nếu chưa cấu hình ADMIN_TOKEN thì khóa toàn bộ API quản trị.
  if (!expected) return fail(503, 'Worker chưa cấu hình ADMIN_TOKEN.', 'ADMIN_DISABLED');

  const auth = request.headers.get('authorization') || '';
  const token = (
    request.headers.get('x-admin-token') ||
    (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '')
  ).trim();

  if (!safeEqual(token, expected)) return fail(401, 'Sai admin token.', 'UNAUTHORIZED');
  const route = url.pathname;

  if (route === '/api/admin/issue' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    const plan = String(body.plan || 'P').toUpperCase().slice(0, 1);
    if (!['P', 'S', 'C'].includes(plan)) return fail(400, 'Plan phải là P, S hoặc C.', 'BAD_PLAN');
    let expires = String(body.expires || PERPETUAL).replace(/[^0-9]/gu, '');
    if (!expires) expires = PERPETUAL;
    if (expires !== PERPETUAL && !/^\d{6}$/u.test(expires)) return fail(400, 'Hạn dùng phải là YYMMDD hoặc 000000.', 'BAD_EXPIRY');
    const key = await makeKey(env.LICENSE_SECRET, deviceId, expires, plan);
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      deviceId,
      plan,
      planLabel: PLAN_LABELS[plan],
      expires,
      note: String(body.note || '').trim().slice(0, 80),
      key
    };
    await putJson(env, `issued:${record.createdAt}:${record.id}`, record);
    return send(200, { ok: true, record });
  }

  if (route === '/api/admin/licenses' && request.method === 'GET') {
    const list = await env.HTV.list({ prefix: 'lic:' });
    const devices = [];
    for (const item of list.keys) {
      const record = await getJson(env, item.name);
      if (record) devices.push(record);
    }
    const trialList = await env.HTV.list({ prefix: 'trial:' });
    const trials = [];
    for (const item of trialList.keys) {
      const record = await getJson(env, item.name);
      if (record) trials.push({ deviceId: item.name.slice(6), ...record });
    }
    return send(200, { ok: true, time: Date.now(), devices, trials });
  }

  if (route === '/api/admin/revoke' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    const key = normalizeKey(body.key || '');
    if (!isDeviceId(deviceId) && !key) return fail(400, 'Cần deviceId hoặc key.', 'BAD_INPUT');
    const info = { reason: String(body.reason || '').slice(0, 120), at: new Date().toISOString() };
    if (key) await putJson(env, `revoked:key:${await sha256Hex(key)}`, info);
    if (deviceId) await putJson(env, `revoked:dev:${deviceId}`, info);
    return send(200, { ok: true });
  }

  if (route === '/api/admin/unrevoke' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    const key = normalizeKey(body.key || '');
    if (key) await del(env, `revoked:key:${await sha256Hex(key)}`);
    if (deviceId) await del(env, `revoked:dev:${deviceId}`);
    return send(200, { ok: true });
  }

  if (route === '/api/admin/trial-reset' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    await del(env, `trial:${deviceId}`);
    return send(200, { ok: true });
  }

  if (route === '/api/admin/trial-expire' && request.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) return fail(400, 'Device ID không hợp lệ.', 'BAD_DEVICE');
    const record = await getJson(env, `trial:${deviceId}`);
    if (record) {
      record.until = Date.now() - 1000;
      await putJson(env, `trial:${deviceId}`, record);
    }
    return send(200, { ok: true });
  }

  return fail(404, 'Không tìm thấy API quản trị.', 'NOT_FOUND');
}

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const item = buckets.get(ip);
  if (!item || now > item.reset) {
    buckets.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  item.count += 1;
  return item.count > 120;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAdmin = url.pathname.startsWith('/api/admin/');
    if (!isAdmin) {
      const ip = clientIp(request);
      if (rateLimited(ip)) return fail(429, 'Quá nhiều yêu cầu. Thử lại sau.', 'RATE_LIMIT');
    }
    try {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      return isAdmin
        ? await handleAdmin(env, request, url, body)
        : await handlePublic(env, request, url, body);
    } catch (error) {
      return fail(400, error.message || 'Yêu cầu không hợp lệ.', 'BAD_REQUEST');
    }
  }
};
