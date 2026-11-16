// The list of routers the app knows about, the drivers that talk to them, and login-free detection.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Router } = require('./router');
const { Fibre } = require('./fibre');

// ---------- Small HTTP helpers (no login, short timeouts) ----------
function request(host, { method = 'GET', path: p = '/', body, headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, path: p, method, timeout: timeoutMs, headers: { ...headers, ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (text.length > 512 * 1024) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

function webPortOpen(host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ host, port: 80 });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const titleOf = (html) => {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html || '');
  return m ? m[1].trim() : '';
};

const unescapeJs = (s) => String(s || '').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// ---------- Drivers ----------
// Each driver: detect(host) → { model, note } | null (never logs in), create(getConfig) → client,
// kind ('mobile' | 'fibre' | 'generic'), sections it supports, and the default login name.
const DRIVERS = {
  zlt: {
    label: 'ZLT 4G router (MTN TurboNet)',
    kind: 'mobile',
    supported: true,
    defaultUser: 'admin',
    needsLogin: true,
    sections: ['connections', 'data', 'calls', 'sms', 'info'],
    async detect(host) {
      // The login-token request answers without a login and has a recognisable shape.
      const r = await request(host, {
        method: 'POST', path: '/cgi-bin/http.cgi',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ cmd: 232, method: 'GET', sessionId: '', language: 'EN' })
      });
      if (!r || r.status !== 200) return null;
      try {
        const j = JSON.parse(r.text);
        if (j && j.cmd === 232 && 'token' in j) return { model: 'ZLT 4G router (MTN TurboNet)' };
      } catch { /* not this kind */ }
      return null;
    },
    create: (getConfig) => new Router(getConfig)
  },

  'huawei-ont': {
    label: 'Huawei fibre router (ONT)',
    kind: 'fibre',
    supported: true,
    defaultUser: 'root',
    needsLogin: true,
    sections: ['connections', 'data', 'calls', 'sms', 'info'],
    canBlock: true, // Wi-Fi MAC filter is open to the "root" login
    async detect(host, root) {
      const r = root;
      if (!r || !r.text) return null;
      if (!/GetRandCount\.asp|safelogin\.js/.test(r.text) || !/ProductName/.test(r.text)) return null;
      const product = unescapeJs((/var ProductName\s*=\s*'([^']*)'/.exec(r.text) || [])[1]);
      const cfg = (/var CfgMode\s*=\s*'([^']*)'/.exec(r.text) || [])[1];
      return { model: product ? `Huawei ${product}` : 'Huawei fibre router', note: /MTN/i.test(cfg || '') ? 'MTN configuration' : null };
    },
    create: (getConfig) => new Fibre(getConfig)
  },

  // Recognised by signature but not supported yet: shown with basic information only.
  'huawei-hilink': {
    label: 'Huawei 4G/5G router (HiLink)',
    kind: 'generic',
    supported: false,
    sections: ['connections', 'info'],
    async detect(host) {
      const r = await request(host, { path: '/api/webserver/SesTokInfo' });
      return r && /<SesInfo>|<TokInfo>/.test(r.text) ? { model: 'Huawei 4G/5G router (HiLink)' } : null;
    }
  },
  'zte-mf': {
    label: 'ZTE 4G/5G router',
    kind: 'generic',
    supported: false,
    sections: ['connections', 'info'],
    async detect(host) {
      const r = await request(host, { path: '/goform/goform_get_cmd_process?isTest=false&cmd=wa_inner_version', headers: { Referer: `http://${host}/index.html` } });
      if (!r || r.status !== 200) return null;
      try { return 'wa_inner_version' in JSON.parse(r.text) ? { model: 'ZTE 4G/5G router' } : null; } catch { return null; }
    }
  },

  generic: {
    label: 'Router (basic information)',
    kind: 'generic',
    supported: false,
    sections: ['connections', 'info'],
    async detect(host, root) {
      const r = root || await request(host, { path: '/' });
      if (!r) return null;
      const title = titleOf(r.text);
      return { model: title || r.headers.server || 'Unknown router', note: r.headers.server ? `Web server: ${r.headers.server}` : null };
    }
  }
};

// Detection order: checks that only read pages first; the ZLT check posts to a URL other routers don't
// know, and some (Huawei fibre) drop the next connection after that, so it runs last. Generic is the fallback.
const DETECT_ORDER = ['huawei-ont', 'huawei-hilink', 'zte-mf', 'zlt', 'generic'];

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const PRIVATE_IPV4 = /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/;

// Identifies the router at `host` without logging in.
async function detect(host) {
  host = String(host || '').trim();
  if (!IPV4.test(host)) throw new Error('Enter an address like 192.168.1.1.');
  if (!PRIVATE_IPV4.test(host)) throw new Error('Only home-network addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x) can be added.');
  // Quick check first, so an address that isn't reachable from here answers in about a second.
  if (!(await webPortOpen(host))) return { host, reachable: false };
  // The home page, read once and shared by every check (retried once if the router drops the first try).
  let root = await request(host, { path: '/' });
  if (!root) { await new Promise((r) => setTimeout(r, 1500)); root = await request(host, { path: '/' }); }
  for (const id of DETECT_ORDER) {
    let found = null;
    try { found = await DRIVERS[id].detect(host, root); } catch { found = null; }
    if (found) {
      const d = DRIVERS[id];
      return { host, reachable: true, driver: id, kind: d.kind, label: d.label, supported: d.supported, defaultUser: d.defaultUser || '', needsLogin: !!d.needsLogin, ...found };
    }
  }
  return { host, reachable: false };
}

