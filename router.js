// Talks to the 4G router's admin interface (MTN ZLT S50 / SIMCom-style firmware).
// All requests are JSON POSTs to /cgi-bin/http.cgi with a numeric "cmd".
'use strict';

const http = require('http');
const crypto = require('crypto');

const CMD = {
  SYS_INFO: 0,
  WIRELESS_CONFIG: 2,
  SMS_INFO: 12,
  SMS_SEND: 13,
  SMS_DELETE: 14,
  LOGIN: 100,
  GET_SYS_STATUS: 113,
  WIRELESS5G_CONFIG: 211,
  WIFI24G_LIST: 224,
  WIFI5G_LIST: 225,
  DHCPCLIENT_INFO: 223,
  GET_NEXT_LOGIN_TIME: 232,
  USSD_SEND: 350
};

const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const flag = (v) => v === true || v === '1' || v === 1;

const SMS_BOX = { inbox: 0, sent: 1 };
const SMS_PAGE_SIZE = 10; // the router hands out messages ten at a time
const SMS_MAX_CHARS = 640;

// Each message is base64 of "index flag sender YYYY/MM/DD HH:MM:SS text…".
function parseSms(entry) {
  // Some senders are padded with invisible control characters; drop them.
  const parts = Buffer.from(entry, 'base64').toString('utf8').replace(/[\u0000-\u0009\u000B-\u001F\u007F�]/g, '').split(' ');
  if (parts.length < 5) return null;
  return {
    index: parts[0],
    read: parts[1] === '1', // in the inbox: 1 = read; in sent: 1 = delivered to the network
    phone: parts[2],
    date: parts[3] + ' ' + parts[4],
    text: parts.slice(5).join(' ')
  };
}

function smsBox(box) {
  if (!(box in SMS_BOX)) throw new Error('Unknown message folder.');
  return SMS_BOX[box];
}

function smsIndexes(indexes) {
  const list = (Array.isArray(indexes) ? indexes : [indexes]).map(String);
  if (!list.length || !list.every((i) => /^\d{1,5}$/.test(i))) throw new Error('No valid messages selected.');
  return list.join(',');
}

// USSD replies arrive as UCS-2 hex (4 hex digits per character).
function decodeUssd(str) {
  if (!str) return '';
  if (!/^[0-9A-Fa-f]+$/.test(str) || str.length % 4 !== 0) return str;
  let out = '';
  for (let i = 0; i < str.length; i += 4) {
    const chunk = str.slice(i, i + 4);
    if (chunk === '0000') continue;
    out += String.fromCharCode(parseInt(chunk, 16));
  }
  return out;
}

class Router {
  constructor(getConfig) {
    this.getConfig = getConfig; // () => { host, username, password }
    this.sessionId = null;
    this.queue = Promise.resolve();
  }

