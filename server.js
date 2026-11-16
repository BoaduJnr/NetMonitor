// Home Network Monitor - local web server.
// Serves the dashboard at http://localhost:8765/ (this PC only) and runs network scans.
// Shuts itself down a few minutes after the dashboard window is closed.
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Router } = require('./router');
const { Fibre } = require('./fibre');
const { DRIVERS, detect, RouterStore } = require('./routers');
const pcWifi = require('./pcwifi');
const { Assistant } = require('./ai');
const { buildTools } = require('./ai-tools');

const PORT = 8765;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const APP_DIR = path.join(process.env.APPDATA || ROOT, 'Home Network Monitor');
const DATA_FILE = path.join(APP_DIR, 'data.json');
const ONT_MIN_AGE_MS = 2 * 60 * 1000; // don't log in to a fibre router more often than this
// Stop this long after the dashboard last checked in. Long enough that a background tab that Edge
// slows down, or a short sleep, doesn't stop the monitor under an open window.
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const LOG_FILE = path.join(APP_DIR, 'server.log');
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'dev'; }
})();

// A short log of starts, stops and errors (kept under ~200 KB).
function log(line) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 200 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`);
  } catch { /* logging must never break the server */ }
}
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const PRIVATE_IPV4 = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/renderer.js': ['renderer.js', 'text/javascript; charset=utf-8'],
  '/web-bridge.js': ['web-bridge.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/icon.ico': ['icon.ico', 'image/x-icon']
};

let lastActivity = Date.now();
let scanInFlight = null;
let lastScanResult = null; // shared with the AI assistant

function writeJsonAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

const store = new RouterStore(APP_DIR);

// Is something listening on host:port right now? (Tells us whether the PC is on that router's network.)
function reachable(host, port = 80, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function clientOf(id, kind) {
  const r = store.get(id);
  const d = DRIVERS[r.driver];
  if (!d || d.kind !== kind || !d.supported) throw new Error(`The router "${r.name}" doesn't support this.`);
  return store.client(id);
}

// Any fibre check that has moved this PC's Wi-Fi to another network.
const anySwitching = () => store.routers.some((r) => { const c = store.clients.get(r.id); return c && c.switching; });

// ---------- Fibre (ONT) readings, kept per router ----------
const ontLast = new Map();   // id → last reading
const ontError = new Map();  // id → last error

function ontReading(id) {
  if (!ontLast.has(id)) {
    try { ontLast.set(id, JSON.parse(fs.readFileSync(store.readingFile(id), 'utf8'))); } catch { ontLast.set(id, null); }
  }
  return ontLast.get(id);
}

function saveOntReading(id, status, via) {
  if (status.wifi) syncWifiNames(id, status.wifi); // the router renamed its Wi-Fi: follow it
  const reading = { ...status, checkedAt: new Date().toISOString(), via };
  ontLast.set(id, reading);
  ontError.delete(id);
  try { writeJsonAtomic(store.readingFile(id), JSON.stringify(reading, null, 2)); } catch { /* keep it in memory */ }
}

function ontSummary(id, reachableNow) {
  const r = store.get(id);
  const c = store.clients.get(id);
  return {
    configured: !!r.password,
    ssid: r.ssid5 || null,
    reachable: reachableNow,
    switching: !!(c && c.switching),
    last: ontReading(id),
    error: ontError.get(id) || null
  };
}

async function ontStatus(id, force) {
  const c = clientOf(id, 'fibre');
  if (c.switching) return ontSummary(id, false);
  const reachableNow = await c.isReachable();
  const last = ontReading(id);
  const stale = !last || Date.now() - new Date(last.checkedAt) > ONT_MIN_AGE_MS;
  if (reachableNow && store.get(id).password && (force || stale)) {
    try {
      const status = await c.readStatus();
      status.internet = await c.internetWorks();
      saveOntReading(id, status, 'direct');
    } catch (e) {
      ontError.set(id, e.message);
    }
  }
  return ontSummary(id, reachableNow);
}

// ---------- This PC's Wi-Fi and each router's 2.4 / 5 GHz networks ----------
const wifiNets = new Map(); // id → { at, nets } read from routers that report their own Wi-Fi