// ---------- Saved routers ----------
class RouterStore {
  constructor(appDir) {
    this.file = path.join(appDir, 'routers.json');
    this.appDir = appDir;
    this.clients = new Map(); // id → driver client
    this.routers = this.load();
  }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8')).routers;
      if (Array.isArray(list)) return list;
    } catch { /* first run on this version */ }
    return this.migrate();
  }

  // Carries over the two routers from earlier versions (router.json and fibre.json), keeping their ids
  // ("4g" and "fibre") so saved devices, balances and readings stay attached to them.
  migrate() {
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(this.appDir, f), 'utf8')); } catch { return null; } };
    const old4g = read('router.json') || {};
    const oldFibre = read('fibre.json');
    const list = [{
      id: '4g', name: '4G router', driver: 'zlt', kind: 'mobile', model: 'ZLT 4G router (MTN TurboNet)',
      host: old4g.host || '192.168.0.1', username: old4g.username || 'admin', password: old4g.password || 'admin', devPrefix: ''
    }];
    if (oldFibre) {
      list.push({
        id: 'fibre', name: 'Fibre', driver: 'huawei-ont', kind: 'fibre', model: 'Huawei HG8145X6-10',
        host: oldFibre.host || '192.168.100.1', username: oldFibre.username || 'root', password: oldFibre.password || '',
        ssid5: oldFibre.ssid || '', ssid24: oldFibre.ssid24 || String(oldFibre.ssid || '').replace(/5G/i, '2.4G'), devPrefix: 'f:'
      });
      const lastFile = path.join(this.appDir, 'fibre-last.json');
      try { fs.copyFileSync(lastFile, this.readingFile('fibre')); } catch { /* no reading yet */ }
    }
    this.routers = list;
    this.save();
    return list;
  }

  save() {
    fs.mkdirSync(this.appDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ routers: this.routers }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  readingFile(id) { return path.join(this.appDir, `reading-${id}.json`); }

  get(id) {
    const r = this.routers.find((x) => x.id === id);
    if (!r) throw new Error('That router is no longer in the list.');
    return r;
  }

  // The driver client for a router (created once, reads its settings live).
  client(id) {
    const r = this.get(id);
    const driver = DRIVERS[r.driver];
    if (!driver || !driver.create) return null;
    if (!this.clients.has(id)) this.clients.set(id, driver.create(() => {
      const cur = this.get(id);
      return { host: cur.host, username: cur.username, password: cur.password, ssid: cur.ssid5 };
    }));
    return this.clients.get(id);
  }

  // What the page may see: never the password.
  publicList() {
    return this.routers.map((r) => {
      const d = DRIVERS[r.driver] || DRIVERS.generic;
      return {
        id: r.id, name: r.name, host: r.host, driver: r.driver, kind: d.kind, model: r.model || d.label,
        supported: d.supported, sections: d.sections, canBlock: !!d.canBlock, username: r.username || '', hasPassword: !!r.password,
        ssid5: r.ssid5 || '', ssid24: r.ssid24 || '', devPrefix: r.devPrefix
      };
    });
  }

  add(info) {
    const host = String(info.host || '').trim();
    if (!IPV4.test(host)) throw new Error('Enter an address like 192.168.1.1.');
    if (this.routers.some((r) => r.host === host)) throw new Error(`A router at ${host} is already in the list.`);
    const driver = DRIVERS[info.driver] ? info.driver : 'generic';
    const id = 'r' + crypto.randomBytes(3).toString('hex');
    const r = {
      id, host, driver, kind: DRIVERS[driver].kind,
      name: String(info.name || '').trim() || DRIVERS[driver].label,
      model: String(info.model || '').slice(0, 80) || DRIVERS[driver].label,
      username: String(info.username || DRIVERS[driver].defaultUser || '').trim(),
      password: String(info.password || ''),
      ssid5: String(info.ssid5 || '').trim(), ssid24: String(info.ssid24 || '').trim(),
      devPrefix: id + ':'
    };
    this.routers.push(r);
    this.save();
    return r;
  }

  update(id, changes) {
    const r = this.get(id);
    for (const k of ['name', 'username', 'ssid5', 'ssid24']) {
      if (typeof changes[k] === 'string') r[k] = changes[k].trim();
    }
    if (typeof changes.password === 'string' && changes.password) r.password = changes.password;
    this.save();
    const c = this.clients.get(id);
    if (c && c.forgetSession) c.forgetSession();
    if (c && c.forgetLoginFailure) c.forgetLoginFailure();
    return r;
  }

  // Removes the router and its saved reading; the page erases its devices and history.
  remove(id) {
    this.get(id);
    this.routers = this.routers.filter((r) => r.id !== id);
    this.clients.delete(id);
    try { fs.unlinkSync(this.readingFile(id)); } catch { /* none */ }
    this.save();
  }
}

module.exports = { DRIVERS, detect, RouterStore, request, titleOf };
