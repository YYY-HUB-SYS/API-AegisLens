# Deployment Guide

[简体中文](./DEPLOYMENT.md) | [English](./DEPLOYMENT_EN.md)

API-AegisLens is a **local-first** tool: by default it binds to `127.0.0.1` only, and the data directory is fully separated from the code repository. Reaching it from other devices means explicitly widening the bind address, and before you can do that the vault must already have an unlock passphrase — the service enforces that invariant itself at boot instead of relying on a warning in this document. This guide covers day-to-day startup, running in the background, auto-start on boot, LAN and remote access, reverse proxying, backup, and upgrades.

## Contents

- [Requirements](#requirements)
- [Starting the Service](#starting-the-service)
- [Running in the Background](#running-in-the-background)
- [Configuration](#configuration)
- [Auto-start on Boot](#auto-start-on-boot)
- [LAN and Remote Access](#lan-and-remote-access)
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

**Windows**: double-click `app/start.bat` — it starts the service in the background and opens the browser; closing the window that appears does **not** stop the service. To stop it, double-click `app/stop.bat`. From the command line, in the foreground:

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

## Running in the Background

A foreground process dies with its terminal — on Windows that means closing the console window that `start.bat` used to open. Use `--daemon` when you want the service to outlive the shell:

```powershell
cd app
node server.js --daemon    # spawns a detached instance, prints its pid, parent exits
node server.js --stop      # stops that instance
```

`--daemon` records the pid and port in `server.pid` inside the data directory. `--stop` only acts when the recorded pid is **alive and listening on the matching port**, so when it cannot find an instance it just reports "not running" rather than killing some other node process. Starting a second `--daemon` while one is live fails immediately and tells you to `--stop` first — two instances never share one data directory.

This sequence was run end to end in an isolated data directory on a non-default port: `--daemon` returned a pid → `/api/meta` answered 200 → a second `--daemon` reported "already running (pid …)" and exited 1 → `--stop` reported the stop, after which no socket was listening and `server.pid` was gone. `app/start.bat` and `app/stop.bat` are the double-click wrappers around those two commands. `app/workbench.bat` deliberately stays in the foreground for external supervisors that capture the log.

## Configuration

Every environment variable is optional:

> Why the prefix is `AKM_` rather than the project's current name: it comes from the pre-rename name
> (the upstream repository was `ai-key-manager`, see [Licence and credits](./README_EN.md#-license-and-credits)),
> and `AKM_PORT` has been in use since the first runnable version, `c809121`. The rename never touched the
> environment variables — so there is no `AEGIS_` prefix; don't derive one from the product name.

| Variable | Default | Description |
|---|---|---|
| `AKM_PORT` | `37700` | Listening port |
| `AKM_BIND` | `127.0.0.1` | Bind address. Loopback by default; a LAN address (e.g. `192.168.1.20`) or `0.0.0.0` makes it reachable from other devices — **and requires an unlock passphrase first**, see [LAN and Remote Access](#lan-and-remote-access) |
| `AKM_DATA_DIR` | `~/.api-aegislens` | Data directory: encrypted store (`store.json` or `keys.db`) + `master.key` + `vault.key` / `recovery.env` once a passphrase is set |
| `AKM_PASSPHRASE` | unset | Unlocks the vault at boot. **Use it only when you truly have no choice**: writing it into a scheduled task or systemd unit leaves the passphrase in plaintext on disk. The unlock gate in the UI is the normal path. A wrong value makes a non-interactive start fail outright instead of pretending to be healthy-but-locked |
| `AKM_IDLE_LOCK_MINUTES` | `5` | How many minutes of inactivity (decimals allowed) before the unlocked vault locks itself. Empty, `0` or a non-number means the variable is ignored and the 5-minute default applies. "Inactivity" counts requests that actually touched vault data — key board reads/writes, credential reveals and token issuance all extend the clock; page polling such as the platform table, `/api/meta` and `/api/vault/status` deliberately does **not**, otherwise an open tab would keep it unlocked forever. Passphrase-less installs have no lock to set, so it does nothing there |
| `AKM_SCHEDULE_ENABLED` | off | `1` / `true` / `on` enables scheduled probing; every interval then sends real requests to all your endpoints |
| `AKM_SCHEDULE_INTERVAL_MINUTES` | `60` | Interval for scheduled probing, in minutes (clamped to the supported range) |
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
  /TR "\"C:\Program Files\nodejs\node.exe\" \"D:\ai\api-aegislens\app\server.js\" --daemon"
```

With `--daemon` the task process prints its pid and exits while the service keeps running as a detached instance (verified: the child outlives the parent, and `daemon.test.js` has a case dedicated to it). Without `AKM_PASSPHRASE`, the service that comes up at logon is **locked** — opening it in a browser asks for the passphrase first, which is exactly what you want once one has been set.

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

Both launchd (macOS) and systemd (Linux) want a **foreground** process, so do not put `--daemon` in `ProgramArguments` / `ExecStart`: the supervisor sees the parent exit, concludes the service died, and relaunches it — and the second `--daemon` only reports "already running" and exits 1. You end up with a fake service crash-looping under the supervisor while the real instance runs outside its control. `--daemon` is for the "start and walk away" case, i.e. the Windows scheduled task above.

## LAN and Remote Access

On the machine that runs the service, <http://127.0.0.1:37700> in a local browser is all you need. To reach it from other devices, pick a path by how long you intend to stay connected.

### 1. Just looking in for a while: SSH tunnel (recommended)

The service keeps listening on loopback and no port opens to the network — zero attack surface:

```bash
# Run on the laptop / phone; maps the remote service onto this device's own 37700
ssh -N -L 37700:127.0.0.1:37700 user@the-machine-running-the-service
```

Then browse to <http://127.0.0.1:37700> on that device. Windows 10 and later ship an OpenSSH client, so this works straight from PowerShell; on phones use an SSH client that supports local port forwarding (Termius, Blink). The cost is that the tunnel has to be up first, and the SSH server must be reachable.

### 2. Several devices, permanently: WireGuard (or Tailscale)

If your phone, tablet and laptops all need to get in whenever they like, give each device a WireGuard peer and keep your own private mesh: traffic never leaves as plain HTTP on the LAN, and no router port forwarding is involved. Tailscale is the low-effort version of the same WireGuard protocol, at the cost of depending on a third-party coordination service.

### 3. Convenience: widen the bind address — passphrase first, no exceptions

```powershell
# PowerShell; on macOS / Linux: export AKM_BIND=192.168.1.20
$env:AKM_BIND = "192.168.1.20"    # this machine's address on the LAN
node server.js
```

On this path the service checks whether the data directory has an unlock passphrase, and refuses to boot if it doesn't. The block below is the actual output, with exit code 1:

```
拒绝启动：监听地址 192.168.1.99 不是回环，而数据目录还没有解锁口令。
先在界面上给保险库设一个解锁口令（或启动时给 AKM_PASSPHRASE），再放开局域网监听。
```

The passphrase is the only thing standing on this path, so both what it buys and what it doesn't:

- While locked, the key and credential endpoints answer `423` and a device on the same segment gets nothing.
- Once unlocked, lists carry masked values only; a full key requires clicking "显示明文" per row, which calls `POST /api/keys/:id/reveal` — one item at a time, rate limited, and written to an audit ring that records the action, never the secret. The session re-locks after 5 minutes of idle.
- **Inside an unlocked session this is a gate, not an encryption boundary**: anyone who can drive your already-unlocked page can reveal keys one by one. Keep `AKM_BIND` pointed at your own machine's LAN address rather than `0.0.0.0`, and do not use this path on shared machines, guest networks, or café Wi-Fi.

### Why not a container

Exposing a container to the LAN forces the bind address to `0.0.0.0`, and the passphrase then has to sit in plaintext in a `docker-compose.yml` environment block permanently — that trades one gate for a looser one. This project needs no build step and no service orchestration, so a container here only adds attack surface without solving a problem.

## Reverse Proxy (Use with Caution)

A passphrase-free installation has **no authentication at all**: an unauthenticated GET returns masked metadata, but `reveal` hands out plaintext one item at a time. Setting a passphrase improves this (locked state returns `423`, unlocking requires the passphrase, writes are Origin-checked), yet **the app still has no account system** — one unlock is valid for the whole session. If you expose it through nginx / Caddy to a LAN or the public internet, add Basic Auth at the proxy:

```nginx
server {
    listen 8080;

    # Authentication is mandatory
    auth_basic "API-AegisLens";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:37700;
        proxy_set_header Host $host;   # write requests compare Origin with Host; rewriting Host makes them all 403
    }
}
```

(Verified live: a write request carrying a foreign `Origin` gets 403 "拒绝跨域写请求"; GET is not covered by this check, and a request with no `Origin` header at all — curl, or a browser whose `Host` was rewritten by the proxy — passes it. So this guard is against CSRF, not against intruders.)

## Data Backup and Migration

All data lives in the data directory (default `~/.api-aegislens`):

```
~/.api-aegislens/
├── keys.db          # or store.json — the AES-256-GCM encrypted key + credential store
├── master.key       # The DEK; on a passphrase-free install this is the only thing that opens the data
├── vault.key        # Only after a passphrase is set: the DEK wrapped by a KEK derived from it
├── recovery.env     # The recovery-code envelope, generated once when you set the passphrase
└── server.pid       # Sentinel file written by --daemon; removed on a clean stop
```

**Backup**: stop the service, then copy the entire directory to a safe location (encrypted drive / USB stick). The backup must be a **pair** — the store without something that can unlock it is useless, and treat the backup itself as plaintext-equivalent to your API keys.

`master.key` and `vault.key` are not alternatives: setting a passphrase merely **adds a layer**, and `master.key` stays on disk untouched until you explicitly run "plaintext key → discard" in the credential vault (that operation unlocks once with the passphrase to prove it works before deleting; the entry never appears while no passphrase is set). After discarding it, the only things that can open the store are the passphrase or the recovery code plus `recovery.env` — so `vault.key` and `recovery.env` must be in your backup too.

**Restored and verified**: on 2026-10-07 this procedure was drilled in a temporary data directory (create key → stop → copy whole directory → delete the original → copy back → restart): the key decrypted to the identical value, and manually added models plus assigned tool entries survived. With the SQLite backend no `-wal`/`-shm` side files remain, so a whole-directory copy taken while stopped is a consistent snapshot.

**Missing `master.key` now refuses to start**: earlier builds silently generated a fresh master key in that situation — the service started normally, surfaced only a read error, and left the old vault permanently undecryptable. Startup now aborts with "the data directory already contains a key vault but master.key is missing"; restore `master.key` from a backup, or use the recovery-code entry in the UI if you mean to reset the vault.

**Forgotten passphrase**: type the 52-character recovery code you copied when setting the passphrase into the "用恢复码重置" entry on the unlock gate. The service rebuilds a decryptable session in place — no restart, no re-entering keys. If you never wrote the recovery code down *and* `master.key` has been discarded, the vault is unrecoverable; that is the price of this design, not a defect in it.

**Migrating to a new machine**: `git clone` the project on the new machine and start it once (this creates the directory structure) → stop the service → overwrite with the entire data directory from the old machine → start again.

**Full reset**: stop the service and delete the entire data directory (all stored keys are wiped and unrecoverable).

## Upgrading

```bash
cd API-AegisLens        # the clone lands in a directory named after the repository
git pull
cd app && npm test      # optional: run the whole suite to verify the environment (count whatever the command reports, not a number copied from docs)
# Restart the service (the restart command for your auto-start method, or run npm start again from app/)
```

`package.json` lives in `app/`, not at the repository root — both `npm test` and `npm start` need
`cd app` first, otherwise you just get `ENOENT: no such file or directory, open '...\package.json'`.

The data directory is fully separate from the repository; upgrades never touch recorded keys.

### Rolling back to an older version

A rollback is just checking out an older tag/commit and restarting — the data directory stays where it is.
Three things to confirm first:

- **Do not roll back after discarding `master.key`.** Older builds only understand `master.key` and have no idea
  `vault.key` exists. What happens depends on how old:
  - Rolling back to a build **after** `c08bde3`: startup is refused with "the data directory already contains a key
    vault but master.key is missing". That is failing safely.
  - Rolling back to anything **older** (including the original upstream release): it **silently generates a fresh
    `master.key`**, the service starts normally, the UI opens — and the old vault becomes permanently
    undecryptable, surfacing only as a read error. That is far worse than an abort.
  If you really must go back, restore `master.key` from the pre-upgrade whole-directory backup first. With no such
  backup, stay on the current version.
- **New tables are invisible to older builds, not corrupted by them.** The `credentials`, `tokens` and `pools`
  tables are simply never queried, and unknown fields in the JSON store are read and written back verbatim — a
  rollback hides features, it does not damage data. Upgrading again brings them back.
- **Take a whole-directory backup before rolling back** (the same `cp -a` command as above), so both the rollback
  and the next upgrade have a way out.

## FAQ

**The page asks for a passphrase and the API answers 423**
That install has an unlock passphrase set and the session is currently locked — type the passphrase. Forgotten it? Use "用恢复码重置" on the unlock gate with the 52-character recovery code you copied when setting it. While locked, the key list, credentials and pools endpoints all return `423` (`boot-lock.test.js` pins each one), while the page itself, the platform catalog and `/api/vault/*` stay reachable — so the UI never degrades into a blank screen you cannot act on. A session re-locks after 5 minutes idle.

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
