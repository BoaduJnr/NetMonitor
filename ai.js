// "Ask AI": a chat assistant that answers with live readings from your routers, through tool calls.
// Read tools run straight away; anything that changes something is only *proposed* and appears in the
// chat as a card the user has to approve. The API key (NVIDIA, OpenAI or Anthropic) stays on this PC's server.
'use strict';

const fs = require('fs');
const path = require('path');

// The AI services the app can use. "openai" style = OpenAI chat-completions format (NVIDIA uses it too).
// There is no default: the app ships without keys, and the user picks a service, model and key in Ask AI.
// `example` is only a placeholder hint in the model box.
const PROVIDERS = {
  nvidia: {
    label: 'NVIDIA', style: 'openai', url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    example: 'nvidia/nemotron-3.5-bolt-e4b', keyUrl: 'https://build.nvidia.com'
  },
  openai: {
    label: 'OpenAI', style: 'openai', url: 'https://api.openai.com/v1/chat/completions',
    example: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    label: 'Anthropic', style: 'anthropic', url: 'https://api.anthropic.com/v1/messages',
    example: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys'
  }
};

// Chat-completions messages → Anthropic Messages API { system, messages }.
function toAnthropic(messages) {
  let system = '';
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    const text = String(m.content || '');
    if (m.role === 'system') system += (system ? '\n\n' : '') + text;
    else if (m.role === 'user') { if (text.trim()) push('user', [{ type: 'text', text }]); }
    else if (m.role === 'assistant') {
      const blocks = text.trim() ? [{ type: 'text', text }] : [];
      for (const c of m.tool_calls || []) {
        let input = {};
        try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { /* bad JSON: empty input */ }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
      }
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text }]);
  }
  while (out.length && out[0].role !== 'user') out.shift(); // the conversation must start with the user
  return { system, messages: out };
}

// Anthropic reply → the chat-completions message shape the rest of this file uses.
function fromAnthropic(j) {
  const blocks = Array.isArray(j.content) ? j.content : [];
  return {
    role: 'assistant',
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    tool_calls: blocks.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }))
  };
}

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 24;          // messages of earlier conversation sent with each question
const MAX_TOOL_RESULT = 7000;    // characters of each tool result passed back to the model

const SYSTEM_PROMPT = `You are the assistant inside "Home Network Monitor", a Windows app that watches the user's home routers and the devices on them.

How to work:
- Answer from live data. Call tools to look things up before answering; never guess readings, names or numbers.
- Keep answers short and plain: a sentence or two, then bullets if needed. No jargon without a short explanation.
- To change anything (switch Wi-Fi band, disconnect/block/unblock a device, check the balance by USSD, send a text, run a fibre check that switches Wi-Fi), call the matching propose_* tool. That only shows the user an "Approve" card; nothing happens until they click it. Tell them to approve it. Never claim an action is done until you see an "[Action result]" message.
- A device is identified by its MAC address; get it from list_devices.
- You can't log in as a higher-level router account, bypass router restrictions, or guess passwords. If something is restricted, say so and suggest what the user can do.
- If a tool fails, say what failed in plain words.
- Never show tool names, function-call syntax, router ids or JSON to the user. Refer to routers by name. To offer a next step, either just do the lookup yourself or ask in plain words (e.g. "Want me to check the 4G signal?").
- For slow, dropping or missing internet: run run_diagnostics AND get_router_status for the router the PC is on (for a 4G router, a weak mobile signal level 0-2 is a common cause), then give the likely cause and 1-3 practical fixes (e.g. move the 4G router near a window, switch band, restart the router).

The app's layout (tell users where things are, as "<router name> › <section>", and call show_in_app to give them a button):
- Top: one button per saved router (e.g. "4G router", "Fibre") plus "Add router". Each router has its own dashboard cards.
- Sub nav under each router: Connections (that router's devices: status, Wi-Fi band, IP, last seen; Disconnect/Block/Unblock buttons where allowed), Data (4G: data balance, USSD check, history; fibre: internet status), Calls (4G: not available; fibre: phone line), SMS (4G: inbox/sent and new message; fibre: SIM info), Information (router readings and Router settings: name, login, Wi-Fi names, Remove), Ask AI (this chat).
- Every device belongs to exactly one router: it appears under that router's Connections.

Devices:
- When the user mentions a device in any way ("my iPhone", "the TV", "Samsung"), immediately call find_device with that word. Never ask them for a name or MAC first. Only if nothing is found, call list_devices and offer the closest names.
- For a question about a specific device, call find_device. Say which router it is on (where it is in the app), whether it is connected now, and if it isn't, give its howToConnect advice in plain steps.
- Connection states: online; asleep = still joined but not answering; not connected = this PC is on that network and the device isn't there; unknown = this PC is on a different network (give last seen).
- You can't connect other devices for the user; tell them how. For this PC you can propose_connect_pc.

Known facts about this home (check with tools for current values):
- 4G router: ZLT S50 (MTN TurboNet). The app's "admin" login is level 3: reading SMS, USSD balance checks, status, devices and Wi-Fi bands work; sending/deleting SMS, speed limits, blocking and modem commands are restricted to level 1-2 accounts that MTN holds. It can't carry calls.
- Fibre router: Huawei HG8145X6-10 (MTN). Its "root" login can read registration state, fibre signal, phone line, and block/unblock/disconnect devices on its Wi-Fi. It's on a separate network; the PC has one Wi-Fi card, so checking it from the 4G network means briefly switching Wi-Fi.`;

