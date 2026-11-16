// Connects the dashboard to the local server (window.netmon is the page's API to it).
'use strict';

if (!window.netmon) {
  // Tells the page when the background service stops answering, and when it's back.
  let serverDown = false;
  const setDown = (down) => {
    if (down === serverDown) return;
    serverDown = down;
    window.dispatchEvent(new Event(down ? 'netmon-offline' : 'netmon-online'));
  };

  const call = async (method, url, body) => {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'X-NetMon': '1', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      // No answer at all: the monitor's background service isn't running.
      setDown(true);
      throw new Error("The monitor's background service isn't running. Reopen Home Network Monitor to start it again.");
    }
    setDown(false);
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error) || `Request failed (${res.status})`);
    return json;
  };
  window.netmonPing = () => call('POST', '/api/ping').then(() => true, () => false);

  window.netmon = {
    scan: () => call('POST', '/api/scan'),
    loadData: () => call('GET', '/api/data'),
    saveData: (data) => call('POST', '/api/data', data),
    notify: async (title, body) => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body, icon: '/icon.ico' });
    },
    setTrayText: (text) => { document.title = text; },
    identify: (ip) => call('GET', '/api/identify?ip=' + encodeURIComponent(ip)),

    // Router list
    routers: () => call('GET', '/api/routers'),
    detectRouter: (host) => call('POST', '/api/routers/detect', { host }),
    addRouter: (info) => call('POST', '/api/routers', info),
    routerSettings: (id, changes) => call('POST', `/api/routers/${id}/settings`, changes),
    removeRouter: (id) => call('POST', `/api/routers/${id}/remove`, {}),
    routerBasic: (id) => call('GET', `/api/routers/${id}/basic`),

    // 4G (ZLT) routers
    routerStatus: (id) => call('GET', `/api/routers/${id}/status`),
    routerClients: (id) => call('GET', `/api/routers/${id}/clients`),
    wifiClients: (id) => call('GET', `/api/routers/${id}/wifi-clients`),
    routerUssd: (id, code) => call('POST', `/api/routers/${id}/ussd`, { code }),
    routerUssdCancel: (id) => call('POST', `/api/routers/${id}/ussd/cancel`, {}),
    routerSms: (id, box) => call('GET', `/api/routers/${id}/sms?box=` + encodeURIComponent(box)),
    sendSms: (id, phone, text) => call('POST', `/api/routers/${id}/sms/send`, { phone, text }),
    markSmsRead: (id, indexes) => call('POST', `/api/routers/${id}/sms/read`, { indexes }),
    deleteSms: (id, box, indexes) => call('POST', `/api/routers/${id}/sms/delete`, { box, indexes }),

    // Fibre (ONT) routers
    fibreStatus: (id) => call('GET', `/api/routers/${id}/fibre`),
    fibreCheck: (id, viaWifi) => call('POST', `/api/routers/${id}/fibre/check`, { viaWifi: !!viaWifi }),
    blockDevice: (id, mac, name, viaWifi) => call('POST', `/api/routers/${id}/block`, { mac, name, viaWifi: !!viaWifi }),
    unblockDevice: (id, mac, viaWifi) => call('POST', `/api/routers/${id}/unblock`, { mac, viaWifi: !!viaWifi }),
    disconnectDevice: (id, mac, name, seconds, viaWifi) => call('POST', `/api/routers/${id}/disconnect`, { mac, name, seconds, viaWifi: !!viaWifi }),

    // About
    about: () => call('GET', '/api/about'),

    // Ask AI
    aiStatus: () => call('GET', '/api/ai/status'),
    aiSaveSettings: (settings) => call('POST', '/api/ai/settings', settings),
    aiChat: (messages, context) => call('POST', '/api/ai/chat', { messages, context }),

    // This PC's Wi-Fi
    pcWifi: () => call('GET', '/api/pc/wifi'),
    setPcBand: (band) => call('POST', '/api/pc/band', { band }),
    joinNetwork: (routerId, band) => call('POST', '/api/pc/join', { routerId, band }),
    onScanRequest: () => {}
  };

  // Tell the server the window is still open so it doesn't shut down.
  setInterval(() => { call('POST', '/api/ping').catch(() => {}); }, 30 * 1000);
  // Background windows get their timers slowed down, so check in straight away when the window comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') call('POST', '/api/ping').catch(() => {});
  });
  // Holding a Web Lock asks the browser not to freeze this page in the background (Edge "sleeping tabs").
  try { if (navigator.locks) navigator.locks.request('netmon-keep-awake', () => new Promise(() => {})).catch(() => {}); } catch { /* not supported */ }
}
