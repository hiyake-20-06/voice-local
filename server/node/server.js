'use strict';

// hotanvoice license server (Node.js, không cần thư viện ngoài).
//
// Chạy:    node server.js
// Test:    curl http://127.0.0.1:8787/api/health
// Cấu hình: config.json (port, adminToken, licenseSecret, privateJwk, graceDays...)
//
// Có thể đưa ra Internet bằng Cloudflare Tunnel:
//   cloudflared tunnel --url http://127.0.0.1:8787
// hoặc chạy trên VPS + HTTPS (Caddy/Nginx).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./lib/core');

const SERVER_DIR = __dirname;
const VERSION = '1.0.0';

function loadConfig() {
  const file = path.join(SERVER_DIR, 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Không đọc được ${file}: ${error.message}`);
  }
  return {
    port: Number(process.env.PORT || config.port || 8787),
    host: process.env.HOST || config.host || '0.0.0.0',
    publicUrl: process.env.HOTANVOICE_PUBLIC_URL || config.publicUrl || '',
    adminToken: process.env.HOTANVOICE_ADMIN_TOKEN || config.adminToken,
    licenseSecret: process.env.HOTANVOICE_LICENSE_SECRET || config.licenseSecret,
    privateJwk: config.privateJwk,
    graceDays: Number(process.env.HOTANVOICE_GRACE_DAYS || config.graceDays || 7),
    trialMinutes: Number(config.trialMinutes || 10),
    dataDir: path.resolve(SERVER_DIR, config.dataDir || 'data')
  };
}

const config = loadConfig();
if (!config.adminToken || config.adminToken.length < 16) throw new Error('adminToken quá ngắn. Sửa config.json.');
if (!config.licenseSecret || config.licenseSecret.length < 16) throw new Error('licenseSecret quá ngắn. Sửa config.json.');
if (!config.privateJwk?.d) throw new Error('Thiếu privateJwk trong config.json.');

const FILES = {
  licenses: path.join(config.dataDir, 'licenses.json'),
  trials: path.join(config.dataDir, 'trials.json'),
  revoked: path.join(config.dataDir, 'revoked.json'),
  issued: path.join(config.dataDir, 'issued.json')
};
fs.mkdirSync(config.dataDir, { recursive: true });

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// Ghi tuần tự để tránh 2 request ghi đè nhau.
let writeQueue = Promise.resolve();
function update(file, fallback, mutator) {
  const run = async () => {
    const data = readJson(file, fallback);
    const result = mutator(data);
    writeJson(file, data);
    return result;
  };
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => {});
  return next;
}

const licensesShape = () => ({ version: 1, devices: {} });
const trialsShape = () => ({ version: 1, devices: {} });
const revokedShape = () => ({ version: 1, keys: {}, devices: {} });
const issuedShape = () => ({ version: 1, items: [] });

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isDeviceId(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || '').toLowerCase());
}
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

// Giới hạn đơn giản: 120 request/phút/IP cho API công khai.
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

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}
function fail(res, status, message, code) {
  send(res, status, { ok: false, error: message, code: code || `HTTP_${status}` });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error('Body quá lớn.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON không hợp lệ.')); }
    });
    req.on('error', reject);
  });
}

function isRevoked(revoked, key, deviceId) {
  const keyHash = sha256(core.normalizeKey(key || ''));
  return Boolean(revoked.keys[keyHash] || revoked.devices[deviceId]);
}

function leaseFor(deviceId, plan, licenseExpires) {
  return core.buildLease(config.privateJwk, {
    deviceId,
    plan,
    licenseExpires,
    trial: false,
    trialUntil: null,
    graceDays: config.graceDays,
    trialMinutes: config.trialMinutes
  }).token;
}
function trialLeaseFor(deviceId, until) {
  return core.buildLease(config.privateJwk, {
    deviceId,
    plan: 'T',
    licenseExpires: 'TRIAL',
    trial: true,
    trialUntil: until,
    graceDays: config.graceDays,
    trialMinutes: config.trialMinutes
  }).token;
}

function licensePayload(deviceId, plan, expires, trial = false) {
  const label = core.PLAN_LABELS[plan] || plan;
  return {
    plan,
    planLabel: label,
    expires,
    trial,
    graceDays: config.graceDays,
    serverTime: Date.now()
  };
}

function upsertLicense(deviceId, key, plan, expires, req, appVersion) {
  return update(FILES.licenses, licensesShape(), (data) => {
    const now = new Date().toISOString();
    const previous = data.devices[deviceId];
    data.devices[deviceId] = {
      deviceId,
      key: core.normalizeKey(key),
      plan,
      planLabel: core.PLAN_LABELS[plan],
      expires,
      activatedAt: previous?.activatedAt || now,
      lastSeenAt: now,
      ip: clientIp(req),
      appVersion: String(appVersion || previous?.appVersion || '').slice(0, 40)
    };
    return data.devices[deviceId];
  });
}

function touchTrial(deviceId, req) {
  return update(FILES.trials, trialsShape(), (data) => {
    const record = data.devices[deviceId];
    if (record) record.lastSeenAt = new Date().toISOString();
    return record;
  });
}

async function handlePublic(req, res, url, body) {
  const route = url.pathname;

  if (route === '/api/health' && req.method === 'GET') {
    send(res, 200, {
      ok: true,
      name: 'hotanvoice-license',
      version: VERSION,
      time: Date.now(),
      graceDays: config.graceDays,
      trialMinutes: config.trialMinutes
    });
    return;
  }

  if (route === '/api/status' && req.method === 'GET') {
    const deviceId = String(url.searchParams.get('deviceId') || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }
    const trials = readJson(FILES.trials, trialsShape());
    const record = trials.devices[deviceId];
    const today = core.dayStamp();
    const usedToday = record?.day === today;
    const active = usedToday && Number(record.until) > Date.now();
    send(res, 200, {
      ok: true,
      time: Date.now(),
      trialMinutes: config.trialMinutes,
      graceDays: config.graceDays,
      trialAvailableToday: !usedToday,
      trialActive: active,
      trialUntil: active ? record.until : null
    });
    return;
  }

  if (route === '/api/activate' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }
    const inspected = core.inspectKey(config.licenseSecret, body.key, deviceId);
    if (!inspected.valid) { fail(res, 403, inspected.reason, 'BAD_KEY'); return; }
    const revoked = readJson(FILES.revoked, revokedShape());
    if (isRevoked(revoked, body.key, deviceId)) { fail(res, 403, 'KEY đã bị thu hồi. Liên hệ quản trị viên.', 'REVOKED'); return; }
    await upsertLicense(deviceId, body.key, inspected.plan, inspected.expires, req, body.appVersion);
    send(res, 200, {
      ok: true,
      kind: 'paid',
      lease: leaseFor(deviceId, inspected.plan, inspected.expires),
      license: licensePayload(deviceId, inspected.plan, inspected.expires),
      reason: inspected.reason
    });
    return;
  }

  if (route === '/api/trial' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }

    const trials = readJson(FILES.trials, trialsShape());
    const record = trials.devices[deviceId];
    const today = core.dayStamp();
    const now = Date.now();

    if (record?.day === today) {
      if (Number(record.until) > now) {
        // Đang trong 10 phút: trả lại phiên cũ để vào tiếp, không cộng thêm giờ.
        touchTrial(deviceId, req).catch(() => {});
        send(res, 200, {
          ok: true,
          kind: 'trial',
          reused: true,
          lease: trialLeaseFor(deviceId, record.until),
          license: licensePayload(deviceId, 'T', 'TRIAL', true),
          trialUntil: record.until
        });
        return;
      }
      fail(res, 409, 'Hôm nay bạn đã dùng bản dùng thử. Vui lòng nhập KEY để tiếp tục.', 'TRIAL_USED');
      return;
    }

    const until = now + config.trialMinutes * 60 * 1000;
    await update(FILES.trials, trialsShape(), (data) => {
      data.devices[deviceId] = {
        day: today,
        startedAt: new Date(now).toISOString(),
        until,
        lastSeenAt: new Date(now).toISOString(),
        ip: clientIp(req)
      };
      return data.devices[deviceId];
    });
    send(res, 200, {
      ok: true,
      kind: 'trial',
      reused: false,
      lease: trialLeaseFor(deviceId, until),
      license: licensePayload(deviceId, 'T', 'TRIAL', true),
      trialUntil: until
    });
    return;
  }

  if (route === '/api/session' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }

    if (body.trial) {
      const trials = readJson(FILES.trials, trialsShape());
      const record = trials.devices[deviceId];
      const now = Date.now();
      if (!record || record.day !== core.dayStamp()) { fail(res, 401, 'Phiên dùng thử đã hết hạn.', 'TRIAL_EXPIRED'); return; }
      if (Number(record.until) <= now) { fail(res, 401, 'Bản dùng thử 10 phút đã hết. Nhập KEY để tiếp tục sử dụng.', 'TRIAL_EXPIRED'); return; }
      touchTrial(deviceId, req).catch(() => {});
      send(res, 200, {
        ok: true,
        kind: 'trial',
        lease: trialLeaseFor(deviceId, record.until),
        license: licensePayload(deviceId, 'T', 'TRIAL', true),
        trialUntil: record.until,
        serverTime: now
      });
      return;
    }

    const inspected = core.inspectKey(config.licenseSecret, body.key, deviceId);
    if (!inspected.valid) { fail(res, 403, inspected.reason, 'BAD_KEY'); return; }
    const revoked = readJson(FILES.revoked, revokedShape());
    if (isRevoked(revoked, body.key, deviceId)) { fail(res, 403, 'KEY đã bị thu hồi. Liên hệ quản trị viên.', 'REVOKED'); return; }
    await upsertLicense(deviceId, body.key, inspected.plan, inspected.expires, req, body.appVersion);
    send(res, 200, {
      ok: true,
      kind: 'paid',
      lease: leaseFor(deviceId, inspected.plan, inspected.expires),
      license: licensePayload(deviceId, inspected.plan, inspected.expires),
      reason: inspected.reason,
      serverTime: Date.now()
    });
    return;
  }

  fail(res, 404, 'Không tìm thấy API.', 'NOT_FOUND');
}

async function handleAdmin(req, res, url, body) {
  const token = req.headers['x-admin-token'];
  if (!safeEqual(token, config.adminToken)) { fail(res, 401, 'Sai admin token.', 'UNAUTHORIZED'); return; }

  const route = url.pathname;

  if (route === '/api/admin/issue' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }
    const plan = String(body.plan || 'P').toUpperCase().slice(0, 1);
    if (!['P', 'S', 'C'].includes(plan)) { fail(res, 400, 'Plan phải là P, S hoặc C.', 'BAD_PLAN'); return; }
    let expires = String(body.expires || core.PERPETUAL).replace(/[^0-9]/gu, '');
    if (!expires) expires = core.PERPETUAL;
    if (expires !== core.PERPETUAL && !/^\d{6}$/u.test(expires)) { fail(res, 400, 'Hạn dùng phải là YYMMDD hoặc 000000.', 'BAD_EXPIRY'); return; }
    const key = core.makeKey(config.licenseSecret, deviceId, expires, plan);
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      deviceId,
      plan,
      planLabel: core.PLAN_LABELS[plan],
      expires,
      note: String(body.note || '').trim().slice(0, 80),
      key
    };
    await update(FILES.issued, issuedShape(), (data) => {
      data.items.unshift(record);
      data.items = data.items.slice(0, 1000);
      return data.items;
    });
    send(res, 200, { ok: true, record });
    return;
  }

  if (route === '/api/admin/licenses' && req.method === 'GET') {
    const licenses = readJson(FILES.licenses, licensesShape());
    const trials = readJson(FILES.trials, trialsShape());
    const revoked = readJson(FILES.revoked, revokedShape());
    send(res, 200, {
      ok: true,
      time: Date.now(),
      devices: Object.values(licenses.devices || {}),
      trials: Object.values(trials.devices || {}),
      revoked
    });
    return;
  }

  if (route === '/api/admin/revoke' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    const key = core.normalizeKey(body.key || '');
    if (!isDeviceId(deviceId) && !key) { fail(res, 400, 'Cần deviceId hoặc key.', 'BAD_INPUT'); return; }
    const info = { reason: String(body.reason || '').slice(0, 120), at: new Date().toISOString() };
    await update(FILES.revoked, revokedShape(), (data) => {
      if (key) data.keys[sha256(key)] = info;
      if (deviceId) data.devices[deviceId] = info;
      return data;
    });
    if (deviceId) {
      await update(FILES.licenses, licensesShape(), (data) => {
        if (data.devices[deviceId]) data.devices[deviceId].revokedAt = info.at;
        return data;
      });
    }
    send(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/unrevoke' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    const key = core.normalizeKey(body.key || '');
    await update(FILES.revoked, revokedShape(), (data) => {
      if (key) delete data.keys[sha256(key)];
      if (deviceId) delete data.devices[deviceId];
      return data;
    });
    if (deviceId) {
      await update(FILES.licenses, licensesShape(), (data) => {
        if (data.devices[deviceId]) delete data.devices[deviceId].revokedAt;
        return data;
      });
    }
    send(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/trial-reset' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }
    await update(FILES.trials, trialsShape(), (data) => {
      delete data.devices[deviceId];
      return data;
    });
    send(res, 200, { ok: true });
    return;
  }

  if (route === '/api/admin/trial-expire' && req.method === 'POST') {
    const deviceId = String(body.deviceId || '').toLowerCase();
    if (!isDeviceId(deviceId)) { fail(res, 400, 'Device ID không hợp lệ.', 'BAD_DEVICE'); return; }
    await update(FILES.trials, trialsShape(), (data) => {
      if (data.devices[deviceId]) data.devices[deviceId].until = Date.now() - 1000;
      return data;
    });
    send(res, 200, { ok: true });
    return;
  }

  fail(res, 404, 'Không tìm thấy API quản trị.', 'NOT_FOUND');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { fail(res, 400, 'URL không hợp lệ.'); return; }

  const ip = clientIp(req);
  const isAdmin = url.pathname.startsWith('/api/admin/');

  if (!isAdmin && rateLimited(ip)) { fail(res, 429, 'Quá nhiều yêu cầu. Thử lại sau.', 'RATE_LIMIT'); return; }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (isAdmin) await handleAdmin(req, res, url, body);
    else await handlePublic(req, res, url, body);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname} ${ip} -> ${error.message}`);
    if (!res.headersSent) fail(res, 400, error.message || 'Yêu cầu không hợp lệ.', 'BAD_REQUEST');
  } finally {
    if (url.pathname !== '/api/health') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname} ${ip} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log('hotanvoice license server ' + VERSION);
  console.log(`  nghe:     http://${config.host}:${config.port}`);
  console.log(`  dữ liệu:  ${config.dataDir}`);
  console.log(`  grace:    ${config.graceDays} ngày (KEY trả phí)`);
  console.log(`  trial:    ${config.trialMinutes} phút/ngày`);
  if (config.publicUrl) console.log(`  public:   ${config.publicUrl}`);
});

function shutdown() {
  console.log('Đang dừng server...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
