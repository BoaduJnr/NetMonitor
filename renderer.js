'use strict';

const api = window.netmon;
const SCAN_INTERVAL_MS = 60 * 1000;
const AUTO_BALANCE_MS = 3 * 60 * 60 * 1000; // re-check the data balance every 3 hours
const POLL_MS = 3 * 60 * 1000;               // fibre and basic routers
const SMS_POLL_MS = 60 * 1000;

let data = { devices: [], balancesBy: {}, ussdBy: {}, smsSeenBy: {}, setupTime: null };
let routers = [];           // saved routers (from the server; never includes passwords)
let view = { router: null, section: 'connections' };
let lastScan = null;
let lastScanNet = null;     // router id whose network the last scan ran on (null = unknown network)
let unknownGateway = null;  // gateway of a network whose router isn't saved yet
let scanning = false;
let editingKey = null;
let renderPending = false;
let timer = null;
let pcWifi = null;          // this PC's own connection, its 2.4 / 5 GHz options and every router's network names
let bandSwitching = false;
let fibreSwitching = false; // true while the PC is briefly on another router's Wi-Fi for a check

const $ = (sel) => document.querySelector(sel);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// ---------- Routers ----------
const R = (id) => routers.find((r) => r.id === id) || null;
const kindOf = (id) => (R(id) ? R(id).kind : 'generic');
const supportedKind = (id, kind) => { const r = R(id); return !!(r && r.supported && r.kind === kind); };
const activeOf = (kind) => (supportedKind(view.router, kind) ? view.router : null);
// Your provider's name, for advice text: the original routers are MTN's.
const provider = (id) => (/mtn|turbonet/i.test(`${(R(id) || {}).model} ${(R(id) || {}).name}`) || id === '4g' || id === 'fibre' ? 'MTN' : 'your provider');

// Per-router live state.
const state = {};
const S = (id) => state[id] || (state[id] = { info: null, error: null, clients: [], wifiClients: [], fibre: null, basic: null, ping: [] });

// ---------- Formatting ----------
// Each router's devices get their own records: the first 4G router's keys are plain MAC addresses,
// the first fibre router's start "f:", later routers start with their id.
function prefixOf(id) {
  const r = R(id);
  if (r && typeof r.devPrefix === 'string') return r.devPrefix;
  return id === '4g' ? '' : id === 'fibre' ? 'f:' : id + ':';
}
const keyFor = (d) => prefixOf(d.net) + (d.mac || 'ip:' + d.ip);
const netOfKd = (kd) => kd.net || (kd.key.startsWith('f:') ? 'fibre' : '4g');
const sameSubnet = (a, b) => !!a && !!b && a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
const netOfScan = (result) => { const r = routers.find((x) => sameSubnet(result.gateway, x.host)); return r ? r.id : null; };

function setStatus(text, tone) {
  const s = $('#status');
  s.textContent = text;
  s.className = 'status-line' + (tone ? ' ' + tone : '');
}
const isPrivateMac = (mac) => !!mac && '26AEae'.includes(mac[1]);
const ipNum = (ip) => ip.split('.').reduce((acc, p) => acc * 256 + (Number(p) || 0), 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtMb(mb) {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

function fmtDays(d) {
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} hours`;
  return `${+d.toFixed(1)} days`;
}

function fmtDate(iso, withYear) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (withYear) opts.year = 'numeric';
  return new Date(iso).toLocaleString(undefined, opts);
}

function ago(iso) {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  return fmtDate(iso);
}

function cleanError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function save() {
  try { await api.saveData(data); }
  catch (e) { setStatus('Could not save your data: ' + cleanError(e), 'bad'); }
}

// ---------- Scanning ----------
async function scan() {
  if (scanning || fibreSwitching || bandSwitching) return; // the network is changing under us
  scanning = true;
  const btn = $('#scanBtn');
  btn.disabled = true;
  $('#scanBtnText').textContent = 'Scanning…';
  setStatus('Scanning your network…', 'busy');
  try {
    const result = await api.scan();
    const net = netOfScan(result);
    lastScan = result;
    lastScanNet = net;
    unknownGateway = net ? null : result.gateway || null;
    renderUnknownNet();
    await refreshWifiInfo(net);

    if (net) {
      for (const d of result.devices) d.net = net;
      if (supportedKind(net, 'mobile')) refreshRouter(net);
      // A 4G router's own device list only applies while this PC is on its network.
      const clients = supportedKind(net, 'mobile') ? await loadRouterClients(net) : [];
      S(net).clients = clients;
      const added = merge(result, clients, net);
      const hist = S(net).ping;
      hist.push(result.internet && result.internet.received ? result.internet.avgMs : null);
      if (hist.length > 24) hist.shift();
      if (supportedKind(net, 'fibre')) refreshFibre(net);
      identifyDevices(result);
      if (added.length === 1) {
        api.notify('New device on your network',
          `A device you haven't seen before joined at ${added[0].lastIp}. Open the app to name it.`);
      } else if (added.length > 1) {
        api.notify('New devices on your network', `${added.length} devices you haven't seen before joined your network.`);
      }
    }
    if (view.router && view.router !== net && supportedKind(view.router, 'mobile')) refreshRouter(view.router);
    renderDevices();
    renderStats();
  } catch (e) {
    setStatus('Scan failed: ' + cleanError(e), 'bad');
  } finally {
    scanning = false;
    btn.disabled = false;
    $('#scanBtnText').textContent = 'Scan now';
  }
}

function shortHost(host) {
  if (!host) return '';
  const dot = host.indexOf('.');
  return dot > 0 ? host.slice(0, dot) : host;
}

async function loadRouterClients(id) {
  try { return await api.routerClients(id); }
  catch { return S(id).clients; } // keep the previous list if the router is busy
}

function merge(result, clients, net) {
  const now = new Date().toISOString();
  const firstRun = !data.setupTime;
  if (firstRun) data.setupTime = now;
  const added = [];
  const routerByMac = new Map(clients.map((c) => [c.mac, c]));
  const scannedKeys = new Set();
  const prefix = prefixOf(net);

  for (const d of result.devices) {
    const fromRouter = d.mac && routerByMac.get(d.mac);
    if (fromRouter && fromRouter.hostname && !d.isThisPc) d.hostname = fromRouter.hostname;
    const key = keyFor(d);
    scannedKeys.add(key);
    let kd = data.devices.find((x) => x.key === key);
    if (!kd) {
      const name = d.isGateway ? (R(net) ? R(net).name : 'Router') : d.isThisPc ? `This PC (${d.hostname})` : shortHost(d.hostname);
      kd = { key, mac: d.mac || null, name, firstSeen: now };
      data.devices.push(kd);
      if (!firstRun && !d.isThisPc) added.push(kd);
    }
    if (!kd.name && d.hostname) { kd.name = shortHost(d.hostname); kd.nameAuto = true; } // never overwrite your own names
    kd.net = net;
    kd.lastSeen = now;
    kd.lastIp = d.ip;
  }

  // Devices the router lists that didn't answer the scan (e.g. a sleeping iPhone).
  for (const c of clients) {
    const key = prefix + c.mac;
    if (scannedKeys.has(key)) continue;
    let kd = data.devices.find((x) => x.key === key);
    if (!kd) {
      kd = { key, mac: c.mac, name: c.hostname || '', firstSeen: now };
      data.devices.push(kd);
      if (!firstRun) added.push(kd);
    }
    if (!kd.name && c.hostname) { kd.name = c.hostname; kd.nameAuto = true; }
    kd.net = net;
    if (c.ip) kd.lastIp = c.ip;
  }
  save();
  return added;
}

// A name the app filled in itself (not one you typed) can be replaced by a better one.
function hasAutoName(kd) {
  if (!kd.name || kd.nameAuto) return true;
  const c = S(netOfKd(kd)).clients.find((x) => x.mac === kd.mac);
  return !!(c && c.hostname && c.hostname === kd.name);
}

// Ask online devices what they are (e.g. a Samsung TV reports its series and model).
// Each device is asked at most once a week.
async function identifyDevices(result) {
  if (!api.identify) return;
  const WEEK = 7 * 24 * 3600 * 1000;
  let changed = false;
  for (const d of result.devices) {
    if (d.isThisPc || d.isGateway) continue;
    const kd = data.devices.find((x) => x.key === keyFor(d));
    if (!kd || (kd.identifiedAt && Date.now() - new Date(kd.identifiedAt) < WEEK)) continue;
    let info = null;
    try { info = await api.identify(d.ip); } catch { /* device didn't answer */ }
    kd.identifiedAt = new Date().toISOString();
    changed = true;
    if (info) {
      if (info.model) kd.model = info.model;
      if (info.name && hasAutoName(kd)) { kd.name = info.name; kd.nameAuto = true; }
    }
  }
  if (changed) { save(); renderDevices(); }
}

// ---------- Connections ----------
function isNew(kd) {
  if (!data.setupTime) return false;
  const first = new Date(kd.firstSeen).getTime();
  return first > new Date(data.setupTime).getTime() + 60000 && Date.now() - first < 24 * 3600 * 1000;
}

// One router's devices with their state right now: online first (by IP), then asleep, then offline (newest first).
// Shared by the Connections table and the Map.
function deviceEntries(net) {
  // Only the network the PC scanned last can have devices "online" right now.
  const online = new Map();
  if (lastScan && lastScanNet === net) for (const d of lastScan.devices) online.set(keyFor(d), d);

  const idle = new Map();
  const prefix = prefixOf(net);
  if (lastScanNet === net) for (const c of S(net).clients) if (!online.has(prefix + c.mac)) idle.set(prefix + c.mac, c);

  const mine = data.devices.filter((k) => netOfKd(k) === net);
  const onlineRows = mine.filter((k) => online.has(k.key))
    .sort((a, b) => ipNum(online.get(a.key).ip) - ipNum(online.get(b.key).ip));
  const idleRows = mine.filter((k) => idle.has(k.key))
    .sort((a, b) => ipNum(a.lastIp || '0') - ipNum(b.lastIp || '0'));
  const offlineRows = mine.filter((k) => !online.has(k.key) && !idle.has(k.key))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return [
    ...onlineRows.map((kd) => ({ kd, d: online.get(kd.key), entry: null, status: 'online' })),
    ...idleRows.map((kd) => ({ kd, d: null, entry: idle.get(kd.key), status: 'asleep' })),
    ...offlineRows.map((kd) => ({ kd, d: null, entry: null, status: 'offline' }))
  ];
}

function renderDevices() {
  if (editingKey) { renderPending = true; return; }
  renderPending = false;
  const net = view.router;
  if (!net) return;

  const entries = deviceEntries(net);
  const mine = entries.map((e) => e.kd);
  const tbody = $('#devTable tbody');
  tbody.replaceChildren(...entries.map((e) => deviceRow(e.kd, e.d, e.entry)));
  renderMap();
  if (!mine.length) {
    const msg = lastScanNet === net ? 'Scanning for devices…'
      : 'No devices seen on this network yet. They appear here when this PC is connected to this router.';
    tbody.append(el('tr', {}, el('td', { colspan: '8', class: 'muted', text: msg })));
  }
  const rename = 'Click a name to rename a device. Phones often use a private address that can change, so the same phone may show up more than once over time.';
  $('#devHint').textContent = supportedKind(net, 'mobile') ? rename
    : `Devices are found by this PC's own scan, so this list only updates while this PC is on this router's network. ${rename}`;
}

function avatarLetter(kd) {
  const n = (kd.name || '').trim();
  return n ? n[0].toUpperCase() : '?';
}

// ---------- Device types and icons ----------
// Static, trusted icon markup (24×24, stroked). Never built from device or router data.
const DEVICE_ICONS = {
  computer: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.2"/><path d="M11 18h2"/>',
  tv: '<rect x="2.5" y="4.5" width="19" height="12.5" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  printer: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><rect x="7" y="14" width="10" height="7"/>',
  console: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7 12.5h4M9 10.5v4"/><path d="M15.5 12h.01M18 13.5h.01"/>',
  speaker: '<rect x="6" y="2.5" width="12" height="19" rx="2"/><circle cx="12" cy="14.5" r="3.2"/><circle cx="12" cy="7" r="1"/>',
  camera: '<rect x="2.5" y="7" width="14" height="10" rx="2"/><path d="M16.5 11l5-2.5v7l-5-2.5"/>',
  watch: '<rect x="6.5" y="6" width="11" height="12" rx="3"/><path d="M9 6l.8-3.5h4.4L15 6M9 18l.8 3.5h4.4L15 18"/>',
  router: '<rect x="3" y="12" width="18" height="8" rx="2"/><path d="M7 16h.01M11 16h.01"/><path d="M8 8.5a6 6 0 0 1 8 0M10 10.5a3 3 0 0 1 4 0"/>',
  unknown: '<rect x="5" y="4" width="14" height="16" rx="2.5"/><path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.4"/><path d="M12 16h.01"/>'
};
const DEVICE_TYPE_NAMES = { computer: 'Computer', phone: 'Phone', tablet: 'Tablet', tv: 'TV', printer: 'Printer', console: 'Games console', speaker: 'Smart speaker', camera: 'Camera', watch: 'Watch', router: 'Router', unknown: 'Unknown type' };

