// Talks to the MTN fibre router (Huawei HG8145X6-10 GPON ONT) and, when asked, briefly
// switches this PC's Wi-Fi to the fibre network to read it, then switches back.
'use strict';

const http = require('http');
const net = require('net');
const { execFile } = require('child_process');

// GPON registration states (ITU-T G.984.3). O5 is the only one where internet can work.
const PON_STATES = {
  O1: 'Starting up',
  O2: 'Waiting for MTN to register it',
  O3: 'Sending its serial number to MTN',
  O4: 'Lining up with MTN (ranging)',
  O5: 'Registered and working',
  O6: 'Fibre signal keeps dropping',
  O7: 'Switched off by MTN'
};

// Undo the \xNN escapes the router uses inside its page scripts.
const unescapeJs = (s) => String(s || '').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();

// The arguments of the first `new <name>(...)` call in a page, as strings.
function ctorArgs(page, name) {
  const m = new RegExp('new ' + name + '\\(([^)]*)\\)').exec(page);
  if (!m) return null;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unescapeJs(x[1]));
}

function jsVar(page, name) {
  const all = [...page.matchAll(new RegExp('var ' + name + "\\s*=\\s*'([^']*)'", 'g'))].map((m) => m[1]);
  return all.find((v) => v !== '') ?? null;
}

const num = (v) => {
  const n = parseFloat(String(v || '').trim());
  return isNaN(n) ? null : n;
};

// Huawei serial numbers come as 16 hex digits; the first 8 spell the vendor ("HWTC").
function serialFromHex(hex) {
  if (!/^[0-9A-Fa-f]{16}$/.test(hex || '')) return hex || null;
  return Buffer.from(hex.slice(0, 8), 'hex').toString('ascii') + hex.slice(8).toUpperCase();
}

function parseStatus(devicePage, opticPage) {
  const ont = ctorArgs(devicePage, 'ONTInfo') || [];
  const dev = ctorArgs(devicePage, 'stDeviceInfo') || [];
  const optic = ctorArgs(opticPage, 'stOpticInfo') || [];
  const state = /^O[1-7]$/.test(ont[2] || '') ? ont[2] : null;
  const uptime = num(jsVar(devicePage, 'dev_uptime'));
  const ref = (jsVar(opticPage, 'opticTxRxRef') || '').match(/-?[\d.]+/g) || [];
  return {
    state,
    stateText: state ? PON_STATES[state] : 'Unknown',
    working: state === 'O5',
    model: dev[4] || null,
    serial: serialFromHex(dev[1]),
    firmware: dev[3] || null,
    uptimeSec: uptime,
    optical: {
      ok: (optic[1] || '').toLowerCase() === 'ok',
      txDbm: num(optic[2]),
      rxDbm: num(optic[3]),
      tempC: num(optic[5]),
      // e.g. "0.5 to 5.0dBm:-27.0 to -8.0dBm"
      txRange: ref.length >= 2 ? [Number(ref[0]), Number(ref[1])] : [0.5, 5],
      rxRange: ref.length >= 4 ? [Number(ref[2]), Number(ref[3])] : [-27, -8]
    }
  };
}

// Phone (VoIP) line 1: stLine(domain, number, phyRef, status, callState, registerError).
const CALL_STATES = { Idle: 'Idle', Calling: 'Dialling', Ringing: 'Ringing', Connecting: 'Connecting', InCall: 'On a call', Hold: 'On hold', Disconnecting: 'Hanging up' };
function parsePhone(page) {
  const line = ctorArgs(page, 'stLine');
  if (!line) return null;
  const [, number, , status, callState, registerError] = line;
  const err = (registerError || '').replace(/\\_/g, '_');
  return {
    number: number || null,
    status: status || null, // Up = registered with MTN's phone service
    registered: /^up$/i.test(status || ''),
    enabled: !/^disabled$/i.test(status || ''),
    callState: CALL_STATES[callState] || callState || null,
    error: err && err !== '--' ? err : null
  };
}