// A plain answer written from find_device results, for when the model says nothing.
function describeFound(res) {
  if (!res || !Array.isArray(res.devices) || !res.devices.length) return res && res.message ? res.message : '';
  const lines = [];
  if (res.devices.length > 1) lines.push(`I found ${res.devices.length} matching devices:`);
  for (const d of res.devices) {
    const state = String(d.connection || 'unknown').split(' (')[0];
    const where = d.whereInApp ? ` (${d.whereInApp})` : '';
    const band = d.wifi ? `, on ${d.wifi.band} Wi-Fi` : '';
    lines.push(`${res.devices.length > 1 ? '- ' : ''}**${d.name}** is on **${d.router}**${where}: **${state}**${band}. Last seen ${d.lastSeen}.`);
    if (state !== 'online' && Array.isArray(d.howToConnect) && d.howToConnect.length) {
      lines.push(...d.howToConnect.map((h) => `${res.devices.length > 1 ? '  ' : ''}- ${h}`));
    }
  }
  return lines.join('\n');
}

class Assistant {
  constructor({ settingsFile, tools }) {
    this.settingsFile = settingsFile; // ai.json: what the user picked in Ask AI › AI settings
    this.tools = tools; // [{ name, description, parameters, action?: true, run(args, ctx) }]
  }