// Works out what a device is from its name, the network name it announced, its model and its address type.
function deviceType(kd, d) {
  if ((d && d.isThisPc) || isThisPcMac(kd.mac)) return 'computer';
  if ((d && d.isGateway) || routers.some((r) => r.host === kd.lastIp)) return 'router';
  const text = `${kd.name || ''} ${(d && d.hostname) || ''} ${kd.model || ''}`.toLowerCase();
  const has = (re) => re.test(text);
  if (has(/\b(tv|television|bravia|roku|chromecast|fire ?tv|firestick|android ?tv|google ?tv|webos|tizen|apple ?tv|smart ?tv|decoder|dstv|gotv|startimes)\b|samsung \d+ series|\b(ue|qe|un|kd|oled)\d{2}/)) return 'tv';
  if (has(/\b(ipad|tab|tablet|galaxy ?tab|kindle|fire ?hd|matepad|mediapad)\b/)) return 'tablet';
  if (has(/\b(watch|band|fitbit|amazfit)\b/)) return 'watch';
  if (has(/\b(iphone|android|galaxy|pixel|redmi|xiaomi|poco|tecno|infinix|itel|oppo|vivo|realme|oneplus|nokia|motorola|moto|huawei|honor|phone|mobile|sm-[a-z]\d)/)) return 'phone';
  if (has(/\b(desktop|laptop|notebook|macbook|imac|mac ?mini|thinkpad|ideapad|elitebook|probook|latitude|inspiron|pavilion|surface|chromebook|windows|pc)\b|desktop-|laptop-|-pc\b/)) return 'computer';
  if (has(/\b(printer|epson|canon|brother|laserjet|deskjet|officejet|hp-?[a-z0-9]*print)/)) return 'printer';
  if (has(/\b(playstation|ps[345]|xbox|nintendo|switch)\b/)) return 'console';
  if (has(/\b(echo|alexa|homepod|google ?home|nest|sonos|speaker)\b/)) return 'speaker';
  if (has(/\b(cam|camera|ipcam|doorbell|ring|wyze|hikvision|dahua|ezviz)\b/)) return 'camera';
  if (isPrivateMac(kd.mac)) return 'phone'; // private (random) addresses are almost always phones or tablets
  return 'unknown';
}

// An icon element usable both in the page and inside the map's SVG.
function deviceIcon(type, size, x, y) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'dev-icon', 'aria-hidden': 'true' };
  if (x != null) { attrs.x = x; attrs.y = y; }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.innerHTML = DEVICE_ICONS[type] || DEVICE_ICONS.unknown; // trusted static markup from DEVICE_ICONS
  return svg;
}

// Router icons for the middle of the map (same drawings as the router buttons).
function routerIcon(kind, size) {
  const svg = svgIcon(kind);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('x', -size / 2);
  svg.setAttribute('y', -size / 2);
  return svg;
}

// ---------- Network map ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs, ...children) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
  for (const c of children) if (c != null) n.append(c);
  return n;
}
let mapSelected = null; // key of the device whose details are open

// How a device is linked to its router: '5', '2.4', 'wired' or null (unknown).
function linkOf(e, net) {
  if (((e.d && e.d.isThisPc) || isThisPcMac(e.kd.mac)) && pcWifi && pcWifi.network === net && pcWifi.band) return pcWifi.band;
  if (supportedKind(net, 'mobile')) {
    const w = e.kd.mac && S(net).wifiClients.find((c) => c.mac === e.kd.mac);
    if (w) return w.band;
    if (e.entry && e.entry.wired) return 'wired';
  }
  return null;
}

// Does the router itself have internet right now? true / false / null (unknown).
function routerInternet(id) {
  if (lastScan && lastScanNet === id) return !!lastScan.internet.received;
  if (supportedKind(id, 'mobile')) return S(id).info ? !!S(id).info.connected : null;
  if (supportedKind(id, 'fibre')) { const l = S(id).fibre && S(id).fibre.last; return l ? !!(l.working && l.internet !== false) : null; }
  return null;
}

const shortName = (s, n = 16) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function renderMap() {
  const id = view.router;
  const r = R(id);
  if (!r || view.section !== 'map') return;
  const all = deviceEntries(id);
  const isRouterDev = (e) => (e.d && e.d.isGateway) || e.kd.lastIp === r.host;
  const devices = all.filter((e) => !isRouterDev(e));

  const W = 960, H = 620, cx = W / 2, cy = 350;
  const svg = $('#netMap');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const edges = sv('g', { class: 'map-edges' });
  const nodes = sv('g', { class: 'map-nodes' });

  // Internet → router
  const net = routerInternet(id);
  edges.append(sv('line', { x1: cx, y1: 102, x2: cx, y2: cy - 40, class: 'map-edge uplink ' + (net === true ? 'up' : net === false ? 'down' : 'unknown') }));
  nodes.append(sv('g', { class: 'map-cloud', transform: `translate(${cx},52)` },
    sv('path', { d: 'M-46 14a20 20 0 0 1 4-39 28 28 0 0 1 52-6 22 22 0 0 1 36 23 18 18 0 0 1-4 22z', class: 'cloud ' + (net === true ? 'up' : net === false ? 'down' : '') }),
    sv('text', { y: 40, class: 'map-label' }, net === true ? 'Internet' : net === false ? 'No internet' : 'Internet (unknown)')));

  // Devices around the router, leaving the top free for the internet line. Two rings when crowded.
  const n = devices.length;
  const rings = n > 14 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
  let idx = 0;
  rings.forEach((count, ring) => {
    const radius = rings.length > 1 ? (ring === 0 ? 175 : 265) : 230;
    const start = -55, span = 290; // degrees; 0 = right, 90 = down
    for (let i = 0; i < count; i++, idx++) {
      const e = devices[idx];
      const ang = ((start + ((i + 0.5) * span) / count + (ring ? span / count / 2 : 0)) * Math.PI) / 180;
      const x = cx + radius * Math.cos(ang) * 1.45; // wider than tall
      const y = cy + radius * Math.sin(ang) * 0.95;
      const link = linkOf(e, id);
      const isPc = (e.d && e.d.isThisPc) || isThisPcMac(e.kd.mac);
      const blocked = isBlocked(id, e.kd.mac);
      edges.append(sv('line', { x1: cx, y1: cy, x2: x, y2: y, class: `map-edge ${e.status} link-${link ? link.replace('.', '') : 'unknown'}` }));
      const g = sv('g', {
        class: `map-node ${e.status}${isPc ? ' pc' : ''}${blocked ? ' blocked' : ''}${mapSelected === e.kd.key ? ' selected' : ''}`,
        transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, tabindex: '0', role: 'button',
        'aria-label': `${e.kd.name || 'Unknown device'}, ${e.status}`
      },
      sv('circle', { r: 25, class: 'node-base' }),
      sv('circle', { r: 25, class: 'node-bg' }),
      deviceIcon(deviceType(e.kd, e.d), 28, -14, -14),
      sv('circle', { r: 6, cx: 18, cy: -18, class: 'node-dot' }),
      sv('text', { y: 44, class: 'map-label' }, shortName(e.kd.name || 'Unknown device')),
      sv('text', { y: 59, class: 'map-sub' }, [e.d ? e.d.ip : e.kd.lastIp, link ? (link === 'wired' ? 'Wired' : `${link} GHz`) : null].filter(Boolean).join(' · ')));
      const pick = () => { mapSelected = e.kd.key; renderMap(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      nodes.append(g);
    }
  });

  // The router in the middle
  nodes.append(sv('g', { class: 'map-router ' + (net === true ? 'up' : net === false ? 'down' : ''), transform: `translate(${cx},${cy})` },
    sv('circle', { r: 38, class: 'node-base' }),
    sv('circle', { r: 38, class: 'node-bg' }),
    routerIcon(r.kind, 34),
    sv('text', { y: 58, class: 'map-label strong' }, shortName(r.name, 22)),
    sv('text', { y: 73, class: 'map-sub' }, r.host)));

  if (!n) nodes.append(sv('text', { x: cx, y: cy + 130, class: 'map-sub' }, 'No devices seen on this network yet.'));
  svg.replaceChildren(edges, nodes);
  renderMapDetail(devices);
}

function renderMapDetail(devices) {
  const box = $('#mapDetail');
  const id = view.router;
  const e = devices.find((x) => x.kd.key === mapSelected);
  if (!e) {
    const count = (s) => devices.filter((x) => x.status === s).length;
    box.replaceChildren(
      el('h3', { text: 'On this network' }),
      el('p', {}, el('strong', { text: String(count('online')) }), ' online · ', el('strong', { text: String(count('asleep')) }), ' asleep · ', el('strong', { text: String(count('offline')) }), ' offline'),
      el('p', { class: 'muted small', text: lastScanNet === id ? 'Click a device on the map to see its details.' : "This PC isn't on this router's network, so who's online right now is unknown. Click a device for its last known details." }));
    return;
  }
  const { kd, d } = e;
  const link = linkOf(e, id);
  const w = supportedKind(id, 'mobile') && kd.mac ? S(id).wifiClients.find((c) => c.mac === kd.mac) : null;
  const isPc = (d && d.isThisPc) || isThisPcMac(kd.mac);
  const rows = [
    ['Type', DEVICE_TYPE_NAMES[deviceType(kd, d)]],
    ['Status', e.status === 'asleep' ? 'Asleep (joined, not answering)' : e.status[0].toUpperCase() + e.status.slice(1)],
    ['IP address', (d && d.ip) || kd.lastIp || '–'],
    ['Hardware (MAC)', kd.mac || '–'],
    ['Connection', link ? (link === 'wired' ? 'Wired' : `${link} GHz Wi-Fi`) : 'Unknown'],
    ...(w && w.signalDbm != null ? [['Signal', `${signalWord(w.signalDbm)} · ${w.signalDbm} dBm`]] : []),
    ...(d && d.pingMs != null ? [['Response', `${d.pingMs} ms`]] : []),
    ['Last seen', d ? 'Now' : kd.lastSeen ? ago(kd.lastSeen) : '–'],
    ...(kd.model ? [['Model', kd.model]] : []),
    ...(isPrivateMac(kd.mac) ? [['Note', 'Private address: usually a phone or tablet']] : []),
    ...(isBlocked(id, kd.mac) ? [['Note', 'Blocked from Wi-Fi']] : [])
  ];
  const actions = [el('button', { type: 'button', text: 'Show in Connections', onclick: () => openInApp(id, 'connections') })];
  if (R(id) && R(id).canBlock && kd.mac && !isPc && kd.lastIp !== R(id).host) {
    if (isBlocked(id, kd.mac)) actions.push(el('button', { class: 'act-btn', type: 'button', text: 'Unblock', onclick: () => deviceAction('unblock', kd) }));
    else {
      actions.push(el('button', { class: 'act-btn', type: 'button', text: 'Disconnect', onclick: () => deviceAction('disconnect', kd) }));
      actions.push(el('button', { class: 'act-btn danger', type: 'button', text: 'Block', onclick: () => deviceAction('block', kd) }));
    }
  }
  box.replaceChildren(
    el('div', { class: 'map-detail-head' },
      el('span', { class: 'avatar icon', title: DEVICE_TYPE_NAMES[deviceType(kd, d)] }, deviceIcon(deviceType(kd, d), 20)),
      el('div', {}, el('strong', { text: kd.name || 'Unknown device' }), el('span', { class: 'pill ' + e.status, text: e.status[0].toUpperCase() + e.status.slice(1) })),
      el('button', { class: 'link', type: 'button', title: 'Close', 'aria-label': 'Close details', text: '✕', onclick: () => { mapSelected = null; renderMap(); } })),
    el('table', { class: 'kv compact' }, el('tbody', {}, ...rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: v }))))),
    el('div', { class: 'row' }, ...actions));
}

// ---------- Wi-Fi band per device ----------
async function refreshWifiInfo(net) {
  if (api.pcWifi) { try { pcWifi = await api.pcWifi(); } catch { /* keep the last one */ } }
  if (net && supportedKind(net, 'mobile')) { try { S(net).wifiClients = await api.wifiClients(net); } catch { /* router busy */ } }
  renderWifiEverywhere();
}

// Everything that names the PC's network: router subtitles, Information tables, status line.
function renderWifiEverywhere() {
  renderRouterSubs();
  renderSettingsHints();
  renderInfo4g();
  renderFibre();
  renderGeneric();
}

function signalWord(dbm) {
  if (dbm == null) return '';
  return dbm >= -55 ? 'Strong' : dbm >= -67 ? 'Good' : dbm >= -75 ? 'Fair' : 'Weak';
}

const bandLabel = (b) => (b === '5' ? '5 GHz' : b === '2.4' ? '2.4 GHz' : b);

function wifiCell(kd, d, routerEntry) {
  const net = netOfKd(kd);
  const isPc = (d && d.isThisPc) || (pcWifi && kd.mac && lastScan && lastScan.devices.some((x) => x.isThisPc && x.mac === kd.mac));

  // This PC: a selector that moves it between the router's two networks.
  if (isPc && pcWifi && pcWifi.options && pcWifi.network === net) {
    const sel = el('select', { class: 'band-select', 'aria-label': 'Wi-Fi band for this PC', title: 'Move this PC to the other Wi-Fi band' },
      ...['5', '2.4'].map((b) => {
        const o = el('option', { value: b, text: `${bandLabel(b)} · ${pcWifi.options[b]}` });
        if (pcWifi.band === b) o.selected = true;
        return o;
      }));
    sel.disabled = bandSwitching;
    sel.addEventListener('change', () => switchPcBand(sel.value, sel));
    return el('div', { class: 'band-cell' }, sel,
      el('span', { class: 'band-sub', text: bandSwitching ? 'Switching…' : `Signal ${pcWifi.signal || '–'}${pcWifi.rateMbps ? ` · ${Math.round(pcWifi.rateMbps)} Mbps link` : ''}` }));
  }
  if (isPc && pcWifi && pcWifi.network === net && pcWifi.band) {
    return el('div', { class: 'band-cell', title: 'Add both Wi-Fi names under Information › Router settings to switch bands from here.' },
      el('span', { class: 'band-pill b' + pcWifi.band.replace('.', ''), text: bandLabel(pcWifi.band) }),
      el('span', { class: 'band-sub', text: `Signal ${pcWifi.signal || '–'}` }));
  }

  if (supportedKind(net, 'mobile')) {
    const w = kd.mac && S(net).wifiClients.find((c) => c.mac === kd.mac);
    if (w) {
      const other = w.band === '5' ? '2.4' : '5';
      const otherSsid = netNames(net)[other] || `the router's ${bandLabel(other)} network`;
      return el('div', { class: 'band-cell', title: `To move it to ${bandLabel(other)}, join "${otherSsid}" on the device itself (same password).` },
        el('span', { class: 'band-pill b' + w.band.replace('.', ''), text: bandLabel(w.band) }),
        el('span', { class: 'band-sub', text: [signalWord(w.signalDbm), w.signalDbm != null ? `${w.signalDbm} dBm` : ''].filter(Boolean).join(' · ') }));
    }
    if (routerEntry && routerEntry.wired) return el('span', { class: 'band-pill wired', text: 'Wired' });
  }
  return el('span', { class: 'muted', text: '–' });
}