// ---------- Internet (WAN) connections ----------
// WanPPP(domain, ?, ?, trigger, mac, status, lastError, ?, name, ?, ?, ?, ?, mode, ip, gateway, ?, ?, dns, username, password, ...)
// The service list (INTERNET / VOIP / TR069 / IPTV) is found by name. The password is never read.
const SERVICE_RE = /^(?:TR069_|VOIP_|IPTV_|OTHER_)*(?:INTERNET|VOIP|TR069|IPTV|OTHER)(?:_(?:TR069|VOIP|IPTV|INTERNET|OTHER))*$/;
function parseWanList(page) {
  const out = [];
  for (const m of page.matchAll(/new (WanPPP|WanIP)\(([^)]*)\)/g)) {
    const a = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unescapeJs(x[1]));
    const ipv4 = (v) => (/^\d+\.\d+\.\d+\.\d+$/.test(v || '') ? v : null);
    const ips = a.filter((v) => ipv4(v));
    out.push({
      type: m[1] === 'WanPPP' ? 'PPPoE' : 'IP',
      name: a[8] || null,
      status: a[5] || null,
      lastError: a[6] && a[6] !== 'ERROR_NONE' ? a[6] : null,
      ip: m[1] === 'WanPPP' ? ipv4(a[14]) : ips[0] || null,
      gateway: m[1] === 'WanPPP' ? ipv4(a[15]) : ips[1] || null,
      dns: (a.find((v) => /^\d+\.\d+\.\d+\.\d+(,\d+\.\d+\.\d+\.\d+)+$/.test(v)) || null),
      account: m[1] === 'WanPPP' && a[19] && !/sensitive/i.test(a[19]) ? a[19] : null,
      services: a.find((v) => SERVICE_RE.test(v)) || null
    });
  }
  return out;
}
const isSharedAddress = (ip) => /^(10\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip || '');

// ---------- Wi-Fi names ----------
// stWlan(domain, enable, name, ssid, ...): WLANConfiguration 1-4 are 2.4 GHz, 5-8 are 5 GHz.
// Only the network names are taken from this page; nothing else (it also holds security settings).
function parseWifiNames(page) {
  const out = { ssid24: null, ssid5: null };
  for (const m of page.matchAll(/new stWlan\(([^)]*)\)/g)) {
    const a = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unescapeJs(x[1]));
    const inst = Number((/WLANConfiguration\.(\d+)/.exec(a[0] || '') || [])[1]);
    const enabled = a[1] === '1';
    const ssid = (a[3] || '').replace(/\\(.)/g, '$1');
    if (!inst || !enabled || !ssid) continue;
    if (inst <= 4 && !out.ssid24) out.ssid24 = ssid;
    if (inst >= 5 && inst <= 8 && !out.ssid5) out.ssid5 = ssid;
  }
  return out.ssid24 || out.ssid5 ? out : null;
}

// ---------- Wi-Fi MAC filter page ----------
const MACFILTER_PAGE = '/html/bbsp/wlanmacfilter/wlanmacfilter.asp';
const WIFI_SSIDS = ['SSID-1', 'SSID-5']; // the router's 2.4 GHz and 5 GHz networks

const normMac = (mac) => {
  const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) throw new Error('That device has no valid hardware (MAC) address.');
  return hex.match(/../g).join(':');
};
const safeName = (name) => String(name || 'Blocked by app').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 31) || 'Blocked by app';

// enableFilter, policy (0 = block these, 1 = allow only these), max entries and the entries.
function parseMacFilter(page) {
  const entries = [...page.matchAll(/new stMacFilter\(([^)]*)\)/g)].map((m) => {
    const a = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unescapeJs(x[1]));
    return { domain: a[0], ssid: a[1], name: a[2], mac: String(a[3] || '').toUpperCase() };
  }).filter((e) => e.domain && /WLANMacFilter\.\d+$/.test(e.domain));
  return {
    enabled: jsVar(page, 'enableFilter') === '1',
    mode: jsVar(page, 'Mode') || '0',
    max: Number(jsVar(page, 'specMacFilterNum')) || 8,
    entries
  };
}