  // Run router conversations one at a time; the firmware doesn't like overlapping sessions.
  serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  post(json, timeoutMs = 15000) {
    const { host } = this.getConfig();
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(json);
      const req = http.request({
        host, path: '/cgi-bin/http.cgi', method: 'POST', timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest'
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('The router sent a reply the app could not read.')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('The router did not answer in time.')));
      req.on('error', (e) => reject(e.message.includes('answer in time') ? e : new Error('Could not reach the router: ' + e.message)));
      req.end(body);
    });
  }

  async login() {
    const { username, password } = this.getConfig();
    const t = await this.post({ cmd: CMD.GET_NEXT_LOGIN_TIME, method: 'GET', sessionId: '', language: 'EN' });
    if (!t.token) throw new Error('The router did not offer a login.');
    const sessionId = crypto.randomBytes(32).toString('hex');
    const r = await this.post({
      cmd: CMD.LOGIN, method: 'POST', sessionId, language: 'EN',
      username,
      passwd: crypto.createHash('sha256').update(t.token + password).digest('hex'),
      isAutoUpgrade: '0'
    });
    if (r.login_fail === 'fail' || !r.sessionId) {
      const left = r.login_times != null ? ` (${r.login_times} tries left before the router locks logins for 3 minutes)` : '';
      throw new Error('Router login failed. Check the router username and password' + left + '.');
    }
    this.sessionId = r.sessionId;
    this.level = r.user_level || null; // 1 = highest; 3 = basic user, which can't delete texts
  }

  // False once the router has refused a delete, or the login is the basic (level 3) account.
  canDeleteSms() {
    return !this.smsDeleteDenied && this.level !== '3';
  }

  // Same rule for sending: the basic (level 3) account is refused.
  canSendSms() {
    return !this.smsSendDenied && this.level !== '3';
  }

  async call(json, timeoutMs) {
    if (!this.sessionId) await this.login();
    let r = await this.post({ ...json, sessionId: this.sessionId, language: 'EN' }, timeoutMs);
    if (r.message === 'NO_AUTH' || r.message === 'LOGIN_TIMEOUT') {
      this.sessionId = null;
      await this.login();
      r = await this.post({ ...json, sessionId: this.sessionId, language: 'EN' }, timeoutMs);
    }
    return r;
  }

  forgetSession() {
    this.sessionId = null;
    this.level = null;
    this.smsDeleteDenied = false; // new login details may have more rights
    this.smsSendDenied = false;
  }

  status() {
    return this.serialize(async () => {
      const s = await this.call({ cmd: CMD.GET_SYS_STATUS, method: 'GET' });
      const i = await this.call({ cmd: CMD.SYS_INFO, method: 'GET' });
      return {
        operator: (s.network_operator || '').replace('Ineternet', 'Internet').trim() || null,
        networkType: s.network_type_str || null,
        signalLevel: num(s.signal_lvl),
        simReady: s.sim_status === '1',
        connected: s.network_status === '1',
        rxBytes: num(i.wanRxBytes),
        txBytes: num(i.wanTxBytes)
      };
    });
  }

  // Devices the router has handed an address to, with the name each device announced.
  clients() {
    return this.serialize(async () => {
      const r = await this.call({ cmd: CMD.DHCPCLIENT_INFO, method: 'GET' });
      return (r.dhcp_list_info || [])
        .filter((c) => c && c.mac)
        .map((c) => ({
          mac: c.mac.toUpperCase().replace(/:/g, '-'),
          ip: c.ip || null,
          hostname: c.hostname && c.hostname !== '*' ? c.hostname : null,
          wired: c.interface === 'lan'
        }));
    });
  }

  // Which Wi-Fi band each wireless device is on, with signal and link speed.
  wifiClients() {
    return this.serialize(async () => {
      const out = [];
      for (const [cmd, key, band] of [[CMD.WIFI24G_LIST, 'wlan24g_wifi_info', '2.4'], [CMD.WIFI5G_LIST, 'wlan5g_wifi_info', '5']]) {
        const r = await this.call({ cmd, method: 'GET' });
        for (const c of r[key] || []) {
          if (!c || !c.mac) continue;
          const rssi = num(c.rssi);
          out.push({
            mac: c.mac.toUpperCase().replace(/:/g, '-'),
            ip: c.ip || null,
            band,
            ssid: c.ssid || null,
            signalDbm: rssi == null ? null : -Math.abs(rssi), // reported without the minus sign
            linkMbps: num(c.txrate)
          });
        }
      }
      return out;
    });
  }

  // The router's two Wi-Fi networks. Includes the Wi-Fi password: for the server only, never the page.
  wifiNetworks() {
    return this.serialize(async () => {
      const r24 = await this.call({ cmd: CMD.WIRELESS_CONFIG, method: 'GET' });
      const r5 = await this.call({ cmd: CMD.WIRELESS5G_CONFIG, method: 'GET' });
      const b64 = (s) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return s; } };
      return {
        ssid24: r5.ssid24G || b64(r24.ssid),
        ssid5: r24.ssid5G || b64(r5.ssid),
        key24: r24.key || null,
        key5: r5.key || null
      };
    });
  }

  // Sends a USSD code (or a menu reply) and waits for the network's answer.
  ussd(code) {
    code = String(code || '').trim();
    if (!/^[0-9*#]{1,40}$/.test(code)) {
      return Promise.reject(new Error('A USSD code can only contain digits, * and #.'));
    }
    return this.serialize(async () => {
      const sent = await this.call({ cmd: CMD.USSD_SEND, method: 'POST', subcmd: '0', ussd_code: code });
      if (!sent.success) throw new Error('The router could not send the code. Is the SIM connected?');

      // The answer usually arrives within a few seconds; keep asking for up to ~20 s.
      for (let attempt = 0; attempt < 9; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 2000));
        const r = await this.call({ cmd: CMD.USSD_SEND, method: 'GET' });
        const message = decodeUssd(r.message);
        if (message) return { message, needReply: r.need_reply === '1' };
      }
      throw new Error('No reply from the network yet. Try again in a minute.');
    });
  }

  cancelUssd() {
    return this.serialize(async () => {
      await this.call({ cmd: CMD.USSD_SEND, method: 'POST', subcmd: '1' });
      return { ok: true };
    });
  }

  // All messages in a folder ('inbox' or 'sent'), newest first.
  smsList(box) {
    const subcmd = smsBox(box);
    return this.serialize(async () => {
      const messages = [];
      let first = null;
      for (let page = 1; page <= 50; page++) {
        const r = await this.call({ cmd: CMD.SMS_INFO, method: 'GET', page_num: page, subcmd });
        if (!r.success && r.message) throw new Error('The router would not list messages (' + r.message + ').');
        if (!first) first = r;
        const entries = r.sms_list ? r.sms_list.split(',') : [];
        for (const e of entries) {
          const m = parseSms(e);
          if (m) messages.push(m);
        }
        if (entries.length < SMS_PAGE_SIZE || messages.length >= num(r.sms_total)) break;
      }
      messages.sort((a, b) => b.date.localeCompare(a.date) || Number(b.index) - Number(a.index));
      return {
        messages,
        total: num(first.sms_total) || messages.length,
        unread: num(first.sms_unread) || 0,
        full: flag(box === 'inbox' ? first.receive_full : first.send_full),
        canDelete: this.canDeleteSms(),
        canSend: this.canSendSms()
      };
    });
  }

  sendSms(phone, text) {
    phone = String(phone || '').replace(/[\s-]/g, '');
    text = String(text || '');
    if (!/^\+?\d{2,31}$/.test(phone)) return Promise.reject(new Error('Enter a phone number using digits only (a leading + is fine).'));
    if (!text.trim()) return Promise.reject(new Error('Type a message first.'));
    if (text.length > SMS_MAX_CHARS) return Promise.reject(new Error(`Messages can be at most ${SMS_MAX_CHARS} characters.`));
    if (/[\uD800-\uDFFF]/.test(text)) return Promise.reject(new Error('The router cannot send emoji. Remove them and try again.'));
    return this.serialize(async () => {
      const r = await this.call({
        cmd: CMD.SMS_SEND, method: 'POST', phoneNo: phone,
        content: Buffer.from(text, 'utf8').toString('base64')
      }, 60000);
      if (r.message === 'NO_AUTH') {
        this.smsSendDenied = true;
        throw new Error("The router's login used by this app isn't allowed to send texts. Nothing was sent.");
      }
      if (!(r.success === true || r.message === '0')) throw new Error('The router could not send the message. Check the number and your airtime.');
      return { ok: true };
    });
  }

  markSmsRead(indexes) {
    const index = smsIndexes(indexes);
    return this.serialize(async () => {
      await this.call({ cmd: CMD.SMS_INFO, method: 'POST', index });
      return { ok: true };
    });
  }

  // indexes: a list of message numbers, or 'all' to empty the folder.
  deleteSms(box, indexes) {
    const subcmd = smsBox(box);
    const index = indexes === 'all' ? 'DELETE ALL' : smsIndexes(indexes);
    return this.serialize(async () => {
      const r = await this.call({ cmd: CMD.SMS_DELETE, method: 'POST', subcmd, index });
      if (r.message === 'NO_AUTH') {
        this.smsDeleteDenied = true;
        throw new Error("The router's login used by this app isn't allowed to delete texts.");
      }
      if (r.message !== '0' && r.success !== true) throw new Error('The router could not delete the message.');
      return { ok: true };
    });
  }
}

module.exports = { Router, decodeUssd, SMS_MAX_CHARS };