async function switchPcBand(band, sel) {
  const target = pcWifi.options[band];
  if (!confirm(`Move this PC to ${bandLabel(band)} ("${target}")? The internet on this PC drops for a few seconds while it switches.`)) {
    renderDevices();
    return;
  }
  bandSwitching = true;
  sel.disabled = true;
  setStatus(`Switching this PC to ${bandLabel(band)}…`, 'busy');
  try {
    pcWifi = await api.setPcBand(band);
    setStatus(`This PC is now on ${bandLabel(pcWifi.band)} ("${pcWifi.ssid}").`);
  } catch (e) {
    setStatus('Could not switch band: ' + cleanError(e), 'bad');
    try { pcWifi = await api.pcWifi(); } catch { /* ignore */ }
  } finally {
    bandSwitching = false;
    renderWifiEverywhere();
    renderDevices();
    scan();
  }
}

function deviceRow(kd, d, routerEntry) {
  const isOnline = !!d;
  const isIdle = !isOnline && !!routerEntry;
  const chips = [];
  if (isIdle) chips.push(el('span', { class: 'chip', text: 'Connected to the router but not answering. Usually a sleeping phone or tablet' }));
  if (isIdle && routerEntry.hostname) chips.push(el('span', { class: 'chip', text: 'Network name: ' + routerEntry.hostname }));
  if (isOnline && d.isGateway) chips.push(el('span', { class: 'chip router', text: 'Your router' }));
  if (isOnline && d.isThisPc) chips.push(el('span', { class: 'chip info', text: 'This computer' }));
  if (isNew(kd)) chips.push(el('span', { class: 'chip new', text: 'New today' }));
  if (kd.model) chips.push(el('span', { class: 'chip', text: 'Model: ' + kd.model }));
  if (isPrivateMac(kd.mac)) chips.push(el('span', { class: 'chip info', text: 'Private address · usually a phone or tablet' }));
  if (isOnline && d.hostname && !d.isThisPc) chips.push(el('span', { class: 'chip', text: 'Network name: ' + shortHost(d.hostname) }));
  if (isOnline && d.pingMs == null) chips.push(el('span', { class: 'chip', text: 'Ignores ping (normal for some devices)' }));

  const net = netOfKd(kd);
  const blocked = isBlocked(net, kd.mac);
  if (blocked) chips.unshift(el('span', { class: 'chip blocked', text: 'Blocked from Wi-Fi' }));

  const forget = (isOnline && (d.isThisPc || d.isGateway))
    ? null
    : el('button', { class: 'forget-btn', type: 'button', title: 'Forget this device', 'aria-label': 'Forget this device', text: '✕', onclick: () => forgetDevice(kd) });

  // Disconnect / block, on routers whose login allows it. Never for this PC or the router itself.
  const actions = [];
  const isPc = (d && d.isThisPc) || isThisPcMac(kd.mac);
  const isRouter = (d && d.isGateway) || (R(net) && (kd.lastIp === R(net).host || (d && d.ip === R(net).host)));
  if (R(net) && R(net).canBlock && kd.mac && !isPc && !isRouter) {
    const busy = deviceBusy === kd.key;
    if (blocked) {
      actions.push(el('button', { class: 'act-btn', type: 'button', text: busy ? 'Working…' : 'Unblock', onclick: () => deviceAction('unblock', kd) }));
    } else {
      actions.push(el('button', { class: 'act-btn', type: 'button', title: 'Kick it off; it can reconnect straight away', text: busy ? 'Working…' : 'Disconnect', onclick: () => deviceAction('disconnect', kd) }));
      actions.push(el('button', { class: 'act-btn danger', type: 'button', title: 'Keep it off the Wi-Fi until you unblock it', text: 'Block', onclick: () => deviceAction('block', kd) }));
    }
    if (deviceBusy) for (const b of actions) b.disabled = true;
  }

  const status = isOnline ? 'Online' : isIdle ? 'Asleep' : 'Offline';
  const seen = isOnline ? 'Now' : isIdle ? (kd.lastSeen ? ago(kd.lastSeen) : 'Listed by router') : (kd.lastSeen ? ago(kd.lastSeen) : '–');

  return el('tr', { class: isOnline || isIdle ? '' : 'offline' },
    el('td', {}, el('div', { class: 'dev-cell' },
      el('span', { class: 'avatar icon', title: DEVICE_TYPE_NAMES[deviceType(kd, d)] }, deviceIcon(deviceType(kd, d), 20)),
      el('div', { class: 'dev-name' }, nameCell(kd), el('span', { class: 'dev-mac mono', text: kd.mac || '' })))),
    el('td', {}, el('span', { class: 'pill ' + status.toLowerCase(), text: status })),
    el('td', {}, wifiCell(kd, d, routerEntry)),
    el('td', { class: 'mono', text: isOnline ? d.ip : (kd.lastIp || '') }),
    el('td', { class: 'num', text: isOnline && d.pingMs != null ? `${d.pingMs} ms` : '–' }),
    el('td', { class: 'num', text: seen }),
    el('td', {}, el('div', { class: 'chips' }, ...chips)),
    el('td', {}, el('div', { class: 'row-actions' }, ...actions, forget))
  );
}

// ---------- Disconnect and block ----------
let deviceBusy = null; // key of the device being disconnected / blocked right now
const macKey = (mac) => String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();

function isBlocked(id, mac) {
  const f = S(id).fibre;
  const list = f && f.last && f.last.blocked;
  return !!(mac && Array.isArray(list) && list.some((e) => macKey(e.mac) === macKey(mac)));
}

function isThisPcMac(mac) {
  return !!(mac && lastScan && lastScan.devices.some((x) => x.isThisPc && macKey(x.mac) === macKey(mac)));
}

async function deviceAction(kind, kd) {
  const id = netOfKd(kd);
  const r = R(id);
  const f = S(id).fibre || {};
  const viaWifi = !f.reachable;
  const name = kd.name || kd.mac;
  if (viaWifi && !f.ssid) { alert(`This PC isn't on ${r.name}'s network. Add its 5 GHz Wi-Fi name under Information › Router settings so the app can switch to it briefly.`); return; }
  const hop = viaWifi ? `\n\nThis PC isn't on ${r.name}'s network, so it will switch to "${f.ssid}" for about a minute to do this, then switch back. The internet on this PC drops meanwhile.` : '';
  const ask = {
    disconnect: `Disconnect "${name}" from ${r.name}?\n\nThe app blocks it for about 10 seconds, then lets it back in. Most devices reconnect by themselves.${hop}`,
    block: `Block "${name}" from ${r.name}'s Wi-Fi?\n\nIt stays off until you unblock it here. Phones that use a private address can get round a block by changing their address.${hop}`,
    unblock: `Allow "${name}" back on ${r.name}'s Wi-Fi?${hop}`
  }[kind];
  if (!confirm(ask)) return;

  deviceBusy = kd.key;
  fibreSwitching = viaWifi; // pauses scans while the PC is on the other network
  renderDevices();
  setStatus({ disconnect: `Disconnecting ${name}…`, block: `Blocking ${name}…`, unblock: `Unblocking ${name}…` }[kind], 'busy');
  try {
    const res = kind === 'disconnect' ? await api.disconnectDevice(id, kd.mac, name, 10, viaWifi)
      : kind === 'block' ? await api.blockDevice(id, kd.mac, name, viaWifi)
        : await api.unblockDevice(id, kd.mac, viaWifi);
    if (S(id).fibre && S(id).fibre.last) S(id).fibre.last.blocked = res.blocked;
    setStatus({ disconnect: `${name} was disconnected and can reconnect now.`, block: `${name} is blocked from ${r.name}'s Wi-Fi.`, unblock: `${name} can use ${r.name}'s Wi-Fi again.` }[kind]);
  } catch (e) {
    setStatus(`Could not ${kind} ${name}: ${cleanError(e)}`, 'bad');
  } finally {
    deviceBusy = null;
    fibreSwitching = false;
    renderDevices();
    if (viaWifi) scan();
  }
}

function nameCell(kd) {
  return el('button', {
    class: 'name-btn' + (kd.name ? '' : ' unnamed'),
    title: 'Click to rename',
    text: kd.name || 'Unknown device',
    onclick: (e) => startRename(kd, e.currentTarget)
  });
}

function startRename(kd, btn) {
  editingKey = kd.key;
  const input = el('input', { class: 'name-input', value: kd.name || '', placeholder: 'e.g. Samsung TV' });
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const typed = input.value.trim();
      if (typed !== (kd.name || '')) {
        kd.name = typed;
        kd.nameAuto = !typed; // your own names are never replaced automatically
        save();
      }
    }
    editingKey = null;
    input.replaceWith(nameCell(kd));
    if (renderPending) renderDevices();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  btn.replaceWith(input);
  input.focus();
  input.select();
}

function forgetDevice(kd) {
  const label = kd.name || kd.lastIp || kd.key;
  if (!confirm(`Forget "${label}"? If it is still connected it will come back as a new device.`)) return;
  data.devices = data.devices.filter((x) => x !== kd);
  save();
  renderDevices();
}

// ---------- Dashboard cards ----------
// value may carry a unit ("114 ms" → 114 + small "ms") so the big number stays readable.
function setStat(id, value, sub, tone) {
  const v = $('#' + id);
  const m = /^([\d.,-]+)\s+([A-Za-z%]+)$/.exec(String(value));
  if (m) v.replaceChildren(m[1], el('small', { text: m[2] }));
  else v.textContent = value;
  v.className = 'value' + (v.classList.contains('small-value') || id === 'statGenModel' ? ' small-value' : '') + (tone ? ' ' + tone : '');
  $('#' + id + 'Sub').textContent = sub || '';
}

// Ring gauge: online (green) then asleep (yellow) as parts of all known devices.
function setRing(online, asleep, total) {
  const C = 2 * Math.PI * 26;
  const on = total ? (online / total) * C : 0;
  const sl = total ? (asleep / total) * C : 0;
  $('#ringOnline').setAttribute('stroke-dasharray', `${on} ${C}`);
  $('#ringAsleep').setAttribute('stroke-dasharray', `${on + sl} ${C}`);
}

function setBars(id, level, tone) {
  const svg = $('#' + id);
  svg.setAttribute('class', 'bars ' + (tone || ''));
  [...svg.querySelectorAll('rect')].forEach((r, i) => r.setAttribute('class', level != null && i < level ? 'on' : ''));
}

function setSpark(id, values, tone) {
  const svg = $('#' + id);
  svg.setAttribute('class', 'spark ' + (tone || ''));
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const line = svg.querySelector('polyline');
  const dot = svg.querySelector('circle');
  if (pts.length < 2) { line.setAttribute('points', ''); dot.setAttribute('r', 0); return; }
  dot.setAttribute('r', 3);
  const max = Math.max(...pts.map((p) => p[1])), min = Math.min(...pts.map((p) => p[1]));
  const span = Math.max(1, max - min), n = Math.max(values.length - 1, 1);
  const xy = pts.map(([i, v]) => [(i / n) * 116 + 2, 36 - ((v - min) / span) * 32]);
  line.setAttribute('points', xy.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' '));
  const [lx, ly] = xy[xy.length - 1];
  dot.setAttribute('cx', lx.toFixed(1));
  dot.setAttribute('cy', ly.toFixed(1));
}

function pingTone(net) {
  const lost = net.sent - net.received;
  return !net.received ? 'bad' : lost === 0 && net.avgMs < 80 ? 'good' : lost <= 1 && net.avgMs < 200 ? 'warn' : 'bad';
}

const offNetText = (id) => `This PC isn't on ${R(id) ? R(id).name : 'this router'}'s network right now`;

function renderStats() {
  if (lastScan) {
    const r = R(lastScanNet);
    const where = r ? r.name : `an unknown router (${lastScan.gateway || 'no gateway'})`;
    const wifiName = pcWifi && pcWifi.ssid ? `, ${pcWifi.ssid} (${bandLabel(pcWifi.band)})` : '';
    setStatus(`Last scan ${new Date(lastScan.scannedAt).toLocaleTimeString()} · This PC ${lastScan.myIp} on ${where}${wifiName}`);
  }

  const id = activeOf('mobile');
  if (id) {
    const mine = data.devices.filter((k) => netOfKd(k) === id);
    if (lastScan && lastScanNet === id) {
      const count = lastScan.devices.length;
      const onlineKeys = new Set(lastScan.devices.map(keyFor));
      const prefix = prefixOf(id);
      const asleep = S(id).clients.filter((c) => !onlineKeys.has(prefix + c.mac)).length;
      const offline = mine.length - count - asleep;
      const parts = [];
      if (asleep) parts.push(`${asleep} asleep`);
      if (offline > 0) parts.push(`${offline} offline`);
      setStat('statDevices', String(count), parts.length ? parts.join(' · ') : 'All known devices online');
      setRing(count, asleep, Math.max(mine.length, count + asleep));
      const net = lastScan.internet;
      if (!net.received) setStat('statNet', 'Offline', 'No reply from the internet', 'bad');
      else setStat('statNet', `${net.avgMs} ms`, `${net.sent - net.received} of ${net.sent} test pings lost`, pingTone(net));
      setSpark('spark4g', S(id).ping, pingTone(net));
      api.setTrayText(`Home Network Monitor · ${count} device${count === 1 ? '' : 's'} online`);
    } else {
      setStat('statDevices', '–', lastScan ? offNetText(id) : 'Scanning…');
      setStat('statNet', '–', lastScan ? offNetText(id) : 'Scanning…');
      setRing(0, 0, 1);
      setSpark('spark4g', S(id).ping, '');
    }
    const bal = balanceSummary(id);
    if (bal) setStat('statData', fmtMb(bal.last.mb), bal.daysText || `Updated ${ago(bal.last.time)}`, bal.tone);
    else setStat('statData', '–', 'Checking…');
  }

  renderSignal();
  renderFibre();
  renderGeneric();
  renderDots();
}