  readSettings() {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return { provider: s.provider, keys: s.keys || {}, models: s.models || {} };
    } catch { return { provider: null, keys: {}, models: {} }; }
  }

  // Only what the user saved in Ask AI › AI settings counts: no default service, model or key.
  config(provider) {
    const s = this.readSettings();
    const id = PROVIDERS[provider] ? provider : PROVIDERS[s.provider] ? s.provider : null;
    return {
      provider: id, label: id ? PROVIDERS[id].label : null,
      key: (id && s.keys[id]) || '', model: (id && s.models[id]) || '', s
    };
  }

  // What the page may see: never a key, only its last 4 characters.
  status() {
    const cfg = this.config();
    return {
      configured: !!(cfg.provider && cfg.key && cfg.model), provider: cfg.provider, providerLabel: cfg.label, model: cfg.model,
      providers: Object.entries(PROVIDERS).map(([id, p]) => {
        const key = cfg.s.keys[id] || '';
        return { id, label: p.label, example: p.example, keyUrl: p.keyUrl, model: cfg.s.models[id] || '', hasKey: !!key, keyHint: key ? key.slice(-4) : '' };
      })
    };
  }

  // Saves the provider, model and (optionally) a new key, after a quick test call with them.
  async saveSettings(input) {
    const id = String((input && input.provider) || '');
    const p = PROVIDERS[id];
    if (!p) throw new Error('Choose NVIDIA, OpenAI or Anthropic.');
    const model = String(input.model || '').trim().slice(0, 120);
    if (!model) throw new Error(`Enter the ${p.label} model to use (for example ${p.example}).`);
    const newKey = String(input.key || '').trim();
    if (/\s/.test(newKey) || newKey.length > 400) throw new Error("That doesn't look like an API key.");
    const cur = this.config(id);
    const key = newKey || cur.key;
    if (!key) throw new Error(`Enter your ${p.label} API key.`);
    await this.callModel([{ role: 'user', content: 'Reply with the word OK.' }], { provider: id, label: p.label, key, model }, { test: true });

    const s = cur.s;
    s.provider = id;
    if (newKey) s.keys[id] = newKey;
    s.models[id] = model;
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    const tmp = this.settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ provider: s.provider, keys: s.keys, models: s.models }, null, 2), 'utf8');
    fs.renameSync(tmp, this.settingsFile);
    return this.status();
  }

  // Sends one request. opts.test: no tools and a tiny answer (used to check a key and model).
  async callModel(messages, cfg, opts = {}) {
    const p = PROVIDERS[cfg.provider];
    let headers;
    let body;
    if (p.style === 'anthropic') {
      const { system, messages: msgs } = toAnthropic(messages);
      headers = { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
      body = { model: cfg.model, max_tokens: opts.test ? 16 : 1500, messages: msgs };
      if (system) body.system = system;
      if (!opts.test) {
        body.tools = this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        body.tool_choice = { type: 'auto' };
      }
    } else {
      headers = { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' };
      body = { model: cfg.model, messages };
      if (!opts.test) {
        body.tools = this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        body.tool_choice = 'auto';
      }
      // OpenAI's newer (reasoning) models only take max_completion_tokens and the default temperature.
      if (cfg.provider === 'openai') body.max_completion_tokens = opts.test ? 64 : 4000;
      else Object.assign(body, { temperature: 0.2, max_tokens: opts.test ? 16 : 1200 });
    }
    const res = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90 * 1000) });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || j.detail || j.title || msg; } catch { /* keep text */ }
      if (res.status === 401 || res.status === 403) throw new Error(`The ${p.label} key was refused. Check it under Ask AI › AI settings.`);
      if (res.status === 429) throw new Error(`${p.label} is busy or the key has hit its limit. Try again in a minute.`);
      if (res.status === 404) throw new Error(`${p.label} doesn't know the model "${cfg.model}". Check the model name under Ask AI › AI settings. (${msg})`);
      throw new Error(`${p.label} answered ${res.status}: ${msg}`);
    }
    const j = JSON.parse(text);
    if (p.style === 'anthropic') return fromAnthropic(j);
    return j.choices && j.choices[0] && j.choices[0].message;
  }

  // Tidies the model's final text: drops hidden reasoning, turns show_in_app(...) written as text into a
  // real "Open" button, and removes any other tool-call syntax the model printed instead of calling.
  async cleanReply(text, ctx) {
    let out = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const names = this.tools.map((t) => t.name).join('|');
    const re = new RegExp(`\`?\\b(${names})\\s*\\(([^)]*)\\)\`?`, 'g');
    const found = [...out.matchAll(re)];
    for (const m of found) {
      if (m[1] === 'show_in_app') {
        const args = {};
        for (const a of m[2].matchAll(/(\w+)\s*=\s*["']([^"']*)["']/g)) args[a[1]] = a[2];
        const tool = this.tools.find((t) => t.name === 'show_in_app');
        try { if (args.router_id && args.section) await tool.run(args, ctx); } catch { /* bad ids: just drop it */ }
      }
    }
    out = out.replace(re, '');
    // "[Open 4G router › Connections]" written as text: make it a real button and drop the line.
    const showTool = this.tools.find((t) => t.name === 'show_in_app');
    const SECTION_WORDS = { connections: 'connections', devices: 'connections', data: 'data', calls: 'calls', sms: 'sms', texts: 'sms', info: 'info', information: 'info', settings: 'info', 'ask ai': 'ai' };
    const fake = /^\s*(?:[-*•]\s*)?\[?\s*Open\s+(.+?)\s*[›>]\s*([A-Za-z ]+?)\s*\]?\s*\.?\s*$/i;
    const kept = [];
    for (const line of out.split('\n')) {
      const m = fake.exec(line);
      const router = m && (ctx.routers || []).find((r) => r.name.toLowerCase() === m[1].trim().toLowerCase());
      const section = m && SECTION_WORDS[m[2].trim().toLowerCase()];
      if (router && section && showTool) {
        try { await showTool.run({ router_id: router.id, section }, ctx); continue; } catch { /* keep the line */ }
      }
      kept.push(line);
    }
    out = kept.join('\n');
    // Sentences emptied by the removal ("I also ran .") are dropped.
    out = out.replace(/[^.!?\n]*\b(ran|called|run|use|using|with|via|calling)\s*([.!?])/gi, (s) => (/\s[.!?]$/.test(s) || /\b(ran|called|run|use|using|with|via|calling)[.!?]$/i.test(s.trim()) ? '' : s));
    // Lines left dangling by the removal ("...in the app using:") are cut.
    out = out.split('\n').map((l) => l.replace(/\s+(using|with|via|by calling)\s*:?\s*$/i, '').replace(/[:,]\s*$/, (s) => (/^\s*[-*•]/.test(l) ? '' : s)))
      .filter((l) => !/^\s*[-*•]?\s*$/.test(l) || l === '').join('\n');
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  // history: [{ role: 'user' | 'assistant', content }]; context: { router, section }
  async chat(history, context) {
    const cfg = this.config();
    if (!cfg.provider || !cfg.key || !cfg.model) throw new Error('Ask AI isn\'t set up yet. Open AI settings at the top of this chat to choose a service, model and key.');

    const list = (context.routers || []).map((r) => `- id "${r.id}": ${r.name} (${r.kind}, ${r.model}, ${r.host})`).join('\n');
    const ctxLine = `Saved routers (use these exact ids in tool calls):\n${list || '- none'}\n` +
      `THIS CHAT IS ABOUT ONE ROUTER: "${context.routerName || context.router || '-'}" (id "${context.router || '-'}"). It is the Ask AI tab under that router; each router has its own separate chat. ` +
      `Answer about this router by default: its status, its devices (Connections), and its sections. Use its id in tool calls. ` +
      `Only bring in other routers when the user asks about them, or when it really matters (e.g. the device they ask about lives on another router, or this router has no internet and another one does); then say clearly which router you mean. ` +
      `If a tool says a router id wasn't found, call list_routers and retry with the right id. ` +
      `Time now: ${new Date().toString()}.`;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + ctxLine },
      ...history.slice(-MAX_HISTORY).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    ];

    const actions = [];
    const used = [];
    const results = {}; // last result of each tool, for a fallback answer
    const ctx = {
      ...context,
      propose: (a) => {
        // The same "Open" button twice is one button.
        const dup = a.type === 'navigate' && actions.find((x) => x.type === 'navigate' && x.summary === a.summary);
        if (dup) return dup;
        a.id = 'a' + Date.now().toString(36) + actions.length;
        actions.push(a);
        return a;
      }
    };

    let nudged = false;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const msg = await this.callModel(messages, cfg);
      if (!msg) throw new Error('The AI service sent an empty answer.');
      const calls = msg.tool_calls || [];
      // Small models sometimes announce checks ("Running diagnostics…") without calling a tool. Nudge once.
      if (!calls.length && !used.length && !nudged && round < MAX_TOOL_ROUNDS &&
          /\b(I will|I'll|let me|I am going to|running|checking|I need to)\b/i.test(String(msg.content || ''))) {
        nudged = true;
        messages.push({ role: 'assistant', content: msg.content || '' });
        messages.push({ role: 'user', content: 'Go ahead: call the tools now, then give me the answer.' });
        continue;
      }
      if (!calls.length || round === MAX_TOOL_ROUNDS) {
        let reply = await this.cleanReply(String(msg.content || ''), ctx);
        // Used tools but said nothing: ask once for the answer in words.
        if (!reply && used.length && !nudged && round < MAX_TOOL_ROUNDS) {
          nudged = true;
          messages.push({ role: 'assistant', content: msg.content || '' });
          messages.push({ role: 'user', content: 'Now answer my question in plain words, using what you found.' });
          continue;
        }
        if (!reply && results.find_device) reply = describeFound(results.find_device);
        if (!reply) {
          const real = actions.filter((a) => a.type !== 'navigate');
          reply = real.length ? 'I\'ve put the action below for you to approve.'
            : actions.length ? 'Here\'s where to find it in the app:' : 'Sorry, I couldn\'t work out an answer. Try asking another way.';
        }
        return { reply, actions, tools: [...new Set(used)] };
      }
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) {
        const tool = this.tools.find((t) => t.name === call.function.name);
        let result;
        if (!tool) {
          result = { error: `Unknown tool ${call.function.name}.` };
        } else {
          used.push(tool.name);
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            result = await tool.run(args, ctx);
          } catch (e) {
            result = { error: e.message };
          }
          results[tool.name] = result;
        }
        let content = JSON.stringify(result === undefined ? { ok: true } : result);
        if (content.length > MAX_TOOL_RESULT) content = content.slice(0, MAX_TOOL_RESULT) + '…(cut short)';
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    return { reply: 'I ran out of steps for this question.', actions, tools: [...new Set(used)] };
  }
}

module.exports = { Assistant, PROVIDERS, toAnthropic, fromAnthropic };