// Is something listening on host:port right now? (Tells us if the PC is on the fibre network.)
function reachable(host, port = 80, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

async function currentSsid() {
  const { out } = await run('netsh', ['wlan', 'show', 'interfaces']);
  const m = /^\s*SSID\s*:\s*(.+)$/m.exec(out);
  return m ? m[1].trim() : null;
}

// Asks Windows for a fresh Wi-Fi scan. Without it, netsh only knows the networks from the last
// background scan and refuses to join one that isn't in that list ("not available to connect").
const SCAN_PS = [
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Devices.WiFi.WiFiAdapter, Windows.Devices.WiFi, ContentType=WindowsRuntime]',
  "$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }",
  "$op = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  "$act = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1",
  '$t = $op.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.WiFi.WiFiAdapter]]).Invoke($null, @([Windows.Devices.WiFi.WiFiAdapter]::FindAllAdaptersAsync()))',
  '$null = $t.Wait(5000)',
  'foreach ($a in $t.Result) { $null = $act.Invoke($null, @($a.ScanAsync())).Wait(10000) }'
].join('; ');

async function visibleSsids() {
  const { out } = await run('netsh', ['wlan', 'show', 'networks']);
  return [...out.matchAll(/^SSID \d+ : (.*)$/gm)].map((m) => m[1].trim());
}

async function rescanWifi() {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_PS], 20000);
}

// Joins a saved Wi-Fi network, rescanning first if Windows doesn't currently list it.
async function joinWifi(ssid, checkReady) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await currentSsid()) !== ssid) {
      if (!(await visibleSsids()).includes(ssid)) {
        await rescanWifi();
        for (let i = 0; i < 5 && !(await visibleSsids()).includes(ssid); i++) await sleep(2000);
      }
      await run('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`]);
    }
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      if ((await currentSsid()) === ssid && (await checkReady())) return true;
    }
  }
  return false;
}

class Fibre {
  constructor(getConfig) {
    this.getConfig = getConfig; // () => { host, username, password, ssid }
    this.queue = Promise.resolve();
    this.loginBlocked = null; // set after a failed login so automatic checks can't lock the router
    this.switching = false;
  }

  serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  forgetLoginFailure() {
    this.loginBlocked = null;
  }