// ---------- 4G routers (signal, usage) ----------
const SIGNAL_WORDS = ['No signal', 'Very weak', 'Weak', 'Fair', 'Good', 'Excellent'];

async function refreshRouter(id) {
  if (!supportedKind(id, 'mobile')) return;
  try {
    S(id).info = await api.routerStatus(id);
    S(id).error = null;
  } catch (e) {
    S(id).error = cleanError(e);
  }
  renderSignal();
  renderRouterUsage();
  renderDots();
}

function renderSignal() {
  renderInfo4g();
  const id = activeOf('mobile');
  if (!id) return;
  const { info: r, error } = S(id);
  if (error && !r) {
    const offNet = lastScan && lastScanNet !== id;
    setStat('statSignal', '–', offNet ? offNetText(id) : error, offNet ? '' : 'bad');
    setBars('bars4g', null);
    return;
  }
  if (!r) { setStat('statSignal', '–', 'Checking…'); return; }
  if (!r.simReady) { setStat('statSignal', 'No SIM', 'The router cannot read its SIM card', 'bad'); setBars('bars4g', 0, 'bad'); return; }
  const lvl = r.signalLevel == null ? null : Math.max(0, Math.min(5, r.signalLevel));
  const word = lvl == null ? '–' : SIGNAL_WORDS[lvl];
  const tone = lvl == null ? '' : lvl <= 2 ? 'bad' : lvl === 3 ? 'warn' : 'good';
  const parts = [];
  if (r.networkType) parts.push(r.networkType);
  if (r.operator) parts.push(r.operator);
  if (!r.connected) parts.push('not connected');
  setStat('statSignal', word, parts.join(' · '), tone);
  setBars('bars4g', lvl, tone);
}

function kvRows(tbody, rows) {
  $(tbody).replaceChildren(...rows.map(([label, value, tone]) =>
    el('tr', {}, el('th', { text: label }), el('td', { class: tone || '', text: value }))));
}

function renderInfo4g() {
  const id = activeOf('mobile');
  if (!id) return;
  const { info: r, error } = S(id);
  const base = [['Model', R(id).model], ['Router address', R(id).host]];
  if (!r) {
    kvRows('#info4g', [['Status', error || 'Checking…', error ? 'bad' : ''], ...base, ...wifiInfoRows(id)]);
    return;
  }
  const lvl = r.signalLevel == null ? null : Math.max(0, Math.min(5, r.signalLevel));
  kvRows('#info4g', [
    ['Mobile network', r.operator || '–'],
    ['Network type', r.networkType || '–'],
    ['Signal', lvl == null ? '–' : `${SIGNAL_WORDS[lvl]} (level ${lvl} of 5)`, lvl == null ? '' : lvl <= 2 ? 'bad' : lvl === 3 ? 'warn' : 'good'],
    ['SIM card', r.simReady ? 'Ready' : 'Not readable', r.simReady ? 'good' : 'bad'],
    ['Internet connection', r.connected ? 'Connected' : 'Not connected', r.connected ? 'good' : 'bad'],
    ['Downloaded since restart', r.rxBytes == null ? '–' : fmtMb(r.rxBytes / 1048576)],
    ['Uploaded since restart', r.txBytes == null ? '–' : fmtMb(r.txBytes / 1048576)],
    ...base,
    ...wifiInfoRows(id)
  ]);
}

// A router's current 2.4 / 5 GHz network names, as the server last read them (they can be renamed).
function netNames(id) {
  const n = pcWifi && pcWifi.networks && pcWifi.networks[id];
  return { '5': (n && n['5']) || null, '2.4': (n && n['2.4']) || null };
}

// The router's two Wi-Fi networks and which one this PC is on, for the Information tables.
function wifiInfoRows(id) {
  const opts = netNames(id);
  const onIt = pcWifi && pcWifi.network === id;
  const names = [opts['5'] && `${opts['5']} (5 GHz)`, opts['2.4'] && `${opts['2.4']} (2.4 GHz)`].filter(Boolean).join(' · ');
  return [
    ['Wi-Fi networks', names || 'Not known yet. Add them under Router settings'],
    ['This PC is on', onIt ? `${pcWifi.ssid} · ${bandLabel(pcWifi.band)} · signal ${pcWifi.signal || '–'}` : 'Not this router', onIt ? 'good' : '']
  ];
}

function renderRouterUsage() {
  const id = activeOf('mobile');
  const p = $('#routerUsage');
  const r = id && S(id).info;
  if (!r || r.rxBytes == null) { p.textContent = ''; return; }
  const mb = (r.rxBytes + (r.txBytes || 0)) / 1048576;
  p.textContent = `The router has used ${fmtMb(mb)} since it was last restarted ` +
    `(${fmtMb(r.rxBytes / 1048576)} down, ${fmtMb((r.txBytes || 0) / 1048576)} up).`;
}

// ---------- USSD balance check through a 4G router ----------
// Finds amounts like "2.5GB" or "750 MB" in the network's reply.
function findAmounts(text) {
  const found = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(GB|MB|KB)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toUpperCase();
    const mb = unit === 'GB' ? value * 1024 : unit === 'KB' ? value / 1024 : value;
    found.push({ value, unit, mb, label: `${m[1]} ${unit}` });
  }
  return found;
}

// Picks the data balance out of a reply: the "Internet bundle" amount if the network labels it,
// otherwise the only amount in the message.
function pickDataBalance(text) {
  const labelled = /internet\s*bundle\s*:?\s*(\d+(?:[.,]\d+)?)\s*(GB|MB|KB)\b/i.exec(text);
  if (labelled) return findAmounts(labelled[1] + labelled[2])[0];
  const amounts = findAmounts(text);
  return amounts.length === 1 ? amounts[0] : null;
}

const balancesOf = (id) => (data.balancesBy[id] || (data.balancesBy[id] = []));

function recordBalance(id, mb) {
  const now = new Date().toISOString();
  const last = sortedBalances(id).pop();
  // Same amount checked again within the hour: just refresh its time instead of adding a row.
  if (last && Math.abs(last.mb - mb) < 0.01 && Date.now() - new Date(last.time) < 3600 * 1000) last.time = now;
  else balancesOf(id).push({ time: now, mb });
  save();
  renderBalance();
  renderStats();
}

function showUssdReply(id, result) {
  $('#ussdBox').hidden = false;
  $('#ussdReply').textContent = result.message;
  $('#ussdReplyForm').hidden = !result.needReply;
  if (result.needReply) $('#ussdReplyInput').focus();

  const found = $('#ussdFound');
  const balance = result.needReply ? null : pickDataBalance(result.message);
  if (balance) {
    recordBalance(id, balance.mb);
    found.className = 'small found';
    found.textContent = `Saved ${fmtMb(balance.mb)} as your data left.`;
    return;
  }

  const amounts = findAmounts(result.message);
  if (amounts.length) {
    const first = amounts[0];
    $('#balValue').value = first.unit === 'KB' ? (first.mb).toFixed(2) : first.value;
    $('#balUnit').value = first.unit === 'GB' ? 'GB' : 'MB';
    found.className = 'small found';
    found.textContent = amounts.length === 1
      ? `Found ${first.label}. It's filled in below. Click "Save balance" to record it.`
      : `Found ${amounts.map((a) => a.label).join(', ')}. The first one is filled in below. Change it if a different one is your data balance, then click "Save balance".`;
  } else {
    found.className = 'small muted';
    found.textContent = result.needReply ? 'Choose an option from the menu above.' : 'No data amount found in this reply.';
  }
}

async function sendUssd(id, code, button) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Waiting for the network…';
  $('#ussdBox').hidden = false;
  $('#ussdReply').textContent = `Sending ${code} through the router. Replies usually take 5–15 seconds…`;
  $('#ussdFound').textContent = '';
  $('#ussdReplyForm').hidden = true;
  try {
    showUssdReply(id, await api.routerUssd(id, code));
  } catch (e) {
    $('#ussdReply').textContent = 'Could not check: ' + cleanError(e);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

function setupUssd() {
  $('#checkNow').addEventListener('click', () => {
    const id = activeOf('mobile');
    const code = $('#ussd').value.trim();
    if (!id) return;
    if (!code) { $('#ussd').focus(); return; }
    sendUssd(id, code, $('#checkNow'));
  });

  // Keep the "Data left" card fresh: check whenever the last check of the 4G router shown is over 3 hours old.
  const autoCheck = () => {
    const id = activeOf('mobile');
    if (!id || (lastScan && lastScanNet !== id)) return; // only when the PC is on that router's network
    const last = sortedBalances(id).pop();
    const stale = !last || Date.now() - new Date(last.time) > AUTO_BALANCE_MS;
    const code = data.ussdBy[id];
    if (stale && code && !$('#checkNow').disabled) sendUssd(id, code, $('#checkNow'));
  };
  setTimeout(autoCheck, 8000);
  setInterval(autoCheck, 15 * 60 * 1000);

  $('#ussdReplyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = activeOf('mobile');
    const reply = $('#ussdReplyInput').value.trim();
    if (!reply || !id) return;
    $('#ussdReplyInput').value = '';
    sendUssd(id, reply, e.submitter || $('#ussdReplyForm button[type=submit]'));
  });

  $('#ussdCancel').addEventListener('click', async () => {
    const id = activeOf('mobile');
    try { if (id) await api.routerUssdCancel(id); } catch { /* session may already be over */ }
    $('#ussdReplyForm').hidden = true;
    $('#ussdFound').textContent = 'Session ended.';
  });

  $('#ussd').addEventListener('input', () => {
    const id = activeOf('mobile');
    if (!id) return;
    data.ussdBy[id] = $('#ussd').value.trim();
    save();
  });

  $('#balForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = activeOf('mobile');
    const value = parseFloat($('#balValue').value);
    if (!id || !(value > 0)) return;
    recordBalance(id, $('#balUnit').value === 'GB' ? value * 1024 : value);
    $('#balValue').value = '';
  });
}

// ---------- Data balance ----------
function sortedBalances(id) {
  return [...balancesOf(id)].sort((a, b) => new Date(a.time) - new Date(b.time));
}

function balanceSummary(id) {
  const list = sortedBalances(id);
  if (!list.length) return null;
  const last = list[list.length - 1];
  const summary = { last, rateText: '', daysText: '', tone: '' };

  // Rate since the last top-up: walk back while the balance only went down.
  let start = list.length - 1;
  while (start > 0 && list[start - 1].mb >= list[start].mb) start--;
  const days = (new Date(last.time) - new Date(list[start].time)) / 86400000;
  const used = list[start].mb - last.mb;

  if (start === list.length - 1 || days < 1 / 24 || used <= 0) {
    summary.rateText = "Enter your balance again later (a few hours or a day) to see how fast you're using data.";
    return summary;
  }

  const perDay = used / days;
  const runOut = new Date(new Date(last.time).getTime() + (last.mb / perDay) * 86400000);
  const daysFromNow = (runOut - Date.now()) / 86400000;
  summary.rateText = `You're using about ${fmtMb(perDay)} per day (since ${fmtDate(list[start].time)}).`;
  if (daysFromNow <= 0) {
    summary.daysText = 'May have run out already';
    summary.longDays = 'At that rate your data may already have run out. Check your balance.';
    summary.tone = 'bad';
  } else {
    summary.daysText = `About ${fmtDays(daysFromNow)} left at your usage rate`;
    summary.longDays = `At that rate it runs out in about ${fmtDays(daysFromNow)} (around ${fmtDate(runOut.toISOString())}).`;
    summary.tone = daysFromNow < 3 ? 'bad' : daysFromNow < 7 ? 'warn' : 'good';
  }
  return summary;
}

function renderBalance() {
  const id = activeOf('mobile');
  if (!id) return;
  if (data.ussdBy[id] == null) data.ussdBy[id] = '*124#'; // MTN balance code
  if (document.activeElement !== $('#ussd')) $('#ussd').value = data.ussdBy[id];
  const s = balanceSummary(id);
  $('#balBig').textContent = s ? `${fmtMb(s.last.mb)} left` : '–';
  $('#balWhen').textContent = s ? `Updated ${ago(s.last.time)}` : 'No balance yet.';
  $('#balRate').textContent = s ? s.rateText : '';
  const days = $('#balDays');
  days.textContent = s && s.longDays ? s.longDays : '';
  days.className = s && s.tone ? s.tone : '';

  const list = sortedBalances(id);
  const rows = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    let change = '';
    if (i > 0) {
      const diff = entry.mb - list[i - 1].mb;
      change = diff > 0 ? `+${fmtMb(diff)} (top-up)` : diff < 0 ? `−${fmtMb(-diff)} used` : 'no change';
    }
    rows.push(el('tr', {},
      el('td', { text: fmtDate(entry.time, true) }),
      el('td', { class: 'num', text: fmtMb(entry.mb) }),
      el('td', { class: 'num', text: change }),
      el('td', {}, el('button', {
        class: 'link', title: 'Delete this entry', 'aria-label': 'Delete this entry', text: '✕',
        onclick: () => {
          data.balancesBy[id] = balancesOf(id).filter((b) => b !== entry);
          save();
          renderBalance();
          renderStats();
        }
      }))
    ));
  }
  $('#histTable tbody').replaceChildren(...rows);
  $('#histEmpty').hidden = list.length > 0;
  renderRouterUsage();
}

