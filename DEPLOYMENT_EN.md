# Deployment Guide

[简体中文](./DEPLOYMENT.md) | [English](./DEPLOYMENT_EN.md)

API-AegisLens is a **local-first** tool: the service listens on `127.0.0.1` only, and the data directory is fully separated from the code repository. This guide covers day-to-day startup, auto-start on boot, remote access, reverse proxying, backup, and upgrades.

## Contents

- [Requirements](#requirements)
- [Starting the Service](#starting-the-service)
- [Configuration](#configuration)
- [Auto-start on Boot](#auto-start-on-boot)
- [Remote Access](#remote-access)
- [Reverse Proxy (Use with Caution)](#reverse-proxy-use-with-caution)
- [Data Backup and Migration](#data-backup-and-migration)
- [Upgrading](#upgrading)
- [FAQ](#faq)

## Requirements

| Item | Requirement |
|---|---|
| Node.js | >= 18 for the JSON backend, **>= 22 for SQLite** (`node:sqlite` ships from Node 22); 22 LTS or newer recommended, check with `node -v` |
| OS | Windows / macOS / Linux |
| Dependencies | None — no `npm install`, pure standard library |
| Network | Reaching overseas endpoints (Anthropic, relay stations, etc.) may require a proxy, see [Configuration](#configuration) |

## Starting the Service

**Windows**: double-click `app/start.bat` (starts the service and opens the browser), or:

```powershell
cd app
npm start
```

**macOS / Linux**:

```bash
cd app
node server.js
```

You should see `API-AegisLens 已启动` and `浏览器访问: http://127.0.0.1:37700`.

## Configuration

Three environment variables, set as needed:

| Variable | Default | Description |
|---|---|---|
| `AKM_PORT` | `37700` | Listening port (binds 127.0.0.1 only, never exposed) |
| `AKM_DATA_DIR` | `~/.api-aegislens` | Data directory: encrypted store (`store.json` or `keys.db`) + master key `master.key` |
| `AKM_PROXY` | auto-detect | Proxy for outbound requests, see below |

**Proxy notes**: outbound requests (key testing, model fetching, balance queries) resolve the proxy in this order:

1. `AKM_PROXY` (`off` forces direct connection, or pin e.g. `http://127.0.0.1:7897`)
2. `HTTPS_PROXY` / `HTTP_PROXY` environment variables
3. The Windows system proxy (registry-based; picked up automatically when Clash / v2rayN enable system proxy)
4. Direct connection if none of the above

Example (pinning a proxy in a Linux systemd unit):

```ini
Environment=AKM_PROXY=http://127.0.0.1:7897
```

Note: Node's fetch ignores the system proxy (`NODE_USE_ENV_PROXY` requires Node 24+); the proxy detection built into this project works on Node 18+.

## Auto-start on Boot

### Windows (Task Scheduler)

Run headless in the background:

```powershell
# Adjust node.exe and project paths to your setup
schtasks /Create /TN "API-AegisLens" /SC ONLOGON /RL LIMITED `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"D:\ai\api-aegislens\app\server.js\""
```

Manage it with `schtasks /Run /TN "API-AegisLens"` to start and `schtasks /Delete /TN "API-AegisLens"` to remove. You can also configure "At log on" triggers in the Task Scheduler GUI.

### macOS (launchd)

Create `~/Library/LaunchAgents/com.oldgao.api-aegislens.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.oldgao.api-aegislens</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/api-aegislens/app/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Activate it:

```bash
launchctl load ~/Library/LaunchAgents/com.oldgao.api-aegislens.plist
```

(Confirm the `node` path with `which node`; on Apple Silicon it is usually `/opt/homebrew/bin/node`.)

### Linux (systemd user service)

Create `~/.config/systemd/user/api-aegislens.service`:

```ini
[Unit]
Description=API-AegisLens (local-first API key manager)

[Service]
ExecStart=/usr/bin/node /opt/api-aegislens/app/server.js
Restart=on-failure
# Uncomment and adjust if a proxy is needed
# Environment=AKM_PROXY=http://127.0.0.1:7897

[Install]
WantedBy=default.target
```

Activate it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now api-aegislens

# Optional: start at boot even before login
loginctl enable-linger $USER
```

## Remote Access

The service intentionally binds to the loopback interface only. The recommended way to reach it from another machine is an **SSH tunnel** (encrypted, zero attack surface):

```bash
# Run on your laptop; maps the remote service to local port 37700
ssh -N -L 37700:127.0.0.1:37700 user@your-server
```

Then open <http://127.0.0.1:37700> in the browser.

## Reverse Proxy (Use with Caution)

This app has **no authentication whatsoever** — by design, it only runs on your own computer. The moment you expose it via nginx or similar to a LAN or the public internet, anyone who can reach that address can read all your keys in plaintext. Only do this on a fully trusted home network, and always add Basic Auth:

```nginx
server {
    listen 8080;

    # Authentication is mandatory
    auth_basic "API-AegisLens";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:37700;
        proxy_set_header Host $host;   # The app checks Origin against Host; must be forwarded
    }
}
```

## Data Backup and Migration

All data lives in the data directory (default `~/.api-aegislens`):

```
~/.api-aegislens/
├── master.key    # Master key (if lost, data can no longer be decrypted — back it up!)
└── store.json    # or keys.db — the AES-256-GCM encrypted key vault
```

**Backup**: stop the service, then copy the entire directory to a safe location (encrypted drive / USB stick).

**Migrating to a new machine**: `git clone` the project on the new machine and start it once (this creates the directory structure) → stop the service → overwrite with the entire data directory from the old machine → start again.

**Full reset**: stop the service and delete the entire data directory (all stored keys are wiped and unrecoverable).

## Upgrading

```bash
cd api-aegislens
git pull
npm test        # optional: run the 85-test suite to verify the environment
# Restart the service (the restart command for your auto-start method, or npm start again)
```

The data directory is fully separate from the repository; upgrades never touch recorded keys.

## FAQ

**Port already in use (EADDRINUSE)**
Start on another port: `AKM_PORT=38000 node server.js` (Windows PowerShell: `$env:AKM_PORT=38000; node server.js`).

**Testing an overseas endpoint fails with "网络请求失败：fetch failed" or a timeout**
The target site is unreachable by direct connection and needs a proxy. Make sure your proxy app is running with system proxy enabled, or set `AKM_PROXY` explicitly. When the proxy app is down, the service reports "无法连接代理 … 请确认代理软件正在运行" (cannot connect to proxy; make sure it is running).

**Relay station returns 401 unauthorized client detected**
The relay performs client fingerprinting; this app already sends a coding-tool User-Agent. If it is still rejected, the site may whitelist only specific tools — contact the relay operator.

**Testing returns 404 "接口不存在" (endpoint not found)**
That endpoint does not implement the `/models` list API (e.g. Volcano Ark Agent Plan). Testing automatically falls back to an auth probe against the chat endpoint; model fetching returns the built-in official catalog for Agent Plan, and for other endpoints you can add models manually.

**Forgot where the data lives**
Default is `~/.api-aegislens` (on Windows: `C:\Users\<you>\.api-aegislens`), or wherever `AKM_DATA_DIR` points. The startup log prints the data directory.

**Node version too old**
Verify with `node -v` that it is >= 18. Managing Node versions with nvm / nvm-windows is recommended.
