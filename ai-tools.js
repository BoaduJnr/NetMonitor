// Tools the "Ask AI" assistant can call. Read tools answer straight away; propose_* tools only
// describe an action for the user to approve in the chat (the page carries it out on approval).
// Nothing returned here may contain passwords or Wi-Fi keys.
'use strict';

const dns = require('dns');
const { execFile } = require('child_process');

const subnetOf = (ip) => String(ip || '').split('.').slice(0, 3).join('.');
const macKey = (mac) => String(mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

function ping(host, count = 4) {
  return new Promise((resolve) => {
    execFile('ping', ['-n', String(count), '-w', '1000', host], { windowsHide: true, timeout: 15000 }, (err, out) => {
      const text = String(out || '');
      const lost = /\((\d+)% loss\)/.exec(text);
      const avg = /Average = (\d+)ms/.exec(text);
      resolve({ host, lossPercent: lost ? Number(lost[1]) : 100, averageMs: avg ? Number(avg[1]) : null });
    });
  });
}

function lookup(name, timeoutMs = 4000) {
  return Promise.race([
    dns.promises.lookup(name).then((r) => ({ name, ok: true, address: r.address })).catch((e) => ({ name, ok: false, error: e.code || e.message })),
    new Promise((r) => setTimeout(() => r({ name, ok: false, error: 'timed out' }), timeoutMs))
  ]);
}

// deps: { store, DRIVERS, runScan, lastScan(), pcWifiSummary, ontStatus, readData, thisPcMacs }
function buildTools(deps) {
  const { store, DRIVERS } = deps;

  const routerOf = (id) => {
    const r = store.routers.find((x) => x.id === id);
    if (!r) throw new Error(`No router with id "${id}". Call list_routers for the ids.`);
    return { r, d: DRIVERS[r.driver] || DRIVERS.generic };
  };
  const supported = (id, kind) => {
    const { r, d } = routerOf(id);
    if (!d.supported || d.kind !== kind) throw new Error(`"${r.name}" isn't a ${kind === 'mobile' ? '4G' : 'fibre'} router the app can log in to.`);
    return { r, d, client: store.client(id) };
  };
  const scanNet = (scan) => {
    if (!scan) return null;
    const r = store.routers.find((x) => subnetOf(x.host) === subnetOf(scan.gateway));
    return r ? r.id : null;
  };
  const prop = { type: 'string' };
  const netOfKd = (kd) => kd.net || (String(kd.key).startsWith('f:') ? 'fibre' : '4g');
  const ago = (iso) => {
    if (!iso) return 'never';
    const m = (Date.now() - new Date(iso)) / 60000;
    return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };

  // Everything live the app can learn about one router's network right now (cached per question).
  async function networkView(r, cache) {
    if (cache.has(r.id)) return cache.get(r.id);
    const d = DRIVERS[r.driver] || DRIVERS.generic;
    const wifi = cache.has('pc') ? cache.get('pc') : await deps.pcWifiSummary().catch(() => null);
    cache.set('pc', wifi);
    const pcOnIt = !!(wifi && subnetOf(wifi.gateway) === subnetOf(r.host));
    let scan = deps.lastScan();
    if (pcOnIt && (!scan || scanNet(scan) !== r.id || Date.now() - new Date(scan.scannedAt) > 3 * 60 * 1000)) {
      scan = await deps.runScan().catch(() => scan);
    }
    const view = {
      pcOnIt,
      scan: scan && scanNet(scan) === r.id ? new Map(scan.devices.map((x) => [macKey(x.mac) || x.ip, x])) : null,
      dhcp: new Map(),  // devices the router says are joined (4G routers)
      bands: new Map(), // Wi-Fi band per device (4G routers)
      wifiNames: ((await deps.wifiPairs().catch(() => ({}))) || {})[r.id] || {},
      internet: null
    };
    if (pcOnIt && d.supported && d.kind === 'mobile') {
      const c = store.client(r.id);
      try { for (const x of await c.clients()) view.dhcp.set(macKey(x.mac), x); } catch { /* busy */ }
      try { for (const x of await c.wifiClients()) view.bands.set(macKey(x.mac), x); } catch { /* busy */ }
      try { view.internet = (await c.status()).connected; } catch { /* busy */ }
    }
    if (d.supported && d.kind === 'fibre') {
      const last = deps.ontReading(r.id);
      view.internet = last ? !!(last.working && last.internet !== false) : null;
      view.blocked = new Set(((last && last.blocked) || []).map((e) => macKey(e.mac)));
    }
    cache.set(r.id, view);
    return view;
  }

  // Connection state of one saved device, with plain advice on how to connect it.
  function describeDevice(kd, r, v) {
    const key = macKey(kd.mac);
    const now = v.scan && (v.scan.get(key) || v.scan.get(kd.lastIp));
    const joined = v.dhcp.get(key);
    const band = v.bands.get(key);
    const blocked = !!(v.blocked && v.blocked.has(key));
    let connection;
    if (now) connection = 'online';
    else if (joined) connection = 'asleep (joined to the router but not answering; often a phone with its screen off)';
    else if (v.pcOnIt && v.scan) connection = 'not connected';
    else connection = "unknown (this PC isn't on this router's network)";

    const names = [v.wifiNames['5'] && `"${v.wifiNames['5']}" (5 GHz: faster, best near the router)`, v.wifiNames['2.4'] && `"${v.wifiNames['2.4']}" (2.4 GHz: longer range, through walls)`].filter(Boolean);
    const advice = [];
    if (blocked) advice.push(`It is blocked on ${r.name}; unblock it first (the app can do this).`);
    if (connection.startsWith('not connected') || connection.startsWith('unknown')) {
      advice.push(`Turn on Wi-Fi on the device and join ${names.length ? names.join(' or ') : `${r.name}'s Wi-Fi`}, using the Wi-Fi password printed on the router (or in its settings).`);
      advice.push('If it was connected before and won\'t rejoin: forget the network on the device and join again, or restart the device.');
    }
    if (connection.startsWith('asleep')) advice.push('It is still joined; wake or unlock the device and it should answer.');
    if (v.internet === false) {
      const other = store.routers.find((x) => x.id !== r.id && (DRIVERS[x.driver] || {}).kind === 'mobile');
      advice.push(`Note: ${r.name} has no internet right now${other ? `; joining ${other.name}'s Wi-Fi would give it internet` : ''}.`);
    }
    if (band && band.signalDbm != null && band.signalDbm < -72) advice.push(`Its Wi-Fi signal is weak (${band.signalDbm} dBm); moving closer or using the 2.4 GHz network may help.`);

    return {
      name: kd.name || 'Unknown device', router: r.name, routerId: r.id, whereInApp: `${r.name} › Connections`, mac: kd.mac,
      ip: now ? now.ip : kd.lastIp || null, connection,
      wifi: band ? { band: `${band.band} GHz`, network: band.ssid, signalDbm: band.signalDbm } : null,
      pingMs: now ? now.pingMs : null, isThisPc: !!(now && now.isThisPc), isRouter: !!(now && now.isGateway) || kd.lastIp === r.host,
      lastSeen: now ? 'now' : joined ? 'now (joined to the router)' : ago(kd.lastSeen), model: kd.model || null, blocked, howToConnect: advice
    };
  }

  return [
    // ---------- Read ----------
    {
      name: 'list_routers',
      description: 'List the routers saved in the app: id, name, type, model, address, which sections the app supports, and whether the app can block devices on it. Start here when you need a router id.',
      parameters: { type: 'object', properties: {} },
      run: () => store.publicList().map((r) => ({ id: r.id, name: r.name, type: r.kind, model: r.model, address: r.host, fullySupported: r.supported, canBlockDevices: r.canBlock, wifiNames: { '5GHz': r.ssid5 || null, '2.4GHz': r.ssid24 || null } }))
    },
    {
      name: 'get_router_status',
      description: 'Live status of one router. 4G: mobile network, signal level 0-5, SIM, connection, data used since restart. Fibre: registration state (O1-O7; O5 = working), optical signal, internet, phone line, blocked devices (last reading, refreshed if this PC is on its network). Basic routers: whether reachable.',
      parameters: { type: 'object', properties: { router_id: prop }, required: ['router_id'] },
      run: async ({ router_id }) => {
        const { r, d } = routerOf(router_id);
        if (d.supported && d.kind === 'mobile') return { router: r.name, ...(await store.client(r.id).status()) };
        if (d.supported && d.kind === 'fibre') {
          const s = await deps.ontStatus(r.id, false);
          return { router: r.name, thisPcOnItsNetwork: s.reachable, lastReading: s.last, lastError: s.error };
        }
        return { router: r.name, model: r.model, note: 'Basic support only: the app cannot log in to this router type.' };
      }
    },
    {
      name: 'list_devices',
      description: 'Devices the app has seen, grouped by the router (network) they belong to: name, MAC, IP, connection (online / asleep / not connected / unknown), Wi-Fi band, last seen, blocked. Leave router_id out to list every router\'s devices. Use the MAC for device actions.',
      parameters: { type: 'object', properties: { router_id: prop } },
      run: async ({ router_id }) => {
        const data = deps.readData() || {};
        const routers = router_id ? [routerOf(router_id).r] : store.routers;
        const cache = new Map();
        const out = [];
        for (const r of routers) {
          const v = await networkView(r, cache);
          out.push({
            router: r.name, routerId: r.id,
            live: v.pcOnIt ? 'This PC is on this network, so connection states are live.' : "This PC isn't on this network, so connection states are unknown (last seen times still help).",
            devices: (data.devices || []).filter((kd) => netOfKd(kd) === r.id).map((kd) => {
              const x = describeDevice(kd, r, v);
              delete x.howToConnect; // keep the list short; find_device gives advice
              return x;
            })
          });
        }
        return out;
      }
    },
    {
      name: 'find_device',
      description: 'Find a device by name, MAC or IP across ALL routers. Tells which router (network/tab) it belongs to, whether it is connected now (online / asleep / not connected / unknown), its Wi-Fi band and signal, last seen, and step-by-step advice on how to connect it. Use for any question about a specific device ("is my iPhone connected?", "where is the TV?").',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of the device name, a MAC address or an IP address' } }, required: ['query'] },
      run: async ({ query }) => {
        const q = String(query || '').trim().toLowerCase();
        if (!q) throw new Error('Say which device to look for.');
        const data = deps.readData() || {};
        const qMac = macKey(q);
        // Every word must appear in the name or model ("samsung tv" finds "Samsung 6 Series (50) TV").
        const words = q.replace(/\b(my|the|a|an|device|phone's)\b/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
        const matches = (data.devices || []).filter((kd) => {
          const hay = `${kd.name || ''} ${kd.model || ''}`.toLowerCase();
          return (words.length && words.every((w) => hay.includes(w))) ||
            (/[:-]/.test(q) && qMac.length >= 6 && macKey(kd.mac).includes(qMac)) || (kd.lastIp && kd.lastIp === q);
        });
        if (!matches.length) {
          return { found: 0, message: `No saved device matches "${query}". It may never have joined a network this PC has scanned, or it has a different name; list_devices shows every device.` };
        }
        const cache = new Map();
        const results = [];
        for (const kd of matches.slice(0, 8)) {
          const r = store.routers.find((x) => x.id === netOfKd(kd));
          if (!r) { results.push({ name: kd.name, router: 'a router that is no longer in the app', lastSeen: ago(kd.lastSeen) }); continue; }
          results.push(describeDevice(kd, r, await networkView(r, cache)));
        }
        return { found: matches.length, devices: results };
      }
    },
    {
      name: 'scan_network',
      description: 'Scan the network this PC is on right now (takes 10-30 s): devices answering, ping to each, which router it is, and an internet ping test.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const s = await deps.runScan();
        const id = scanNet(s);
        return {
          router: id ? store.routers.find((x) => x.id === id).name : `unknown router at ${s.gateway}`,
          thisPc: s.myIp, gateway: s.gateway, internet: s.internet,
          devices: s.devices.map((d) => ({ ip: d.ip, mac: d.mac, hostname: d.hostname || null, pingMs: d.pingMs, isRouter: d.isGateway, isThisPc: d.isThisPc }))
        };
      }
    },
    {
      name: 'get_this_pc_wifi',
      description: 'This PC\'s Wi-Fi: network name, band (2.4/5 GHz), signal, link speed, which saved router it is on, and the 2.4/5 GHz network names it could switch between.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const s = await deps.pcWifiSummary();
        return { ssid: s.ssid, band: s.band, signal: s.signal, linkMbps: s.rateMbps, gateway: s.gateway, onRouter: s.network, bandOptions: s.options, networksByRouter: s.networks };
      }
    },
    {
      name: 'run_diagnostics',
      description: 'Diagnose this PC\'s connection: Wi-Fi signal, ping to the router (gateway), ping to the internet (1.1.1.1 and 8.8.8.8), DNS name lookup, and a web connectivity check. Use for "slow", "no internet" or "keeps dropping" questions.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const wifi = await deps.pcWifiSummary().catch(() => null);
        const gw = wifi && wifi.gateway;
        const [router, cloudflare, google, dnsGoogle, dnsMtn] = await Promise.all([
          gw ? ping(gw) : Promise.resolve({ error: 'no gateway' }), ping('1.1.1.1'), ping('8.8.8.8'), lookup('www.google.com'), lookup('mtn.com.gh')
        ]);
        let web = null;
        try {
          const t = Date.now();
          const res = await fetch('http://www.msftconnecttest.com/connecttest.txt', { signal: AbortSignal.timeout(6000) });
          web = { ok: res.ok && (await res.text()).includes('Microsoft Connect Test'), ms: Date.now() - t };
        } catch (e) { web = { ok: false, error: e.message }; }
        return { wifi: wifi && { ssid: wifi.ssid, band: wifi.band, signal: wifi.signal, linkMbps: wifi.rateMbps, onRouter: wifi.network }, pingRouter: router, pingInternet: [cloudflare, google], dns: [dnsGoogle, dnsMtn], webCheck: web };
      }
    },
    {
      name: 'get_wifi_bands',
      description: '4G router only: which Wi-Fi band (2.4 or 5 GHz) each wireless device uses, with signal in dBm and link speed.',
      parameters: { type: 'object', properties: { router_id: prop }, required: ['router_id'] },
      run: async ({ router_id }) => {
        const { client } = supported(router_id, 'mobile');
        const names = new Map(((deps.readData() || {}).devices || []).map((kd) => [macKey(kd.mac), kd.name]));
        return (await client.wifiClients()).map((c) => ({ device: names.get(macKey(c.mac)) || null, mac: c.mac, ip: c.ip, band: c.band + ' GHz', network: c.ssid, signalDbm: c.signalDbm, linkMbps: c.linkMbps }));
      }
    },
    {
      name: 'read_sms',
      description: '4G router only: text messages on its SIM (newest first), with whether the inbox is full and whether this login may send/delete.',
      parameters: { type: 'object', properties: { router_id: prop, box: { type: 'string', enum: ['inbox', 'sent'] }, limit: { type: 'integer' } }, required: ['router_id'] },
      run: async ({ router_id, box = 'inbox', limit = 10 }) => {
        const { client } = supported(router_id, 'mobile');
        const r = await client.smsList(box === 'sent' ? 'sent' : 'inbox');
        return { total: r.total, unread: r.messages.filter((m) => !m.read).length, full: r.full, canSend: r.canSend, canDelete: r.canDelete, messages: r.messages.slice(0, Math.min(30, Math.max(1, limit))).map((m) => ({ from: m.phone, date: m.date, read: m.read, text: m.text })) };
      }
    },
    {
      name: 'get_data_balance',
      description: '4G router only: the data balance history the app has recorded (newest last), and the USSD code it uses to check.',
      parameters: { type: 'object', properties: { router_id: prop }, required: ['router_id'] },
      run: ({ router_id }) => {
        routerOf(router_id);
        const data = deps.readData() || {};
        const list = ((data.balancesBy || {})[router_id] || []).slice().sort((a, b) => new Date(a.time) - new Date(b.time));
        const fmt = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`);
        return { ussdCode: (data.ussdBy || {})[router_id] || '*124#', entries: list.slice(-10).map((b) => ({ time: b.time, dataLeft: fmt(b.mb) })) };
      }
    },

    // ---------- Navigation (no approval needed) ----------
    {
      name: 'show_in_app',
      description: 'Put an "Open" button in the chat that takes the user to a router and a section of the app (sub nav): connections (devices list, disconnect/block buttons), data (balance & USSD, 4G only), calls (phone line), sms (texts, 4G only), info (readings and router settings), ai (this chat). Use it when you tell the user where something is.',
      parameters: { type: 'object', properties: { router_id: prop, section: { type: 'string', enum: ['connections', 'data', 'calls', 'sms', 'info', 'ai'] }, label: prop }, required: ['router_id', 'section'] },
      run: ({ router_id, section, label }, ctx) => {
        const { r, d } = routerOf(router_id);
        const sections = [...(d.sections || ['connections', 'info']), 'ai'];
        if (!sections.includes(section)) throw new Error(`${r.name} has no "${section}" section. It has: ${sections.join(', ')}.`);
        const names = { connections: 'Connections', data: 'Data', calls: 'Calls', sms: 'SMS', info: 'Information', ai: 'Ask AI' };
        ctx.propose({ type: 'navigate', params: { routerId: r.id, section }, summary: `Open ${r.name} › ${names[section]}`, reason: label || '' });
        return { status: 'shown', message: 'An Open button is shown to the user.' };
      }
    },

    // ---------- Actions: proposals the user must approve ----------
    {
      name: 'propose_switch_band',
      description: 'Propose moving THIS PC to the router\'s other Wi-Fi band (2.4 or 5 GHz). Shows an Approve card; does nothing until approved.',
      parameters: { type: 'object', properties: { band: { type: 'string', enum: ['2.4', '5'] }, reason: prop }, required: ['band'] },
      run: async ({ band, reason }, ctx) => {
        const s = await deps.pcWifiSummary();
        if (!s.options) throw new Error('The app doesn\'t know the 2.4/5 GHz network names for the network this PC is on.');
        if (s.band === band) return { status: 'not needed', message: `This PC is already on ${band} GHz (${s.ssid}).` };
        const a = ctx.propose({ type: 'switch_band', params: { band }, summary: `Move this PC to ${band} GHz ("${s.options[band]}")`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    },
    {
      name: 'propose_connect_pc',
      description: 'Propose connecting THIS PC to a saved router\'s Wi-Fi (e.g. to move it from one router\'s network to another). Optional band "5" or "2.4" (default 5). Shows an Approve card. Only for this PC; other devices must be connected on the device itself.',
      parameters: { type: 'object', properties: { router_id: prop, band: { type: 'string', enum: ['2.4', '5'] }, reason: prop }, required: ['router_id'] },
      run: async ({ router_id, band = '5', reason }, ctx) => {
        const { r } = routerOf(router_id);
        const names = ((await deps.wifiPairs()) || {})[r.id] || {};
        const ssid = names[band] || names[band === '5' ? '2.4' : '5'];
        if (!ssid) throw new Error(`The app doesn't know ${r.name}'s Wi-Fi name. Add it under Information › Router settings.`);
        const wifi = await deps.pcWifiSummary().catch(() => null);
        if (wifi && wifi.ssid === ssid) return { status: 'not needed', message: `This PC is already on "${ssid}".` };
        const a = ctx.propose({ type: 'join_network', params: { routerId: r.id, band: names[band] ? band : (band === '5' ? '2.4' : '5') }, summary: `Connect this PC to ${r.name}'s Wi-Fi ("${ssid}")`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    },
    {
      name: 'propose_device_action',
      description: 'Propose disconnecting (kick off for ~10 s, it can reconnect), blocking (kept off until unblocked) or unblocking a device on a router that supports it (canBlockDevices). Needs the device MAC from list_devices. Shows an Approve card.',
      parameters: { type: 'object', properties: { router_id: prop, action: { type: 'string', enum: ['disconnect', 'block', 'unblock'] }, mac: prop, device_name: prop, reason: prop }, required: ['router_id', 'action', 'mac'] },
      run: ({ router_id, action, mac, device_name, reason }, ctx) => {
        const { r, d } = routerOf(router_id);
        if (!d.canBlock) throw new Error(`The app can't ${action} devices on "${r.name}": its login isn't allowed to change the block list.`);
        if (!MAC_RE.test(String(mac || ''))) throw new Error('That is not a valid MAC address.');
        if (deps.thisPcMacs().has(macKey(mac))) throw new Error('That is this PC; the app never blocks or disconnects itself.');
        const a = ctx.propose({ type: 'device', params: { routerId: r.id, action, mac, name: device_name || mac }, summary: `${action[0].toUpperCase() + action.slice(1)} "${device_name || mac}" on ${r.name}`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    },
    {
      name: 'propose_check_balance',
      description: '4G router only: propose dialling a USSD code (default the saved balance code, e.g. *124#) to check the data balance. Shows an Approve card.',
      parameters: { type: 'object', properties: { router_id: prop, code: prop, reason: prop }, required: ['router_id'] },
      run: ({ router_id, code, reason }, ctx) => {
        const { r } = supported(router_id, 'mobile');
        const c = String(code || ((deps.readData() || {}).ussdBy || {})[router_id] || '*124#').trim();
        if (!/^[0-9*#]{2,40}$/.test(c)) throw new Error('A USSD code can only contain digits, * and #.');
        const a = ctx.propose({ type: 'ussd', params: { routerId: r.id, code: c }, summary: `Dial ${c} on ${r.name} to check the balance`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    },
    {
      name: 'propose_send_sms',
      description: '4G router only: propose sending a text from the router\'s SIM. Note: the current login is usually not allowed to send (check read_sms canSend first). Shows an Approve card.',
      parameters: { type: 'object', properties: { router_id: prop, phone: prop, text: prop, reason: prop }, required: ['router_id', 'phone', 'text'] },
      run: ({ router_id, phone, text, reason }, ctx) => {
        const { r } = supported(router_id, 'mobile');
        const p = String(phone || '').replace(/[\s-]/g, '');
        if (!/^\+?\d{2,31}$/.test(p)) throw new Error('Phone number must be digits (a leading + is fine).');
        if (!String(text || '').trim()) throw new Error('The message is empty.');
        const a = ctx.propose({ type: 'sms', params: { routerId: r.id, phone: p, text: String(text).slice(0, 640) }, summary: `Send a text to ${p} from ${r.name}: "${String(text).slice(0, 80)}"`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    },
    {
      name: 'propose_fibre_check',
      description: 'Fibre router only: propose a fresh full check. If this PC is on another network it briefly switches Wi-Fi to the fibre network and back (~30 s). Shows an Approve card.',
      parameters: { type: 'object', properties: { router_id: prop, reason: prop }, required: ['router_id'] },
      run: ({ router_id, reason }, ctx) => {
        const { r } = supported(router_id, 'fibre');
        const a = ctx.propose({ type: 'fibre_check', params: { routerId: r.id }, summary: `Run a fresh check of ${r.name} (may briefly switch this PC's Wi-Fi)`, reason: reason || '' });
        return { status: 'proposed', id: a.id, message: 'Shown to the user with an Approve button.' };
      }
    }
  ];
}

module.exports = { buildTools };