async function wifiPairs() {
  const pairs = {};
  for (const r of store.routers) {
    if (r.driver === 'zlt') {
      let cached = wifiNets.get(r.id);
      // Re-read now and then so a renamed network shows up; only when the router is reachable.
      if ((!cached || Date.now() - cached.at > 60 * 1000) && await reachable(r.host)) {
        try { cached = { at: Date.now(), nets: await store.client(r.id).wifiNetworks() }; wifiNets.set(r.id, cached); } catch { /* busy */ }
      }
      const n = cached && cached.nets;
      pairs[r.id] = { '2.4': (n && n.ssid24) || r.ssid24 || null, '5': (n && n.ssid5) || r.ssid5 || null };
    } else {
      pairs[r.id] = { '2.4': r.ssid24 || null, '5': r.ssid5 || null };
    }
  }
  return pairs;
}

const subnetOf = (ip) => String(ip || '').split('.').slice(0, 3).join('.');

async function pcWifiSummary() {
  const s = await pcWifi.status();
  const pairs = await wifiPairs();
  // Which router: by the PC's gateway first (survives renamed networks), then by Wi-Fi name.
  let network = null;
  const byGateway = s.gateway && store.routers.find((r) => subnetOf(r.host) === subnetOf(s.gateway));
  if (byGateway) {
    network = byGateway.id;
    // Keep the router's Wi-Fi name for this band current: fill it in, or correct it after a rename.
    const slot = s.band === '5' ? 'ssid5' : s.band === '2.4' ? 'ssid24' : null;
    if (slot && s.ssid && byGateway[slot] !== s.ssid) {
      store.update(byGateway.id, { [slot]: s.ssid });
      pairs[byGateway.id] = { ...pairs[byGateway.id], [s.band]: s.ssid };
    }
  }
  else network = Object.keys(pairs).find((id) => Object.values(pairs[id]).includes(s.ssid)) || null;
  const options = network && pairs[network]['2.4'] && pairs[network]['5'] ? pairs[network] : null;
  return { ...s, network, options, networks: pairs };
}

// ---------- Devices on the home network ----------
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Asks a device on the home network what it is. Returns { name, model } or null.
// Samsung smart TVs (2016+) describe themselves on port 8001.
async function identify(ip) {
  const samsung = await getJson(`http://${ip}:8001/api/v2/`, 2500);
  const dev = samsung && samsung.device;
  if (dev) {
    let name = String(dev.name || samsung.name || 'Samsung TV').replace(/^\[TV\]\s*/, '');
    if (/tv/i.test(dev.type || '') && !/\bTV\b/.test(name)) name += ' TV';
    return { name, model: dev.modelName || null };
  }
  return null;
}

function runScan() {
  // Share one scan between overlapping requests (e.g. two open windows).
  if (!scanInFlight) {
    scanInFlight = new Promise((resolve, reject) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scan.ps1')],
        { windowsHide: true, timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message).toString().trim().split('\n')[0]));
          try { resolve(lastScanResult = JSON.parse(stdout)); }
          catch { reject(new Error('Could not read the scan result.')); }
        });
    }).finally(() => { scanInFlight = null; });
  }
  return scanInFlight;
}

// This PC's own network-card addresses (as 12 hex digits), so it never blocks itself.
const normMacKey = (mac) => String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
function thisPcMacs() {
  const out = new Set();
  for (const list of Object.values(require('os').networkInterfaces())) {
    for (const i of list || []) if (i.mac && i.mac !== '00:00:00:00:00:00') out.add(normMacKey(i.mac));
  }
  return out;
}

// One test login with the details typed in, before a router is saved. Also returns the router's
// Wi-Fi names (never its Wi-Fi passwords), so they don't have to be typed in.
async function testLogin(driver, cfg) {
  if (driver === 'zlt') {
    const c = new Router(() => cfg);
    await c.status();
    try { const n = await c.wifiNetworks(); return { ssid5: n.ssid5 || '', ssid24: n.ssid24 || '' }; } catch { return {}; }
  }
  if (driver === 'huawei-ont') {
    const s = await new Fibre(() => cfg).readStatus();
    return s.wifi ? { ssid5: s.wifi.ssid5 || '', ssid24: s.wifi.ssid24 || '' } : {};
  }
  return {};
}

// Keeps a router's saved Wi-Fi names in step with what the router reports (after a rename on the router).
function syncWifiNames(id, names) {
  if (!names) return;
  const r = store.routers.find((x) => x.id === id);
  if (!r) return;
  const changes = {};
  if (names.ssid5 && names.ssid5 !== r.ssid5) changes.ssid5 = names.ssid5;
  if (names.ssid24 && names.ssid24 !== r.ssid24) changes.ssid24 = names.ssid24;
  if (Object.keys(changes).length) store.update(id, changes);
}