// ---------- Fibre routers (ONT) ----------
const fmtDbm = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dBm`);

function fmtUptime(sec) {
  if (sec == null) return '–';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

// Turns a reading into a headline, a tone and a plain explanation.
function fibreVerdict(r, id) {
  const p = provider(id);
  if (!r) return { word: 'Not checked', tone: '', explain: '' };
  const o = r.optical || {};
  const rxLow = o.rxDbm == null || (o.rxRange && o.rxDbm < o.rxRange[0]);
  if (r.working && r.internet === false) {
    return { word: 'No internet', tone: 'warn', explain: `The router is registered with ${p}, but the internet test failed. The account may be out of data or suspended. Ask ${p}.` };
  }
  if (r.working) return { word: 'Working', tone: 'good', explain: `The fibre is registered with ${p} and the internet is reachable.` };
  if (!o.ok || rxLow) {
    return { word: 'No fibre signal', tone: 'bad', explain: `Little or no light is arriving on the fibre. Check that the thin fibre cable is firmly plugged in and not sharply bent, and look for a red LOS light. If it stays like this, ${p} needs to repair the line.` };
  }
  if (r.state === 'O6') return { word: 'Unstable', tone: 'warn', explain: `The fibre signal keeps dropping. Check the cable for sharp bends; if it continues, report it to ${p}.` };
  if (r.state === 'O7') return { word: 'Disabled', tone: 'bad', explain: `${p} has switched this router off on their side. Contact ${p}.` };
  if (r.state === 'O1') return { word: 'Starting', tone: 'warn', explain: 'The router is still starting up. Check again in a few minutes.' };
  return {
    word: 'Not registered', tone: 'bad', mtn: true,
    explain: `The fibre signal is good, but ${p}'s network hasn't registered this router (state ${r.state || 'unknown'}: ${r.stateText}). This is fixed on ${p}'s side: the line may not be activated, or the router's serial number isn't on the account.`
  };
}

async function refreshFibre(id) {
  if (!supportedKind(id, 'fibre') || fibreSwitching) return;
  try { setFibre(id, await api.fibreStatus(id)); }
  catch (e) { S(id).fibre = { ...(S(id).fibre || {}), error: cleanError(e) }; renderFibre(); renderDots(); }
}

function setFibre(id, summary) {
  const before = S(id).fibre && S(id).fibre.last;
  S(id).fibre = summary;
  const now = summary.last;
  // Tell the user when the fibre comes to life (or breaks again).
  if (now && before && now.checkedAt !== before.checkedAt) {
    const was = fibreVerdict(before, id).word, is = fibreVerdict(now, id).word;
    const name = R(id) ? R(id).name : 'The fibre router';
    if (was !== is && is === 'Working') api.notify('Fibre is working', `${name} is registered and the internet works.`);
    else if (was === 'Working' && is !== 'Working') api.notify('Fibre stopped working', `${name} now says: ${is}.`);
  }
  renderFibre();
  renderDots();
}

// Fibre receive power → 0–5 bars.
function opticBars(rx) {
  if (rx == null) return 0;
  return rx > -15 ? 5 : rx > -19 ? 4 : rx > -23 ? 3 : rx > -25 ? 2 : rx > -27 ? 1 : 0;
}

// The phone (VoIP) line: headline, tone and explanation.
function phoneVerdict(p, r, id) {
  const prov = provider(id);
  if (!p) return { word: '–', tone: '', text: r ? "The router didn't report a phone line." : 'Not read yet. Check the fibre router first.' };
  if (p.registered) {
    const busy = p.callState && p.callState !== 'Idle';
    return { word: busy ? p.callState : 'Ready', tone: 'good', text: busy ? `The line is in use: ${p.callState.toLowerCase()}.` : `The phone line is registered with ${prov}. A phone plugged into the TEL socket can make and receive calls.` };
  }
  if (p.error === 'ERROR_WAN_NOT_CONFIGURED') return { word: 'Not set up', tone: 'warn', text: `${prov} hasn't set up a phone service on this router: it has an internet connection but no phone connection, so there's no number or phone account. If your plan includes a fibre phone line, ask ${prov} to activate it; it then appears here by itself.` };
  if (p.error === 'ERROR_ONU_OFFLINE') return { word: 'Off', tone: 'bad', text: `The phone line can't work until ${prov} registers the fibre router. It should come on by itself once the fibre is working, if your plan includes a phone line.` };
  if (!p.enabled) return { word: 'Off', tone: 'warn', text: `The phone line is switched off in the router. Your plan may not include a phone line; ask ${prov} if you expected one.` };
  return { word: 'Not registered', tone: 'warn', text: `The line is set up but not registered with ${prov}'s phone service${p.error ? ` (${p.error})` : ''}.` };
}

function renderFibreExtras(id, r, v) {
  const o = (r && r.optical) || {};
  // Signal card
  if (r && o.rxDbm != null) {
    const ok = o.rxRange ? o.rxDbm >= o.rxRange[0] && o.rxDbm <= o.rxRange[1] : true;
    setStat('statOptic', `${o.rxDbm.toFixed(1)} dBm`, ok ? `Good · normal ${o.rxRange[0]} to ${o.rxRange[1]}` : 'Outside the normal range', ok ? 'good' : 'bad');
    setBars('barsFibre', opticBars(o.rxDbm), ok ? 'good' : 'bad');
  } else {
    setStat('statOptic', r ? 'None' : '–', r ? 'No light arriving on the fibre' : 'Not checked yet', r ? 'bad' : '');
    setBars('barsFibre', r ? 0 : null, r ? 'bad' : '');
  }

  // Internet card: a live ping when this PC is on this router's Wi-Fi, otherwise the last check.
  if (lastScan && lastScanNet === id) {
    const net = lastScan.internet;
    if (!net.received) setStat('statFibreNet', 'Offline', 'No reply from the internet', 'bad');
    else setStat('statFibreNet', `${net.avgMs} ms`, `${net.sent - net.received} of ${net.sent} test pings lost`, pingTone(net));
  } else if (r && r.internet != null) {
    setStat('statFibreNet', r.internet ? 'Working' : 'None', `At the last check, ${ago(r.checkedAt)}`, r.internet ? 'good' : 'bad');
  } else {
    setStat('statFibreNet', '–', 'Not tested yet');
  }

  // Phone card + Calls panel
  const p = r ? r.phone : null;
  const pv = phoneVerdict(p, r, id);
  setStat('statPhone', pv.word, p ? (p.number ? `Number ${p.number}` : 'No number assigned yet') : (r ? 'Not reported' : 'Not checked yet'), pv.tone);
  $('#phoneBig').textContent = pv.word;
  $('#phoneBig').className = 'big ' + pv.tone;
  $('#phoneText').textContent = pv.text;
  kvRows('#phoneTable', p ? [
    ['Phone number', p.number || 'None assigned yet'],
    ['Line status', p.status || '–', p.registered ? 'good' : 'bad'],
    ['Call state', p.callState || '–'],
    ['Problem reported', p.error ? p.error.replace(/_/g, ' ').toLowerCase() : 'None', p.error ? 'bad' : ''],
    ['Checked', r ? fmtDate(r.checkedAt, true) : '–']
  ] : [['Phone line', r ? 'Not reported by the router' : 'Not checked yet']]);

  // Data panel
  $('#fibreDataBig').textContent = !r ? '–' : r.internet ? 'Internet working' : 'No internet';
  $('#fibreDataBig').className = 'big ' + (!r ? '' : r.internet ? 'good' : 'bad');
  $('#fibreDataText').textContent = !r ? 'Check the fibre router to see its internet status.'
    : r.internet ? `At the last check (${ago(r.checkedAt)}) the internet was reachable through the fibre.`
      : `At the last check (${ago(r.checkedAt)}) the internet wasn't reachable. ${v.explain}`;

  // SMS panel
  const sms = $('#fibreSmsBig');
  if (!r || r.simSupported == null) {
    sms.textContent = '–';
    $('#fibreSmsText').textContent = 'Check the fibre router to see whether it supports a SIM card.';
  } else if (r.simSupported) {
    sms.textContent = 'SIM supported';
    $('#fibreSmsText').textContent = "The router reports mobile (SIM) support, but its menu doesn't offer text messages, so the app can't read or send texts through it.";
  } else {
    sms.textContent = 'No SIM in use';
    $('#fibreSmsText').textContent = "This fibre router reports that mobile/SIM support is turned off, and its menu has no text-message pages. If a SIM is attached (for example in a USB modem), the router isn't using it, so texts can't be read or sent here. Texts on a 4G router's SIM are under that router's SMS section.";
  }
}

function renderFibre() {
  const id = activeOf('fibre');
  if (!id) return;
  const f = S(id).fibre;
  const r = f && f.last;
  const v = fibreVerdict(r, id);
  $('#fibreTitle').textContent = R(id).name;
  if (!f) {
    setStat('statFibre', '–', 'Checking…');
    renderFibreExtras(id, null, v);
    return;
  }
  const age = r ? `Checked ${ago(r.checkedAt)}` : (f.configured ? 'Not checked yet' : 'Login not set');
  setStat('statFibre', v.word === 'Not checked' ? '–' : v.word, fibreSwitching ? 'Checking over Wi-Fi…' : (r ? `${r.state} · ${age.toLowerCase()}` : age), v.tone);
  renderFibreExtras(id, r, v);

  $('#fibreBig').textContent = v.word;
  $('#fibreBig').className = 'big ' + v.tone;
  $('#fibreExplain').textContent = v.explain;
  $('#fibreWhen').textContent = r
    ? `${age}${r.via === 'wifi-switch' ? ' by briefly switching Wi-Fi' : ''}. ${f.reachable ? 'This PC is on this router\'s network now.' : 'This PC is not on this router\'s network, so this is the last reading.'}`
    : (f.reachable ? 'This PC is on this router\'s network.' : 'This PC is not on this router\'s network.');
  $('#fibreError').textContent = f.error ? 'Last check failed: ' + f.error : '';

  const btn = $('#fibreCheck');
  btn.disabled = fibreSwitching || !f.configured || (!f.reachable && !f.ssid);
  btn.title = fibreSwitching ? 'A check is already running.'
    : !f.configured ? 'Enter the router password under Information › Router settings first.'
      : !f.reachable && !f.ssid ? 'Add the router\'s 5 GHz Wi-Fi name under Information › Router settings so the app knows which Wi-Fi to join.'
        : '';
  btn.textContent = fibreSwitching ? 'Checking…' : f.reachable ? 'Check now' : 'Switch Wi-Fi and check';
  $('#fibreHint').textContent = !f.configured
    ? 'Enter the router password under Router settings first.'
    : f.reachable
      ? 'The app checks this router every few minutes while this PC is on its network.'
      : f.ssid
        ? `This PC is on a different network. "Switch Wi-Fi and check" joins "${f.ssid}" for about half a minute, reads the router, then switches back.`
        : 'This PC is on a different network. Add the router\'s 5 GHz Wi-Fi name under Router settings to check it from here.';

  $('#fibreMtn').hidden = !(r && v.mtn);
  $('#fibreMtn strong').textContent = `What to tell ${provider(id)}`;
  if (r && v.mtn) {
    $('#fibreMtnText').textContent =
      `"My fibre router has a good optical signal (receive ${fmtDbm(r.optical.rxDbm)}) but is stuck in ${r.state} state and won't register. ` +
      `Router: ${r.model || 'Huawei'}, serial number ${r.serial || 'on the label'}."`;
  }

  const rows = [];
  if (r) {
    const o = r.optical || {};
    const inRange = (val, range) => (val == null || !range ? '' : val >= range[0] && val <= range[1] ? ' · good' : ' · out of range');
    const add = (label, value, tone) => rows.push([label, value, tone]);
    add(`Registration with ${provider(id)}`, `${r.state || '–'} · ${r.stateText}`, r.working ? 'good' : 'bad');
    add('Fibre signal received', fmtDbm(o.rxDbm) + inRange(o.rxDbm, o.rxRange) + (o.rxRange ? ` (normal ${o.rxRange[0]} to ${o.rxRange[1]})` : ''));
    add('Fibre signal sent', fmtDbm(o.txDbm) + inRange(o.txDbm, o.txRange) + (o.txRange ? ` (normal ${o.txRange[0]} to ${o.txRange[1]})` : ''));
    add('Internet', r.internet == null ? 'Not tested' : r.internet ? 'Reachable' : 'Not reachable', r.internet === false ? 'bad' : r.internet ? 'good' : '');
    // The router's own internet connection(s), as the provider set them up.
    for (const w of r.wan || []) {
      const label = (w.services || '').split('_').map((s) => ({ INTERNET: 'Internet', VOIP: 'Phone', TR069: 'Management', IPTV: 'TV', OTHER: 'Other' }[s] || s)).join(' + ') || w.name || 'Connection';
      add(`${label} connection`, `${w.status || '–'}${w.type ? ` (${w.type})` : ''}${w.lastError ? ` · ${w.lastError.replace(/_/g, ' ').toLowerCase()}` : ''}`, /^connected$/i.test(w.status || '') ? 'good' : 'bad');
      if (w.ip) {
        const shared = /^(10\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(w.ip);
        add('Internet address', shared ? `${w.ip} (shared by ${provider(id)}: devices here can't be reached from the internet)` : `${w.ip} (public)`);
      }
      if (w.dns) add('DNS servers', w.dns.split(',').join(', '));
      if (w.account) add('Account ID', w.account);
    }
    if (Array.isArray(r.wan) && r.wan.length && !r.wan.some((w) => /VOIP/.test(w.services || ''))) {
      add('Phone service', `Not set up by ${provider(id)} (no phone connection on this router)`, 'warn');
    }
    add('Router running for', fmtUptime(r.uptimeSec));
    if (o.tempC != null) add('Optical module temperature', `${o.tempC} °C`);
    add('Mobile / SIM support', r.simSupported == null ? '–' : r.simSupported ? 'On' : 'Off');
    add('Model', r.model || '–');
    add('Serial number', r.serial || '–');
    add('Firmware', r.firmware || '–');
    add('Checked', `${fmtDate(r.checkedAt, true)}${r.via === 'wifi-switch' ? ' (Wi-Fi switch)' : ''}`);
  }
  rows.push(['Router address', R(id).host]);
  for (const row of wifiInfoRows(id)) rows.push(row);
  kvRows('#fibreTable tbody', rows);
  $('#fibreEmpty').hidden = !!r;
}

function setupFibre() {
  $('#fibreCheck').addEventListener('click', async () => {
    const id = activeOf('fibre');
    if (!id) return;
    const f = S(id).fibre || {};
    const viaWifi = !f.reachable;
    if (viaWifi && !confirm(`This PC will leave its current Wi-Fi and join "${f.ssid}" for about half a minute, then switch back. The internet on this PC drops during the check. Continue?`)) return;
    fibreSwitching = viaWifi;
    $('#fibreCheck').disabled = true;
    $('#fibreCheck').textContent = 'Checking…';
    renderFibre();
    try { setFibre(id, await api.fibreCheck(id, viaWifi)); }
    catch (e) { S(id).fibre = { ...f, error: cleanError(e) }; }
    finally { fibreSwitching = false; renderFibre(); }
    if (viaWifi) scan(); // the PC is back on its usual network
  });

  // Fibre routers are cheap to check (a quick reachability test unless the PC is on their network).
  setInterval(() => { for (const r of routers) if (supportedKind(r.id, 'fibre')) refreshFibre(r.id); }, POLL_MS);
}

// ---------- Routers the app can't log in to yet (basic information) ----------
async function refreshBasic(id) {
  if (!R(id) || R(id).supported) return;
  try { S(id).basic = await api.routerBasic(id); } catch (e) { S(id).basic = { reachable: false, error: cleanError(e) }; }
  renderGeneric();
  renderDots();
}

function renderGeneric() {
  const id = view.router;
  if (!id || kindOf(id) !== 'generic' || (R(id) && R(id).supported)) return;
  const r = R(id);
  const b = S(id).basic;
  setStat('statGenReach', !b ? '–' : b.reachable ? 'Reachable' : 'Not reachable', !b ? 'Checking…' : b.reachable ? 'Answering from this PC' : offNetText(id), !b ? '' : b.reachable ? 'good' : '');
  if (lastScan && lastScanNet === id) {
    setStat('statGenDevices', String(lastScan.devices.length), 'Found by this PC\'s scan');
    const net = lastScan.internet;
    if (!net.received) setStat('statGenNet', 'Offline', 'No reply from the internet', 'bad');
    else setStat('statGenNet', `${net.avgMs} ms`, `${net.sent - net.received} of ${net.sent} test pings lost`, pingTone(net));
  } else {
    setStat('statGenDevices', '–', offNetText(id));
    setStat('statGenNet', '–', offNetText(id));
  }
  setStat('statGenModel', (b && b.model) || r.model, 'Basic support: the app can\'t log in to this type yet');
  kvRows('#infoGeneric', [
    ['Type', r.model],
    ['Address', r.host],
    ['Reachable now', !b ? 'Checking…' : b.reachable ? 'Yes' : 'No', b && b.reachable ? 'good' : ''],
    ...(b && b.note ? [['Detected', b.note]] : []),
    ...wifiInfoRows(id)
  ]);
}

// ---------- Router switch, unknown networks, settings ----------
const ICONS = {
  mobile: '<path d="M12 10v11"/><path d="M8.5 21h7"/><circle cx="12" cy="8" r="1.8"/><path d="M7.8 3.8a6 6 0 0 0 0 8.4M16.2 3.8a6 6 0 0 1 0 8.4"/>',
  fibre: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01"/><path d="M15 13c0-4 2-6 6-9"/>',
  generic: '<rect x="3" y="12" width="18" height="8" rx="2"/><path d="M7 16h.01M11 16h.01"/><path d="M8 8.5a6 6 0 0 1 8 0M10 10.5a3 3 0 0 1 4 0"/>',
  add: '<path d="M12 5v14M5 12h14"/>'
};

function svgIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  // Static, trusted markup from ICONS above (never router or user data).
  svg.innerHTML = ICONS[kind] || ICONS.generic;
  return svg;
}