  request(method, path, { body, cookies, timeoutMs = 10000 } = {}) {
    const { host } = this.getConfig();
    return new Promise((resolve, reject) => {
      const headers = {
        Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        Referer: `http://${host}/`,
        'X-Requested-With': 'XMLHttpRequest'
      };
      if (body != null) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = http.request({ host, path, method, headers, timeout: timeoutMs }, (res) => {
        for (const c of res.headers['set-cookie'] || []) {
          const [pair] = c.split(';');
          const eq = pair.indexOf('=');
          if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      });
      req.on('timeout', () => req.destroy(new Error('The fibre router did not answer in time.')));
      req.on('error', (e) => reject(e.message.includes('answer in time') ? e : new Error('Could not reach the fibre router: ' + e.message)));
      req.end(body);
    });
  }

  async token(cookies) {
    const r = await this.request('POST', '/asp/GetRandCount.asp', { body: '', cookies });
    const m = /[0-9a-fA-F]{64}/.exec(r.text); // the reply starts with an invisible byte-order mark
    if (!m) throw new Error('The fibre router did not offer a login.');
    return m[0];
  }

  // Logs in, runs fn(get) where get(path) fetches a page in the session, then logs out.
  withSession(fn) {
    return this.serialize(async () => {
      const { username, password } = this.getConfig();
      if (!password) throw new Error('Enter the fibre router login first.');
      if (this.loginBlocked) throw new Error(this.loginBlocked);

      const cookies = { Cookie: 'body:Language:english:id=-1' };
      // Right after a previous session the router sometimes drops the first request; try again once.
      let tok;
      try { tok = await this.token(cookies); }
      catch { await sleep(4000); tok = await this.token(cookies); }
      const pw = Buffer.from(password, 'utf8').toString('base64');
      await this.request('POST', '/login.cgi', {
        cookies,
        body: `UserName=${encodeURIComponent(username)}&PassWord=${encodeURIComponent(pw)}&Language=english&x.X_HW_Token=${tok}`
      });
      if (!Object.values(cookies).some((v) => v.startsWith('sid='))) {
        this.loginBlocked = 'The fibre router rejected the login. Check the username and password, then save them again.';
        throw new Error(this.loginBlocked);
      }

      try {
        const get = async (p, opts = {}) => {
          const r = await this.request(opts.body != null ? 'POST' : 'GET', p, { cookies, body: opts.body });
          if (r.status !== 200) throw new Error(`The fibre router would not show ${p} (${r.status}).`);
          return r.text;
        };
        get.token = () => this.token(cookies);
        // Form posts that change settings: the router answers 200 or a redirect.
        get.post = async (p, fields) => {
          const body = Object.entries({ ...fields, 'x.X_HW_Token': await this.token(cookies) })
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
          const r = await this.request('POST', p, { cookies, body });
          if (r.status >= 400) throw new Error(`The fibre router refused the change (${r.status}).`);
          return r.text;
        };
        return await fn(get);
      } finally {
        // Free the router's admin session; it only allows one at a time.
        try {
          const t = await this.token(cookies);
          await this.request('POST', '/logout.cgi?RequestFile=html/logout.html', { cookies, body: `x.X_HW_Token=${t}`, timeoutMs: 4000 });
        } catch { /* the router often closes the connection on logout */ }
      }
    });
  }

  // Registration state, fibre signal, phone line and SIM support, in one login.
  readStatus() {
    return this.withSession(async (get) => {
      const device = await get('/html/ssmp/deviceinfo/deviceinfo.asp');
      const optic = await get('/html/amp/opticinfo/opticinfo.asp');
      const status = parseStatus(device, optic);
      try { status.phone = parsePhone(await get('/html/voip/status/sipvoipmaintain.asp')); }
      catch { status.phone = null; }
      try { status.simSupported = jsVar(await get('/index.asp'), 'isSupportLte') === '1'; }
      catch { status.simSupported = null; }
      try { status.blocked = parseMacFilter(await get(MACFILTER_PAGE)).entries; }
      catch { status.blocked = null; }
      try { status.wifi = parseWifiNames(await get('/html/amp/wlaninfo/wlaninfo.asp')); }
      catch { status.wifi = null; }
      try { status.wan = parseWanList(await get('/html/bbsp/common/getwanlist.asp', { body: '' })); }
      catch { status.wan = null; }
      return status;
    });
  }

  // ---------- Wi-Fi block list (MAC filter) ----------
  // The router's Wi-Fi MAC filter in "block these" mode. Each blocked device gets one entry per
  // Wi-Fi network (2.4 and 5 GHz) so it can't just hop bands.
  async readFilter(get) {
    const f = parseMacFilter(await get(MACFILTER_PAGE));
    if (f.mode !== '0') throw new Error("The router's Wi-Fi filter is in \"allow only these devices\" mode. The app won't change it, because that could lock every other device out.");
    return f;
  }

  async blockIn(get, mac, name) {
    const f = await this.readFilter(get);
    const have = new Set(f.entries.filter((e) => e.mac === mac).map((e) => e.ssid));
    const missing = WIFI_SSIDS.filter((s) => !have.has(s));
    if (f.entries.length + missing.length > f.max) throw new Error(`The router's block list is full (${f.max} entries, two per device). Unblock a device first.`);
    for (const ssid of missing) {
      await get.post(`/add.cgi?x=InternetGatewayDevice.X_HW_Security.WLANMacFilter&RequestFile=${MACFILTER_PAGE.slice(1)}`, {
        'x.SourceMACAddress': mac, 'x.SSIDName': ssid, 'x.DeviceName': safeName(name), 'x.Enable': 1
      });
    }
    if (!f.enabled) {
      await get.post(`/set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=${MACFILTER_PAGE.slice(1)}`, { 'x.WlanMacFilterRight': 1 });
    }
  }

  async unblockIn(get, mac) {
    const f = parseMacFilter(await get(MACFILTER_PAGE));
    const mine = f.entries.filter((e) => e.mac === mac);
    if (!mine.length) return;
    const fields = {};
    for (const e of mine) fields[e.domain] = '';
    await get.post(`/del.cgi?x=InternetGatewayDevice.X_HW_Security.WLANMacFilter&RequestFile=${MACFILTER_PAGE.slice(1)}`, fields);
  }

  // Each returns the block list afterwards.
  blockedList() {
    return this.withSession(async (get) => parseMacFilter(await get(MACFILTER_PAGE)).entries);
  }

  block(mac, name) {
    mac = normMac(mac);
    return this.withSession(async (get) => {
      await this.blockIn(get, mac, name);
      return parseMacFilter(await get(MACFILTER_PAGE)).entries;
    });
  }

  unblock(mac) {
    mac = normMac(mac);
    return this.withSession(async (get) => {
      await this.unblockIn(get, mac);
      return parseMacFilter(await get(MACFILTER_PAGE)).entries;
    });
  }

  // Kicks a device off by blocking it briefly; it reconnects by itself afterwards.
  disconnect(mac, name, seconds = 10) {
    mac = normMac(mac);
    const wait = Math.max(5, Math.min(60, Number(seconds) || 10)) * 1000;
    return this.withSession(async (get) => {
      // Already blocked on purpose: leave it blocked, don't "disconnect" (which would unblock it).
      if (parseMacFilter(await get(MACFILTER_PAGE)).entries.some((e) => e.mac === mac)) {
        throw new Error('That device is blocked. Unblock it instead.');
      }
      await this.blockIn(get, mac, name);
      try {
        await sleep(wait);
      } finally {
        // Always try to let it back in, twice if the first attempt fails.
        try { await this.unblockIn(get, mac); }
        catch { await sleep(2000); await this.unblockIn(get, mac); }
      }
      return parseMacFilter(await get(MACFILTER_PAGE)).entries;
    });
  }

  isReachable() {
    return reachable(this.getConfig().host);
  }

  // Internet check from whatever network the PC is on right now.
  internetWorks() {
    return reachable('1.1.1.1', 443, 3000);
  }

  // Switches this PC's Wi-Fi to the fibre network, runs work(), then switches back.
  async onFibreWifi(work) {
    if (this.switching) throw new Error('A Wi-Fi switch is already in progress.');
    const { ssid } = this.getConfig();
    if (!ssid) throw new Error('No fibre Wi-Fi name is set.');
    this.switching = true;
    const home = await currentSsid();
    try {
      if (home !== ssid && !(await joinWifi(ssid, () => this.isReachable()))) {
        throw new Error(`Could not join the "${ssid}" Wi-Fi. Is the fibre router switched on?`);
      }
      await sleep(1500);
      return await work();
    } finally {
      if (home && home !== ssid) await joinWifi(home, async () => true);
      this.switching = false;
    }
  }

  async checkViaWifi() {
    return this.onFibreWifi(async () => {
      const status = await this.readStatus();
      status.internet = await this.internetWorks();
      return status;
    });
  }
}

module.exports = { Fibre, parseStatus, PON_STATES, wifi: { run, currentSsid, joinWifi, visibleSsids, rescanWifi, sleep } };