// ---------- Ask AI ----------
const readData = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; } };
const assistant = new Assistant({
  settingsFile: path.join(APP_DIR, 'ai.json'), // service, model and key the user set in Ask AI › AI settings
  tools: buildTools({
    store, DRIVERS, runScan, lastScan: () => lastScanResult, pcWifiSummary, wifiPairs,
    ontStatus, ontReading, readData, thisPcMacs: () => thisPcMacs()
  })
});

// ---------- HTTP plumbing ----------
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const jsonBody = async (req) => JSON.parse((await readBody(req)) || '{}');

// Routes under /api/routers/<id>/...
async function handleRouterApi(req, res, id, action, query) {
  const r = store.get(id);
  const is = (method, a) => req.method === method && action === a;

  if (is('POST', 'settings')) {
    const input = await jsonBody(req);
    store.update(id, input);
    wifiNets.delete(id);
    ontError.delete(id);
    return sendJson(res, { ok: true, routers: store.publicList() });
  }
  if (is('POST', 'remove')) {
    store.remove(id);
    ontLast.delete(id);
    ontError.delete(id);
    wifiNets.delete(id);
    return sendJson(res, { ok: true, routers: store.publicList() });
  }

  // Basic information works for every router, supported or not (no login).
  if (is('GET', 'basic')) {
    const up = await reachable(r.host);
    let found = null;
    if (up) { try { found = await (DRIVERS[r.driver] || DRIVERS.generic).detect(r.host); } catch { /* ignore */ } }
    return sendJson(res, { reachable: up, model: (found && found.model) || r.model, note: (found && found.note) || null, checkedAt: new Date().toISOString() });
  }

  // 4G (ZLT) routers
  if (is('GET', 'status')) return sendJson(res, await clientOf(id, 'mobile').status());
  if (is('GET', 'clients')) return sendJson(res, await clientOf(id, 'mobile').clients());
  if (is('GET', 'wifi-clients')) return sendJson(res, await clientOf(id, 'mobile').wifiClients());
  if (is('POST', 'ussd')) return sendJson(res, await clientOf(id, 'mobile').ussd((await jsonBody(req)).code));
  if (is('POST', 'ussd/cancel')) return sendJson(res, await clientOf(id, 'mobile').cancelUssd());
  if (is('GET', 'sms')) return sendJson(res, await clientOf(id, 'mobile').smsList(query.get('box') || 'inbox'));
  if (is('POST', 'sms/send')) { const b = await jsonBody(req); return sendJson(res, await clientOf(id, 'mobile').sendSms(b.phone, b.text)); }
  if (is('POST', 'sms/read')) return sendJson(res, await clientOf(id, 'mobile').markSmsRead((await jsonBody(req)).indexes));
  if (is('POST', 'sms/delete')) { const b = await jsonBody(req); return sendJson(res, await clientOf(id, 'mobile').deleteSms(b.box, b.indexes)); }

  // Block, unblock or briefly disconnect a device (routers whose login may change the Wi-Fi block list)
  if (req.method === 'POST' && ['block', 'unblock', 'disconnect'].includes(action)) {
    if (!(DRIVERS[r.driver] || {}).canBlock) return sendJson(res, { error: `The app can't block devices on "${r.name}" with its current login.` }, 400);
    const { mac, name, seconds, viaWifi } = await jsonBody(req);
    // Never lock this PC out of a router: it couldn't reach the router to undo it.
    if (thisPcMacs().has(normMacKey(mac))) return sendJson(res, { error: "The app won't block or disconnect this PC: it would lose its connection to the router and couldn't undo it." }, 400);
    const c = clientOf(id, 'fibre');
    const run = () => (action === 'block' ? c.block(mac, name) : action === 'unblock' ? c.unblock(mac) : c.disconnect(mac, name, seconds));
    let blocked;
    if (await c.isReachable()) blocked = await run();
    else if (!viaWifi) return sendJson(res, { error: `This PC isn't on "${r.name}"'s network.`, offNetwork: true }, 409);
    else if (anySwitching()) return sendJson(res, { error: 'Another check is switching Wi-Fi right now. Try again in a minute.' }, 409);
    else blocked = await c.onFibreWifi(run);
    // Keep the saved reading's block list current.
    const last = ontReading(id);
    if (last) saveOntReading(id, { ...last, blocked }, last.via);
    return sendJson(res, { ok: true, blocked });
  }

  // Fibre (ONT) routers
  if (is('GET', 'fibre')) return sendJson(res, await ontStatus(id, false));
  if (is('POST', 'fibre/check')) {
    const { viaWifi } = await jsonBody(req);
    const c = clientOf(id, 'fibre');
    if (await c.isReachable()) return sendJson(res, await ontStatus(id, true));
    if (!viaWifi) return sendJson(res, ontSummary(id, false));
    if (anySwitching()) return sendJson(res, { error: 'Another check is switching Wi-Fi right now. Try again in a minute.' }, 409);
    try {
      saveOntReading(id, await c.checkViaWifi(), 'wifi-switch');
    } catch (e) {
      ontError.set(id, e.message);
    }
    return sendJson(res, ontSummary(id, false));
  }

  return send(res, 404, 'text/plain', 'Not found');
}