function renderRouterSwitch() {
  const nav = $('#routerSwitch');
  nav.replaceChildren(
    ...routers.map((r) => el('button', { class: 'router-opt' + (r.id === view.router ? ' active' : ''), type: 'button', 'data-router': r.id, onclick: () => selectRouter(r.id) },
      el('span', { class: 'router-ico', 'aria-hidden': 'true' }, svgIcon(r.kind)),
      el('span', { class: 'router-text' },
        el('span', { class: 'router-name' }, r.name + ' ', el('span', { class: 'dot', 'data-dot': r.id }), r.supported ? null : el('span', { class: 'router-tag', text: 'Basic' })),
        el('span', { class: 'router-sub', 'data-sub': r.id, text: r.host })))),
    el('button', { class: 'router-opt add', type: 'button', onclick: () => openAdd('') },
      el('span', { class: 'router-ico', 'aria-hidden': 'true' }, svgIcon('add')),
      el('span', { class: 'router-name', text: 'Add router' }))
  );
  renderRouterSubs();
  renderDots();
}

// Subtitle under each router: the network this PC is on (and its band), or the router's network names.
function renderRouterSubs() {
  for (const r of routers) {
    const span = document.querySelector(`[data-sub="${r.id}"]`);
    if (!span) continue;
    if (pcWifi && pcWifi.network === r.id) { span.textContent = `This PC: ${pcWifi.ssid} · ${bandLabel(pcWifi.band)} · ${r.host}`; continue; }
    const n = netNames(r.id);
    const names = [n['5'], n['2.4']].filter(Boolean).join(' / ');
    span.textContent = names ? `${names} · ${r.host}` : `${r.model} · ${r.host}`;
  }
}

function dotTone(id) {
  const s = S(id);
  if (supportedKind(id, 'mobile')) return s.info ? (s.info.connected ? 'good' : 'bad') : s.error && lastScanNet === id ? 'bad' : '';
  if (supportedKind(id, 'fibre')) return fibreVerdict(s.fibre && s.fibre.last, id).tone;
  return s.basic && s.basic.reachable ? 'good' : '';
}

function renderDots() {
  for (const r of routers) {
    const dot = document.querySelector(`[data-dot="${r.id}"]`);
    if (dot) dot.className = 'dot ' + dotTone(r.id);
  }
}

function renderUnknownNet() {
  const bar = $('#unknownNetBar');
  bar.hidden = !unknownGateway;
  if (unknownGateway) $('#unknownNetText').textContent = `This PC is on a network whose router (${unknownGateway}) isn't in your list yet, so its devices aren't being saved.`;
}

function fillSettings() {
  const r = R(view.router);
  if (!r) return;
  $('#rsName').value = r.name;
  $('#rsHost').value = r.host;
  $('#rsUser').value = r.username;
  $('#rsPass').value = '';
  $('#rsPass').placeholder = r.hasPassword ? 'Saved (leave empty to keep)' : 'Not set';
  $('#rsUser').disabled = $('#rsPass').disabled = !r.supported;
  $('#rsSsid5').value = r.ssid5 || '';
  $('#rsSsid24').value = r.ssid24 || '';
  renderSettingsHints();
  $('#rsMsg').textContent = 'Stored on this PC only. The Wi-Fi names let the app switch bands and do quick checks on routers that don\'t report them.';
}

// Placeholder hints only (never the values), so it's safe to refresh while you type.
function renderSettingsHints() {
  const r = R(view.router);
  if (!r) return;
  const n = netNames(r.id);
  $('#rsSsid5').placeholder = n['5'] && !r.ssid5 ? `${n['5']} (reported by the router)` : 'e.g. MyRouter_5G';
  $('#rsSsid24').placeholder = n['2.4'] && !r.ssid24 ? `${n['2.4']} (reported by the router)` : 'e.g. MyRouter_2.4G';
}

function setupSettings() {
  $('#rsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = view.router;
    try {
      const res = await api.routerSettings(id, {
        name: $('#rsName').value, username: $('#rsUser').value, password: $('#rsPass').value,
        ssid5: $('#rsSsid5').value, ssid24: $('#rsSsid24').value
      });
      routers = res.routers;
      renderRouterSwitch();
      fillSettings();
      $('#rsMsg').textContent = 'Saved.';
      refreshView();
    } catch (err) {
      $('#rsMsg').textContent = 'Could not save: ' + cleanError(err);
    }
  });

  $('#rsRemove').addEventListener('click', async () => {
    const r = R(view.router);
    if (!r) return;
    const what = r.kind === 'mobile' ? 'devices, balance history and text-message tracking' : 'devices and readings';
    if (!confirm(`Remove "${r.name}" (${r.host}) from the app?\n\nAll its saved ${what} are erased and can't be brought back. The router itself isn't changed.\n\nTo change its login instead, use Router settings above.`)) return;
    try {
      const res = await api.removeRouter(r.id);
      routers = res.routers;
      data.devices = data.devices.filter((kd) => netOfKd(kd) !== r.id);
      delete data.balancesBy[r.id];
      delete data.ussdBy[r.id];
      delete data.smsSeenBy[r.id];
      delete state[r.id];
      delete chats[r.id]; // its Ask AI chat goes too
      saveChats();
      save();
      view.router = routers.length ? routers[0].id : null;
      renderRouterSwitch();
      applyView();
    } catch (err) {
      $('#rsMsg').textContent = 'Could not remove: ' + cleanError(err);
    }
  });
}

// ---------- Add a router by its address ----------
let detected = null;
const LOGIN_DRIVERS = new Set(['zlt', 'huawei-ont']);
const DEFAULT_USERS = { zlt: 'admin', 'huawei-ont': 'root' };

function openAdd(host) {
  detected = null;
  $('#addHost').value = host || '';
  $('#addResult').hidden = true;
  $('#addFields').hidden = true;
  $('#addMsg').textContent = '';
  $('#addSave').disabled = true;
  for (const id of ['#addName', '#addUser', '#addPass', '#addSsid5', '#addSsid24']) $(id).value = '';
  // Suggestions: the network the PC is on, then the usual router addresses, minus ones already added.
  const known = new Set(routers.map((r) => r.host));
  const ideas = [unknownGateway, pcWifi && pcWifi.gateway, '192.168.1.1', '192.168.8.1', '192.168.0.1', '192.168.100.1', '192.168.18.1']
    .filter((h, i, a) => h && !known.has(h) && a.indexOf(h) === i);
  $('#addSuggest').replaceChildren(...ideas.map((h) => el('button', { class: 'chip', type: 'button', text: h, onclick: () => { $('#addHost').value = h; detectAdd(); } })));
  $('#addDlg').showModal();
  if (host) detectAdd(); else $('#addHost').focus();
}

function syncAddFields() {
  const driver = $('#addDriver').value;
  const needs = LOGIN_DRIVERS.has(driver);
  for (const l of document.querySelectorAll('#addFields .login-field')) l.hidden = !needs;
  if (needs && !$('#addUser').value) $('#addUser').value = DEFAULT_USERS[driver] || '';
}

async function detectAdd() {
  const host = $('#addHost').value.trim();
  const box = $('#addResult');
  $('#addMsg').textContent = '';
  box.hidden = false;
  box.textContent = `Looking for a router at ${host}…`;
  $('#addDetect').disabled = true;
  try {
    detected = await api.detectRouter(host);
    box.replaceChildren();
    if (detected.reachable) {
      box.append(el('strong', { text: `Found: ${detected.model}` }),
        el('p', { class: 'small', text: detected.supported
          ? `${detected.label}. Full support: enter its login and the app tests it once before saving.`
          : `${detected.label}. The app recognises it but can't log in to this type yet, so it gets basic information and a device list.` }));
      if (detected.note) box.append(el('p', { class: 'small muted', text: detected.note }));
      $('#addDriver').value = detected.driver;
      $('#addName').value = detected.supported ? (detected.kind === 'fibre' ? 'Fibre router' : '4G router') : detected.model;
    } else {
      box.append(el('strong', { text: `Nothing answered at ${host} from this PC.` }),
        el('p', { class: 'small', text: 'If the router is on another network (another Wi-Fi), choose its type below and add it anyway. The app reads it when this PC is on its network, or with a quick Wi-Fi switch for fibre routers.' }));
      $('#addDriver').value = 'generic';
    }
    $('#addFields').hidden = false;
    syncAddFields();
    $('#addSave').disabled = false;
  } catch (e) {
    box.textContent = cleanError(e);
  } finally {
    $('#addDetect').disabled = false;
  }
}

