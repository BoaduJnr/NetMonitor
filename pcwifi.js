// This PC's own Wi-Fi: which band it's on, and switching between a router's 2.4 GHz and 5 GHz networks.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { wifi } = require('./fibre');

async function status() {
  const { out } = await wifi.run('netsh', ['wlan', 'show', 'interfaces']);
  const field = (name) => {
    const m = new RegExp('^\\s*' + name + '\\s*:\\s*(.+)$', 'm').exec(out);
    return m ? m[1].trim() : null;
  };
  const band = field('Band');
  // Default gateway tells us which router the PC is on, whatever the Wi-Fi happens to be called.
  const route = await wifi.run('route', ['print', '-4', '0.0.0.0']);
  const gw = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(route.out);
  return {
    gateway: gw ? gw[1] : null,
    ssid: field('SSID'),
    band: band ? (band.startsWith('5') ? '5' : band.startsWith('2') ? '2.4' : band) : null,
    signal: field('Signal'),
    rateMbps: Number(field('Receive rate \\(Mbps\\)')) || null
  };
}

async function hasProfile(ssid) {
  const { out } = await wifi.run('netsh', ['wlan', 'show', 'profiles']);
  return out.split(/\r?\n/).some((l) => /:\s*(.+)$/.test(l) && l.replace(/^.*?:\s*/, '').trim() === ssid);
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Saves a WPA2-Personal network in Windows so it can be joined. The key file is deleted straight after.
async function addProfile(ssid, key) {
  const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(ssid)}</name>
  <SSIDConfig><SSID><name>${xmlEscape(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(key)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
  const file = path.join(os.tmpdir(), `netmon-${crypto.randomBytes(6).toString('hex')}.xml`);
  fs.writeFileSync(file, xml, { encoding: 'utf8', mode: 0o600 });
  try {
    const r = await wifi.run('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current']);
    if (!r.ok) throw new Error(`Windows would not save the "${ssid}" Wi-Fi network.`);
  } finally {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

// Moves this PC to `ssid`. getKey() is only called if Windows doesn't know the network yet.
async function switchTo(ssid, getKey) {
  if (!(await hasProfile(ssid))) {
    const key = getKey ? await getKey() : null;
    if (!key) throw new Error(`Windows doesn't have the password for "${ssid}". Join it once from the Wi-Fi menu, then try again.`);
    await addProfile(ssid, key);
  }
  const from = (await status()).ssid;
  const ok = await wifi.joinWifi(ssid, async () => true);
  if (!ok) {
    if (from && from !== ssid) await wifi.joinWifi(from, async () => true); // don't leave the PC offline
    throw new Error(`Could not join "${ssid}". Is that network switched on? This PC stayed on "${from}".`);
  }
  await wifi.sleep(2500); // let Windows get an address before the next scan
  return status();
}

module.exports = { status, switchTo };