async function handleApi(req, res, pathname) {
  // The custom header means other websites can't call these endpoints from your browser.
  if (req.headers['x-netmon'] !== '1') return send(res, 403, 'text/plain', 'Forbidden');
  const query = new URL(req.url, 'http://localhost').searchParams;

  if (req.method === 'POST' && pathname === '/api/scan') {
    if (anySwitching()) return sendJson(res, { error: 'A fibre check is switching Wi-Fi right now.' }, 409);
    return sendJson(res, await runScan());
  }
  if (req.method === 'POST' && pathname === '/api/ping') return sendJson(res, { ok: true });
  if (req.method === 'GET' && pathname === '/api/about') return sendJson(res, { version: APP_VERSION });

  if (req.method === 'GET' && pathname === '/api/data') {
    try { return sendJson(res, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
    catch { return sendJson(res, null); }
  }

  if (req.method === 'POST' && pathname === '/api/data') {
    const body = await readBody(req);
    JSON.parse(body); // reject anything that isn't valid JSON
    writeJsonAtomic(DATA_FILE, body);
    return sendJson(res, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/identify') {
    const ip = query.get('ip') || '';
    if (!PRIVATE_IPV4.test(ip)) return sendJson(res, { error: 'Only home-network addresses can be identified.' }, 400);
    return sendJson(res, await identify(ip));
  }

  // ---- Router list ----
  if (req.method === 'GET' && pathname === '/api/routers') return sendJson(res, store.publicList());

  if (req.method === 'POST' && pathname === '/api/routers/detect') {
    const { host } = await jsonBody(req);
    return sendJson(res, await detect(host));
  }

  if (req.method === 'POST' && pathname === '/api/routers') {
    const input = await jsonBody(req);
    const host = String(input.host || '').trim();
    if (!PRIVATE_IPV4.test(host)) return sendJson(res, { error: 'Only home-network addresses can be added.' }, 400);
    // Cheap checks first, so a duplicate never costs a login attempt on the router.
    if (store.routers.some((r) => r.host === host)) return sendJson(res, { error: `A router at ${host} is already in the list.` }, 400);
    const driver = DRIVERS[input.driver] ? input.driver : 'generic';
    const d = DRIVERS[driver];
    let tested = false;
    let found = {};
    // Test the login once before saving, when the router can be reached from here (it also reads the Wi-Fi names).
    if (d.supported && d.needsLogin && await reachable(host)) {
      if (!input.password) return sendJson(res, { error: 'Enter the router password.' }, 400);
      try {
        found = await testLogin(driver, { host, username: input.username || d.defaultUser, password: input.password, ssid: input.ssid5 });
        tested = true;
      } catch (e) {
        return sendJson(res, { error: 'Login test failed: ' + e.message }, 400);
      }
    }
    // Still missing a name? If this PC is on that router's Wi-Fi now, that network is one of them.
    if (!found.ssid5 || !found.ssid24) {
      const s = await pcWifi.status().catch(() => null);
      if (s && s.ssid && subnetOf(s.gateway) === subnetOf(host)) {
        if (s.band === '5' && !found.ssid5) found.ssid5 = s.ssid;
        if (s.band === '2.4' && !found.ssid24) found.ssid24 = s.ssid;
      }
    }
    // Names typed in the dialog win; detected ones fill the gaps.
    const ssid5 = String(input.ssid5 || '').trim() || found.ssid5 || '';
    const ssid24 = String(input.ssid24 || '').trim() || found.ssid24 || '';
    const added = store.add({ ...input, host, driver, ssid5, ssid24 });
    return sendJson(res, { ok: true, id: added.id, loginTested: tested, wifiDetected: !!(found.ssid5 || found.ssid24), routers: store.publicList() });
  }

  // ---- Ask AI ----
  if (req.method === 'GET' && pathname === '/api/ai/status') return sendJson(res, assistant.status());
  if (req.method === 'POST' && pathname === '/api/ai/settings') {
    try { return sendJson(res, await assistant.saveSettings(await jsonBody(req))); }
    catch (e) { return sendJson(res, { error: e.message }, 400); }
  }
  if (req.method === 'POST' && pathname === '/api/ai/chat') {
    const { messages, context } = await jsonBody(req);
    if (!Array.isArray(messages) || !messages.length) return sendJson(res, { error: 'Ask a question first.' }, 400);
    const ctx = context && typeof context === 'object' ? context : {};
    const r = store.routers.find((x) => x.id === ctx.router);
    const routers = store.publicList().map((x) => ({ id: x.id, name: x.name, kind: x.kind, model: x.model, host: x.host }));
    return sendJson(res, await assistant.chat(messages, { router: ctx.router, routerName: r ? r.name : null, section: ctx.section, routers }));
  }

  // ---- This PC's Wi-Fi ----
  if (req.method === 'GET' && pathname === '/api/pc/wifi') return sendJson(res, await pcWifiSummary());

  if (req.method === 'POST' && pathname === '/api/pc/band') {
    const { band } = await jsonBody(req);
    if (band !== '2.4' && band !== '5') return sendJson(res, { error: 'Choose 2.4 or 5 GHz.' }, 400);
    if (anySwitching()) return sendJson(res, { error: 'A fibre check is switching Wi-Fi right now. Try again in a minute.' }, 409);
    const now = await pcWifiSummary();
    if (!now.options) return sendJson(res, { error: `This PC is on "${now.ssid || 'no Wi-Fi'}", and the app doesn't know that router's 2.4 and 5 GHz network names. Add them under Information › Router settings.` }, 400);
    const target = now.options[band];
    if (now.ssid === target) return sendJson(res, now);
    // A ZLT router can hand over its Wi-Fi password; other routers' networks must already be saved in Windows.
    const r = store.get(now.network);
    const getKey = r.driver === 'zlt'
      ? async () => { const n = await store.client(r.id).wifiNetworks(); return band === '5' ? n.key5 : n.key24; }
      : null;
    await pcWifi.switchTo(target, getKey);
    return sendJson(res, await pcWifiSummary());
  }

  // Connect this PC to a saved router's Wi-Fi (2.4 or 5 GHz network).
  if (req.method === 'POST' && pathname === '/api/pc/join') {
    const { routerId, band } = await jsonBody(req);
    if (anySwitching()) return sendJson(res, { error: 'A fibre check is switching Wi-Fi right now. Try again in a minute.' }, 409);
    const r = store.get(routerId);
    const names = (await wifiPairs())[r.id] || {};
    const b = names[band] ? band : names['5'] ? '5' : '2.4';
    const target = names[b];
    if (!target) return sendJson(res, { error: `The app doesn't know ${r.name}'s Wi-Fi name. Add it under Information › Router settings.` }, 400);
    // A ZLT router can hand over its Wi-Fi password if Windows doesn't know the network yet.
    const getKey = r.driver === 'zlt' && await reachable(r.host)
      ? async () => { const n = await store.client(r.id).wifiNetworks(); return b === '5' ? n.key5 : n.key24; }
      : null;
    await pcWifi.switchTo(target, getKey);
    return sendJson(res, await pcWifiSummary());
  }

  const m = /^\/api\/routers\/([A-Za-z0-9_-]+)\/(.+)$/.exec(pathname);
  if (m) return handleRouterApi(req, res, m[1], m[2], query);

  return send(res, 404, 'text/plain', 'Not found');
}

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden');

  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);

    const entry = STATIC[pathname];
    if (!entry || req.method !== 'GET') return send(res, 404, 'text/plain', 'Not found');
    return send(res, 200, entry[1], fs.readFileSync(path.join(ROOT, entry[0])));
  } catch (e) {
    return sendJson(res, { error: e.message }, 500);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Home Network Monitor is already running.');
    process.exit(0);
  }
  log('Server error: ' + (e.stack || e.message));
});

server.listen(PORT, HOST, () => {
  console.log(`Home Network Monitor running at http://localhost:${PORT}/`);
  log(`Started (pid ${process.pid}).`);
});

// An unexpected error must not take the whole monitor down: note it and carry on.
process.on('uncaughtException', (e) => log('Unexpected error (kept running): ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('Unhandled failure (kept running): ' + (e && e.stack || e)));

setInterval(() => {
  if (Date.now() - lastActivity > IDLE_SHUTDOWN_MS) {
    log(`Stopped: no contact from the dashboard for ${Math.round(IDLE_SHUTDOWN_MS / 60000)} minutes.`);
    process.exit(0);
  }
}, 30 * 1000).unref();