function setupAdd() {
  $('#addDetect').addEventListener('click', detectAdd);
  $('#addHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); detectAdd(); } });
  $('#addDriver').addEventListener('change', () => { $('#addUser').value = ''; syncAddFields(); });
  $('#addCancel').addEventListener('click', () => $('#addDlg').close());
  $('#unknownNetAdd').addEventListener('click', () => openAdd(unknownGateway));
  $('#addSave').addEventListener('click', async () => {
    const msg = $('#addMsg');
    const driver = $('#addDriver').value;
    const btn = $('#addSave');
    btn.disabled = true;
    msg.className = 'small muted';
    msg.textContent = LOGIN_DRIVERS.has(driver) && detected && detected.reachable ? 'Testing the login…' : 'Saving…';
    try {
      const res = await api.addRouter({
        host: $('#addHost').value.trim(), driver,
        model: detected && detected.reachable && detected.driver === driver ? detected.model : '',
        name: $('#addName').value, username: $('#addUser').value, password: $('#addPass').value,
        ssid5: $('#addSsid5').value, ssid24: $('#addSsid24').value
      });
      routers = res.routers;
      // Devices already seen on this network while it was unknown are picked up by the next scan.
      $('#addDlg').close();
      view.router = res.id;
      renderRouterSwitch();
      applyView();
      const added = R(res.id);
      const wifi = [added.ssid5, added.ssid24].filter(Boolean).join(' / ');
      setStatus(`Added ${added.name}.${res.loginTested ? ' The login works.' : ''}${res.wifiDetected && wifi ? ` Wi-Fi found: ${wifi}.` : ''}`);
      scan();
    } catch (e) {
      msg.className = 'small bad';
      msg.textContent = cleanError(e);
      btn.disabled = false;
    }
  });
}

// ---------- Messages (texts on a 4G router's SIM) ----------
const SMS_MAX = 640;
let smsCache = { inbox: null, sent: null };
let smsRouter = null; // which router smsCache belongs to
let smsBox = 'inbox';
let smsError = null;

const isPhoneNumber = (s) => /^\+?\d{2,31}$/.test(s);

// The router dates messages like "2025/01/27 13:49:48" (its own local time).
function smsTime(d) {
  const t = new Date(d.replace(/\//g, '-').replace(' ', 'T'));
  if (isNaN(t)) return d;
  return fmtDate(t.toISOString(), t.getFullYear() !== new Date().getFullYear());
}

async function refreshSms(id, box) {
  if (!supportedKind(id, 'mobile')) return;
  try {
    const result = await api.routerSms(id, box);
    if (box === 'inbox') notifyNewSms(id, result);
    if (id === activeOf('mobile')) {
      if (smsRouter !== id) { smsCache = { inbox: null, sent: null }; smsRouter = id; }
      smsCache[box] = result;
      smsError = null;
    }
  } catch (e) {
    if (id === activeOf('mobile')) smsError = cleanError(e);
  }
  renderSms();
}

// Pops up a notification for texts that arrived since the app last looked.
function notifyNewSms(id, result) {
  const newest = result.messages.reduce((max, m) => (m.date > max ? m.date : max), '');
  const last = data.smsSeenBy[id];
  if (newest > (last || '')) { data.smsSeenBy[id] = newest; save(); }
  if (last == null) return; // first look: don't announce messages that were already there
  const fresh = result.messages.filter((m) => !m.read && m.date > last);
  if (fresh.length === 1) api.notify('New text from ' + fresh[0].phone, fresh[0].text.slice(0, 150));
  else if (fresh.length > 1) api.notify('New text messages', `${fresh.length} new texts arrived on ${R(id) ? R(id).name : 'the router'}'s SIM.`);
}

function renderSms() {
  const id = activeOf('mobile');
  const badge = $('#smsBadge');
  if (!id || smsRouter !== id) {
    badge.hidden = true;
    if (id) { $('#smsList').replaceChildren(); $('#smsStatus').textContent = smsError ? 'Could not load messages: ' + smsError : 'Loading messages from the router…'; }
    return;
  }
  const inbox = smsCache.inbox;
  const unread = inbox ? inbox.messages.filter((m) => !m.read).length : 0;
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);

  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.box === smsBox);

  const res = smsCache[smsBox];
  const canDelete = !res || res.canDelete !== false;
  const full = $('#smsFull');
  full.hidden = !(res && res.full);
  full.textContent = (smsBox === 'inbox'
    ? `The SIM's inbox is full (${plural(res ? res.total : 0, 'message')}). New texts can't arrive until some are deleted.`
    : 'The Sent folder is full. Delete some sent messages so new ones can be saved.') +
    (canDelete ? '' : " This router login isn't allowed to delete texts. Use a higher-level router account (Information › Router settings), or put the SIM in a phone and delete them there.");

  $('#smsDeleteAll').hidden = !canDelete;

  // Sending rights don't depend on the folder; the inbox check keeps this current.
  const anyRes = smsCache.inbox || smsCache.sent;
  const canSend = !anyRes || anyRes.canSend !== false;
  for (const sel of ['#smsTo', '#smsText', '#smsSend']) $(sel).disabled = !canSend;
  $('#smsNoSend').hidden = canSend;

  const status = $('#smsStatus');
  status.className = 'small pad ' + (smsError ? 'bad' : 'muted');
  if (smsError) status.textContent = 'Could not load messages: ' + smsError;
  else if (!res) status.textContent = 'Loading messages from the router…';
  else if (!res.messages.length) status.textContent = smsBox === 'inbox' ? 'No messages.' : 'No sent messages.';
  else status.textContent = smsBox === 'inbox'
    ? `${plural(res.messages.length, 'message')}${unread ? ` · ${unread} unread. Click one to mark it read` : ''}`
    : plural(res.messages.length, 'message');

  $('#smsDeleteAll').disabled = !(res && res.messages.length);
  $('#smsList').replaceChildren(...(res ? res.messages.map((m) => smsItem(id, m, smsBox, canDelete)) : []));
}

function smsItem(id, m, box, canDelete) {
  const unread = box === 'inbox' && !m.read;
  const actions = [];
  if (box === 'inbox' && isPhoneNumber(m.phone)) {
    actions.push(el('button', { class: 'link', type: 'button', text: 'Reply', onclick: () => composeSms(m.phone, '') }));
  }
  actions.push(el('button', { class: 'link', type: 'button', text: 'Forward', onclick: () => composeSms('', m.text) }));
  if (canDelete) actions.push(el('button', { class: 'link danger', type: 'button', text: 'Delete', onclick: (e) => deleteSms(id, box, m, e.currentTarget) }));

  const li = el('li', { class: 'msg' + (unread ? ' unread' : ''), title: unread ? 'Click to mark as read' : '' },
    el('div', { class: 'msg-top' },
      el('span', { class: 'msg-from', text: (box === 'sent' ? 'To ' : '') + m.phone }),
      el('span', { class: 'msg-time', text: smsTime(m.date) })),
    el('p', { class: 'msg-text', text: m.text }),
    el('div', { class: 'msg-actions' },
      ...actions,
      box === 'sent' ? el('span', { class: 'msg-state ' + (m.read ? 'good' : 'bad'), text: m.read ? 'Sent' : 'Not sent' }) : null)
  );
  if (unread) li.addEventListener('click', () => markSmsRead(id, m));
  return li;
}

function markSmsRead(id, m) {
  if (m.read) return;
  m.read = true;
  renderSms();
  api.markSmsRead(id, [m.index]).catch(() => { /* it stays unread on the router; the next refresh shows that */ });
}

async function deleteSms(id, box, m, btn) {
  if (!confirm(`Delete this message ${box === 'sent' ? 'to' : 'from'} ${m.phone}? This can't be undone.`)) return;
  btn.disabled = true;
  try {
    await api.deleteSms(id, box, [m.index]);
  } catch (e) {
    alert('Could not delete: ' + cleanError(e));
  }
  await refreshSms(id, box);
}

function composeSms(phone, text) {
  if (phone) $('#smsTo').value = phone;
  if (text) $('#smsText').value = text;
  updateSmsCount();
  $('#smsFormMsg').textContent = '';
  (phone ? $('#smsText') : $('#smsTo')).focus();
}

function updateSmsCount() {
  const n = $('#smsText').value.length;
  $('#smsCount').textContent = `${n} / ${SMS_MAX}` + (n > 160 ? ` · sent as ${Math.ceil(n / 153)} texts` : '');
}

function setupMessages() {
  $('#smsText').addEventListener('input', updateSmsCount);
  updateSmsCount();

  $('#smsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = activeOf('mobile');
    if (!id) return;
    const to = $('#smsTo').value.replace(/[\s-]/g, '');
    const text = $('#smsText').value;
    const msg = $('#smsFormMsg');
    if (!isPhoneNumber(to)) { msg.className = 'small bad'; msg.textContent = 'Enter a phone number using digits only (a leading + is fine).'; return; }
    if (/[\uD800-\uDFFF]/.test(text)) { msg.className = 'small bad'; msg.textContent = 'The router cannot send emoji. Remove them and try again.'; return; }
    const btn = $('#smsSend');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    msg.className = 'small muted';
    msg.textContent = '';
    try {
      await api.sendSms(id, to, text);
      $('#smsText').value = '';
      updateSmsCount();
      msg.className = 'small found';
      msg.textContent = `Sent to ${to}.`;
      smsCache.sent = null;
      if (smsBox === 'sent') refreshSms(id, 'sent');
    } catch (err) {
      msg.className = 'small bad';
      msg.textContent = 'Not sent: ' + cleanError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
    if (/isn't allowed/.test(msg.textContent)) refreshSms(id, 'inbox'); // re-reads the rights and locks the form
  });

  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      smsBox = b.dataset.box;
      renderSms();
      const id = activeOf('mobile');
      if (id) refreshSms(id, smsBox);
    });
  }

  $('#smsRefresh').addEventListener('click', () => { const id = activeOf('mobile'); if (id) refreshSms(id, smsBox); });

  $('#smsDeleteAll').addEventListener('click', async () => {
    const id = activeOf('mobile');
    const res = smsCache[smsBox];
    if (!id || !res || !res.messages.length) return;
    const where = smsBox === 'inbox' ? 'inbox' : 'Sent folder';
    if (!confirm(`Delete all ${plural(res.messages.length, 'message')} in the ${where}? This can't be undone.`)) return;
    const btn = $('#smsDeleteAll');
    btn.disabled = true;
    try {
      await api.deleteSms(id, smsBox, 'all');
    } catch (e) {
      alert('Could not delete: ' + cleanError(e));
    }
    await refreshSms(id, smsBox);
  });

  // Check for new texts every minute on the 4G router shown and the one this PC is on.
  setInterval(() => {
    const ids = new Set([activeOf('mobile'), lastScanNet].filter((id) => id && supportedKind(id, 'mobile')));
    for (const id of ids) refreshSms(id, 'inbox');
  }, SMS_POLL_MS);
}

// ---------- Ask AI (one conversation per router) ----------
let chats = {};            // routerId → [{ role: 'user' | 'assistant' | 'note' | 'error', content, tools?, actions? }]
const aiBusyFor = new Set(); // router ids waiting for an answer

const TOOL_LABELS = {
  list_routers: 'routers', get_router_status: 'router status', list_devices: 'devices', scan_network: 'network scan',
  get_this_pc_wifi: "this PC's Wi-Fi", run_diagnostics: 'diagnostics', get_wifi_bands: 'Wi-Fi bands', read_sms: 'texts',
  get_data_balance: 'data balance', find_device: 'device lookup', show_in_app: 'where it is',
  propose_connect_pc: 'Wi-Fi connection', propose_switch_band: 'band switch',
  propose_device_action: 'device action', propose_check_balance: 'balance check', propose_send_sms: 'text message', propose_fibre_check: 'fibre check'
};

const chatFor = (id) => (chats[id] || (chats[id] = []));

function loadChats() {
  try { chats = JSON.parse(recall('netmon-chats') || '{}'); } catch { chats = {}; }
  if (!chats || typeof chats !== 'object' || Array.isArray(chats)) chats = {};
  // Approvals can't be resumed after a reload.
  for (const list of Object.values(chats)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) for (const a of m.actions || []) if (a.state === 'pending' || a.state === 'running') a.state = 'expired';
  }
}

function saveChats() {
  const keep = {};
  for (const [id, list] of Object.entries(chats)) if (R(id) && Array.isArray(list) && list.length) keep[id] = list.slice(-40);
  store('netmon-chats', JSON.stringify(keep));
}

