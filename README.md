# Home Network Monitor

A small Windows app that shows the devices on your home network and keeps an eye on your routers: SIM data balance, SMS, Wi-Fi bands and fibre line status. It also has an optional "Ask AI" chat that answers questions using live readings from your routers.

Everything runs on your own PC. A local Node.js server serves the dashboard at `http://localhost:8765/` (bound to `127.0.0.1` only), and a small launcher opens it in its own Edge app window. There are no npm dependencies and no Electron.

## Features

- **Device scan**: pings the local subnet and reads the ARP table to list everything connected, including devices that ignore ping. Auto-scans every minute while the window is open.
- **Router support**: detects routers on the network without logging in, then lets you add them with their admin login.
  - ZLT 4G router (MTN TurboNet): data balance, SMS inbox and sending, connected clients, 2.4/5 GHz Wi-Fi settings.
  - Huawei HG8145X6-10 fibre ONT: GPON registration state and line health. The app can briefly switch this PC's Wi-Fi to the fibre network to read it, then switch back.
  - Huawei HiLink, ZTE and other routers are recognised and shown with basic information only.
- **This PC's Wi-Fi**: shows which band the PC is on and can move it between a router's 2.4 GHz and 5 GHz networks.
- **Ask AI** (optional): a chat assistant using NVIDIA, OpenAI or Anthropic with tool calls. Read-only tools run straight away; anything that changes something (switching bands, sending SMS, device actions) appears as a card you must approve first.

## Requirements

- Windows 10 or 11
- Node.js 22 (only when running from source; the installer bundles its own `node.exe`)

## Running from source

```powershell
npm start
```

Then open http://localhost:8765/, or run `Home Network Monitor.exe` in the project folder, which starts the server if needed and opens the dashboard window. The server shuts itself down about 10 minutes after the dashboard was last open.

### Enabling Ask AI

The app ships with no AI service, model or key. Open **Ask AI** under any router: the first time, it asks you to choose a service (NVIDIA, OpenAI or Anthropic), type a model and paste your own API key. The app sends a short test request before saving. To change any of these later, click **AI settings** at the top of the chat. Settings are saved in `%APPDATA%\Home Network Monitor\ai.json`, one key per service, so switching services doesn't lose the other keys.

| Service | Get a key | Example model |
|---|---|---|
| NVIDIA | [build.nvidia.com](https://build.nvidia.com) | `nvidia/nemotron-3.5-bolt-e4b` |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-5-mini` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `claude-sonnet-5-5` |

## Building the installer

Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`) and an internet connection the first time.

```powershell
npm run dist
```

This runs [installer/build.ps1](installer/build.ps1), which:

1. Copies the app files into `build/stage`.
2. Downloads a portable `node.exe` (v22.17.0) and checks it against nodejs.org's SHA-256.
3. Compiles the launcher ([launcher/Launcher.cs](launcher/Launcher.cs)) with the C# compiler that ships with Windows.
4. Builds the installer with Inno Setup.

Output: `dist/HomeNetworkMonitor-Setup-<version>.exe`. The version comes from [package.json](package.json).

## Where data is stored

Router logins, scan history, settings and a short log (`server.log`) live in `%APPDATA%\Home Network Monitor`. This folder is kept on uninstall, so a reinstall picks up where you left off.

## Project layout

| File | Purpose |
| --- | --- |
| [server.js](server.js) | Local HTTP server: static files, `/api/*` endpoints, idle shutdown |
| [scan.ps1](scan.ps1) | Network scan, prints JSON for the server |
| [routers.js](routers.js) | Known routers, drivers and login-free detection |
| [router.js](router.js) | Client for the ZLT 4G router's admin API |
| [fibre.js](fibre.js) | Client for the Huawei fibre ONT, plus Wi-Fi switching helpers |
| [pcwifi.js](pcwifi.js) | This PC's Wi-Fi band and network switching |
| [ai.js](ai.js), [ai-tools.js](ai-tools.js) | Ask AI assistant and its tools |
| [index.html](index.html), [renderer.js](renderer.js), [styles.css](styles.css), [theme.js](theme.js) | Dashboard UI |
| [web-bridge.js](web-bridge.js) | The page's API to the local server (`window.netmon`) |
| [launcher/](launcher/) | Source for `Home Network Monitor.exe` |
| [installer/](installer/) | Build script, Inno Setup script and wizard images |

## Security notes

- The server listens on `127.0.0.1` only and rejects requests whose `Host` header isn't `localhost:8765` or `127.0.0.1:8765`.
- The AI API key stays in the local server and is never sent to the page (the page only sees its last 4 characters).
- Windows may show an "unknown publisher" warning on first run because the installer isn't code-signed.

## Author

George Junior Boadu