// Small, safe formatter: paragraphs, "- " bullet lists and **bold**. Builds nodes; never uses innerHTML.
function formatText(text) {
  const frag = document.createDocumentFragment();
  const inline = (line, parent) => {
    line.split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('strong', { text: part.slice(2, -2) }));
      else if (part) parent.append(part.replace(/`([^`]+)`/g, '$1'));
    });
  };
  for (const block of String(text || '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      const ul = el('ul');
      for (const l of lines) { const li = el('li'); inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''), li); ul.append(li); }
      frag.append(ul);
    } else {
      const p = el('p');
      lines.forEach((l, i) => { if (i) p.append(el('br')); inline(l.replace(/^#+\s*/, ''), p); });
      frag.append(p);
    }
  }
  return frag;
}

// Takes the user to a router and sub-nav section.
function openInApp(routerId, section) {
  if (!R(routerId)) { setStatus("That router isn't in your list any more.", 'bad'); return; }
  view.router = routerId;
  view.section = section;
  renderRouterSwitch();
  applyView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function actionCard(a, chatId) {
  if (a.type === 'navigate') {
    return el('div', { class: 'nav-card' },
      el('button', { class: 'nav-btn', type: 'button', text: a.summary + ' →', onclick: () => openInApp(a.params.routerId, a.params.section) }));
  }
  const stateText = { done: 'Done', failed: 'Failed', dismissed: 'Dismissed', running: 'Working…', expired: 'Expired (ask again)' }[a.state];
  const card = el('div', { class: 'action-card' },
    el('span', { class: 'act-title', text: a.summary }),
    a.reason ? el('span', { class: 'act-reason', text: a.reason }) : null);
  const row = el('div', { class: 'act-row' });
  if (a.state === 'pending') {
    row.append(
      el('button', { class: 'primary', type: 'button', text: 'Approve', onclick: () => runAction(chatId, a) }),
      el('button', { type: 'button', text: 'Dismiss', onclick: () => { a.state = 'dismissed'; saveChats(); renderChat(); } }));
  } else {
    row.append(el('span', { class: 'act-state ' + (a.state === 'done' ? 'good' : a.state === 'failed' ? 'bad' : 'muted'), text: stateText }));
    if (a.result) row.append(el('span', { class: 'act-reason', text: a.result }));
  }
  card.append(row);
  return card;
}

function suggestions() {
  const r = R(view.router);
  if (r && r.supported && r.kind === 'mobile') return ['Who is connected right now?', 'Why is my internet slow?', 'How much data do I have left?', 'Any new text messages?', 'Which band is each device on?'];
  if (r && r.supported && r.kind === 'fibre') return ['Is the fibre working yet?', 'What should I tell MTN?', 'Is the phone line working?', 'Who is on this Wi-Fi?'];
  return ['Is this router reachable?', 'Run a connection check', 'Which devices are on this network?'];
}

function renderChat() {
  const id = view.router;
  const r = R(id);
  if (!r) return;
  const chat = chatFor(id);
  const busy = aiBusyFor.has(id);
  $('#aiTitle').textContent = `Ask AI about ${r.name}`;
  const log = $('#aiLog');
  const nodes = [];
  if (!chat.length) {
    nodes.push(el('div', { class: 'chat-empty' },
      el('p', { text: `Ask anything about ${r.name}: its devices, connection, signal${r.kind === 'mobile' ? ', data or texts' : r.kind === 'fibre' ? ' or phone line' : ''}.` }),
      el('p', { class: 'small', text: 'The assistant looks up live readings to answer. If it suggests a change, like disconnecting a device or switching Wi-Fi band, you approve it first. Each router has its own chat.' })));
  }
  for (const m of chat) {
    if (m.role === 'user') nodes.push(el('div', { class: 'bubble user', text: m.content }));
    else if (m.role === 'note') nodes.push(el('div', { class: 'bubble note', text: m.content }));
    else if (m.role === 'error') nodes.push(el('div', { class: 'bubble error', text: m.content }));
    else {
      const b = el('div', { class: 'bubble bot' }, formatText(m.content));
      if (m.tools && m.tools.length) b.append(el('div', { class: 'used' }, ...m.tools.map((t) => el('span', { text: 'Checked ' + (TOOL_LABELS[t] || t) }))));
      nodes.push(b);
      for (const a of m.actions || []) nodes.push(actionCard(a, id));
    }
  }
  if (busy) nodes.push(el('div', { class: 'typing', text: 'Looking into it' }));
  log.replaceChildren(...nodes);
  log.scrollTop = log.scrollHeight;
  $('#aiSuggest').replaceChildren(...suggestions().map((s) => el('button', { class: 'chip', type: 'button', text: s, onclick: () => askAi(s) })));
  $('#aiSend').disabled = busy;
  $('#aiClear').disabled = busy || !chat.length;
}

// What the model sees for one router's chat: questions, answers and action results (as user notes).
const aiHistory = (id) => chatFor(id)
  .filter((m) => m.role === 'user' || m.role === 'assistant' || (m.role === 'note' && m.forAi))
  .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.role === 'note' ? m.forAi : m.content }));

async function callAi(id) {
  aiBusyFor.add(id);
  renderChat();
  try {
    const res = await api.aiChat(aiHistory(id), { router: id, section: 'ai' });
    chatFor(id).push({ role: 'assistant', content: res.reply, tools: res.tools || [], actions: (res.actions || []).map((a) => ({ ...a, state: 'pending' })) });
  } catch (e) {
    chatFor(id).push({ role: 'error', content: cleanError(e) });
  } finally {
    aiBusyFor.delete(id);
    saveChats();
    renderChat(); // shows the answer if that router's chat is still on screen
  }
}

function askAi(text) {
  const id = view.router;
  text = String(text || '').trim();
  if (!text || !id || aiBusyFor.has(id)) return;
  chatFor(id).push({ role: 'user', content: text });
  $('#aiInput').value = '';
  callAi(id);
}

// Carries out an approved action with the app's own functions, then tells the assistant how it went.
async function runAction(chatId, a) {
  if (aiBusyFor.has(chatId) || a.state !== 'pending') return;
  a.state = 'running';
  renderChat();
  const p = a.params || {};
  let result;
  try {
    if (a.type === 'switch_band') {
      bandSwitching = true;
      pcWifi = await api.setPcBand(p.band);
      result = `This PC is now on ${bandLabel(pcWifi.band)} ("${pcWifi.ssid}").`;
    } else if (a.type === 'join_network') {
      bandSwitching = true;
      pcWifi = await api.joinNetwork(p.routerId, p.band);
      result = `This PC is now connected to "${pcWifi.ssid}" (${bandLabel(pcWifi.band)}).`;
    } else if (a.type === 'device') {
      fibreSwitching = true; // the server may briefly switch Wi-Fi if this PC is on another network
      const res = p.action === 'disconnect' ? await api.disconnectDevice(p.routerId, p.mac, p.name, 10, true)
        : p.action === 'block' ? await api.blockDevice(p.routerId, p.mac, p.name, true)
          : await api.unblockDevice(p.routerId, p.mac, true);
      if (S(p.routerId).fibre && S(p.routerId).fibre.last) S(p.routerId).fibre.last.blocked = res.blocked;
      result = { disconnect: `${p.name} was disconnected and can reconnect now.`, block: `${p.name} is blocked.`, unblock: `${p.name} is unblocked.` }[p.action];
    } else if (a.type === 'ussd') {
      const res = await api.routerUssd(p.routerId, p.code);
      const bal = res.needReply ? null : pickDataBalance(res.message);
      if (bal) recordBalance(p.routerId, bal.mb);
      result = `Network reply: ${res.message}${bal ? ` (saved ${fmtMb(bal.mb)} as data left)` : ''}`;
    } else if (a.type === 'sms') {
      await api.sendSms(p.routerId, p.phone, p.text);
      result = `Text sent to ${p.phone}.`;
    } else if (a.type === 'fibre_check') {
      fibreSwitching = true;
      setFibre(p.routerId, await api.fibreCheck(p.routerId, true));
      const last = S(p.routerId).fibre && S(p.routerId).fibre.last;
      result = last ? `Checked: ${fibreVerdict(last, p.routerId).word} (state ${last.state}).` : 'Checked.';
    } else {
      throw new Error('Unknown action.');
    }
    a.state = 'done';
  } catch (e) {
    a.state = 'failed';
    result = cleanError(e);
  } finally {
    bandSwitching = false;
    fibreSwitching = false;
  }
  a.result = result;
  chatFor(chatId).push({ role: 'note', content: `${a.state === 'done' ? 'Done' : 'Failed'}: ${a.summary}`, forAi: `[Action result] ${a.summary}: ${a.state === 'done' ? 'succeeded' : 'failed'}. ${result}` });
  saveChats();
  renderChat();
  renderWifiEverywhere();
  renderDevices();
  if (a.type !== 'sms' && a.type !== 'ussd') scan();
  callAi(chatId); // let the assistant follow up on the result
}

function setupAi() {
  loadChats();
  $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); askAi($('#aiInput').value); });
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAi($('#aiInput').value); }
  });
  $('#aiClear').addEventListener('click', () => {
    const id = view.router;
    if (!id || aiBusyFor.has(id) || !chatFor(id).length) return;
    if (!confirm(`Clear the chat about ${R(id).name}? Other routers' chats are kept.`)) return;
    chats[id] = [];
    saveChats();
    renderChat();
  });
  api.aiStatus().then((s) => {
    if (!s.configured) {
      $('#aiModel').textContent = 'No AI key set. Add NVIDIA_API_KEY to %APPDATA%\\Home Network Monitor\\.env, then restart the app.';
      $('#aiModel').className = 'small bad';
    } else {
      $('#aiModel').textContent = `Answers use live readings from this router (model: ${s.model}). Anything that changes something waits for your approval.`;
    }
  }).catch(() => {});
}

// ---------- Navigation ----------
const SECTIONS = ['connections', 'data', 'calls', 'sms', 'info', 'map', 'ai'];

function store(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

function selectRouter(id) {
  if (view.router === id) return;
  view.router = id;
  applyView();
}

// Loads whatever the router and section on screen need.
function refreshView() {
  const id = view.router;
  if (!id) return;
  if (supportedKind(id, 'mobile')) {
    refreshRouter(id);
    if (view.section === 'sms' || smsRouter !== id) refreshSms(id, view.section === 'sms' ? smsBox : 'inbox');
  } else if (supportedKind(id, 'fibre')) {
    refreshFibre(id);
  } else {
    refreshBasic(id);
  }
}

// Shows the chosen router's dashboard and the chosen section under it.
function applyView() {
  if (!R(view.router)) view.router = routers.length ? routers[0].id : null;
  const r = R(view.router);
  const kind = r ? (r.supported ? r.kind : 'generic') : 'generic';
  const sections = [...(r ? r.sections : ['connections']), 'map', 'ai']; // Map and Ask AI are there for every router
  if (!sections.includes(view.section)) view.section = 'connections';

  for (const b of document.querySelectorAll('.router-opt[data-router]')) b.classList.toggle('active', b.dataset.router === view.router);
  for (const b of document.querySelectorAll('.sub-tab')) {
    b.hidden = !sections.includes(b.dataset.section);
    b.classList.toggle('active', b.dataset.section === view.section);
  }
  for (const s of document.querySelectorAll('.stats[data-kind]')) s.hidden = s.dataset.kind !== kind;
  $('#fibreBar').hidden = kind !== 'fibre';
  for (const p of document.querySelectorAll('.panel')) {
    p.hidden = !((p.dataset.kind === '*' || p.dataset.kind === kind) && p.dataset.section === view.section);
  }
  $('#smsBadge').classList.toggle('off', kind !== 'mobile');
  if (kind === 'mobile' && smsRouter !== view.router) { smsCache = { inbox: null, sent: null }; smsRouter = null; }

  fillSettings();
  renderDevices();
  renderBalance();
  renderSms();
  if (view.section === 'ai') renderChat();
  if (view.section === 'map') renderMap();
  renderStats();
  refreshView();
  if (view.router) store('netmon-view', view.router + '/' + view.section);
}

function setupTabs() {
  const [r, s] = String(recall('netmon-view') || '').split('/');
  if (R(r)) view.router = r;
  if (SECTIONS.includes(s)) view.section = s;
  for (const b of document.querySelectorAll('.sub-tab')) b.addEventListener('click', () => { view.section = b.dataset.section; applyView(); });
  renderRouterSwitch();
  applyView();
}

function setupTheme() {
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    store('netmon-theme', next);
  });
}

// About dialog: app version, plus the developer's contact details with copy buttons.
function setupAbout() {
  const dlg = $('#aboutDlg');
  $('#aboutCopyright').textContent = `© ${new Date().getFullYear()} George Junior Boadu`;
  $('#aboutBtn').addEventListener('click', async () => {
    dlg.showModal();
    try {
      const { version } = await api.about();
      $('#aboutVersion').textContent = `Version ${version}`;
    } catch { $('#aboutVersion').textContent = ''; }
  });
  $('#aboutClose').addEventListener('click', () => dlg.close());
  // Clicking the dimmed area outside the box closes it too.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  for (const b of dlg.querySelectorAll('.about-copy')) {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        b.textContent = 'Copied';
        b.classList.add('copied');
      } catch { b.textContent = 'Copy failed'; }
      setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1600);
    });
  }
}

// Data from earlier versions: one balance list, one USSD code, and devices without a router id.
function migrateData() {
  let changed = false;
  data.devices = Array.isArray(data.devices) ? data.devices : [];
  for (const k of ['balancesBy', 'ussdBy', 'smsSeenBy']) if (!data[k] || typeof data[k] !== 'object') { data[k] = {}; changed = true; }
  if (Array.isArray(data.balances)) {
    if (!data.balancesBy['4g']) data.balancesBy['4g'] = data.balances;
    delete data.balances;
    changed = true;
  }
  if (typeof data.ussd === 'string') { if (data.ussdBy['4g'] == null) data.ussdBy['4g'] = data.ussd; delete data.ussd; changed = true; }
  if (data.smsLastSeen != null) { if (data.smsSeenBy['4g'] == null) data.smsSeenBy['4g'] = data.smsLastSeen; delete data.smsLastSeen; changed = true; }
  const fibreRouter = R('fibre');
  for (const kd of [...data.devices]) {
    if (kd.net) continue;
    if (fibreRouter && sameSubnet(kd.lastIp, fibreRouter.host) && !kd.key.startsWith('f:')) {
      const newKey = 'f:' + kd.key;
      if (data.devices.some((x) => x.key === newKey)) data.devices = data.devices.filter((x) => x !== kd);
      else { kd.key = newKey; kd.net = 'fibre'; }
    } else {
      kd.net = kd.key.startsWith('f:') ? 'fibre' : '4g';
    }
    changed = true;
  }
  if (changed) save();
}

function setupScanning() {
  $('#scanBtn').addEventListener('click', scan);
  api.onScanRequest(scan);
  const auto = $('#auto');
  const apply = () => {
    clearInterval(timer);
    timer = auto.checked ? setInterval(scan, SCAN_INTERVAL_MS) : null;
  };
  auto.addEventListener('change', apply);
  apply();
  // Basic routers: refresh the one shown now and then.
  setInterval(() => { if (view.router && R(view.router) && !R(view.router).supported) refreshBasic(view.router); }, POLL_MS);
}

// The background service stopped (or came back): show a clear banner, keep trying, and carry on when it returns.
function setupOffline() {
  if (!window.netmonPing) return; // only in the browser version
  let retryTimer = null;
  const retry = async () => {
    const btn = $('#offlineRetry');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    await window.netmonPing(); // fires netmon-online if the service answers
    btn.disabled = false;
    btn.textContent = 'Try again';
  };
  window.addEventListener('netmon-offline', async () => {
    $('#offlineBar').hidden = false;
    setStatus("The monitor's background service isn't running.", 'bad');
    clearInterval(retryTimer);
    retryTimer = setInterval(() => window.netmonPing(), 5000);
    // The service has shut down: close this window too. Check once more first, so a brief hiccup can't close it.
    await new Promise((r) => setTimeout(r, 3000));
    if (await window.netmonPing()) return; // it's back
    const text = $('#offlineBar p');
    text.textContent = 'The monitor has shut down. Closing this window…';
    await new Promise((r) => setTimeout(r, 1500));
    window.close(); // allowed for the app window the shortcut opens
    // Still here (a normal browser tab can't close itself): leave the explanation and the Try again button.
    setTimeout(() => {
      text.replaceChildren(el('strong', { text: "The monitor's background service has stopped." }),
        ' Reopen ', el('strong', { text: 'Home Network Monitor' }), ' from its shortcut to start it again. This page will carry on by itself once it\'s back.');
    }, 500);
  });
  window.addEventListener('netmon-online', () => {
    $('#offlineBar').hidden = true;
    clearInterval(retryTimer);
    retryTimer = null;
    setStatus('Reconnected to the monitor.');
    refreshView();
    scan();
  });
  $('#offlineRetry').addEventListener('click', retry);
}

async function init() {
  setupOffline();
  const saved = await api.loadData();
  if (saved) data = { ...data, ...saved };
  try { routers = await api.routers(); } catch (e) { setStatus('Could not load your routers: ' + cleanError(e), 'bad'); }
  migrateData();

  setupTheme();
  setupAbout();
  setupUssd();
  setupMessages();
  setupFibre();
  setupSettings();
  setupAdd();
  setupAi();
  setupTabs();
  setupScanning();
  for (const r of routers) if (supportedKind(r.id, 'fibre')) refreshFibre(r.id);
  scan();
}

init();
