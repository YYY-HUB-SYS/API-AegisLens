# 部署指南

[简体中文](./DEPLOYMENT.md) | [English](./DEPLOYMENT_EN.md)

API-AegisLens 是**本地优先**工具：服务只监听 `127.0.0.1`，数据目录独立于代码仓库。本指南覆盖日常启动、开机自启、远程访问、反向代理、备份与升级。

## 目录

- [环境要求](#环境要求)
- [启动方式](#启动方式)
- [配置项](#配置项)
- [开机自启](#开机自启)
- [远程访问](#远程访问)
- [反向代理（谨慎）](#反向代理谨慎)
- [数据备份与迁移](#数据备份与迁移)
- [升级](#升级)
- [常见问题](#常见问题)

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | >= 18（JSON 后端）/ **>= 22（SQLite 后端，`node:sqlite` 自 22 起提供）**；推荐 22 LTS 及以上，`node -v` 检查 |
| 操作系统 | Windows / macOS / Linux 均可 |
| 依赖 | 无需 `npm install`，纯标准库实现 |
| 网络 | 访问境外端点（如 Anthropic、海外中转站）可能需要代理，见[配置项](#配置项) |

## 启动方式

**Windows**：双击 `app/start.bat`（启动服务并自动打开浏览器），或：

```powershell
cd app
npm start
```

**macOS / Linux**：

```bash
cd app
node server.js
```

看到 `API-AegisLens 已启动` 与 `浏览器访问: http://127.0.0.1:37700` 即成功。

## 配置项

三个环境变量，按需设置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AKM_PORT` | `37700` | 监听端口（仅绑定 127.0.0.1，不可对外） |
| `AKM_DATA_DIR` | `~/.api-aegislens` | 数据目录：加密存储（`store.json` 或 `keys.db`）+ 主密钥 `master.key` |
| `AKM_PROXY` | 自动检测 | 外发请求代理，见下文 |

**代理说明**：服务的外发请求（测试密钥、拉取模型、查余额）默认按以下优先级解析代理：

1. `AKM_PROXY`（设 `off` 强制直连，或显式指定如 `http://127.0.0.1:7897`）
2. `HTTPS_PROXY` / `HTTP_PROXY` 环境变量
3. Windows 系统代理（注册表，Clash / v2rayN 等开启系统代理时自动生效）
4. 都没有则直连

示例（Linux systemd 中指定代理）：

```ini
Environment=AKM_PROXY=http://127.0.0.1:7897
```

注意：Node 的 fetch 不读系统代理（`NODE_USE_ENV_PROXY` 需 Node 24+），本项目的代理检测在 Node 18+ 均可用。

## 开机自启

### Windows（任务计划程序）

以无窗口后台运行：

```powershell
# 按实际路径替换 node.exe 与项目目录
schtasks /Create /TN "API-AegisLens" /SC ONLOGON /RL LIMITED `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"D:\ai\api-aegislens\app\server.js\""
```

管理：`schtasks /Run /TN "API-AegisLens"` 启动，`schtasks /Delete /TN "API-AegisLens"` 移除。也可在「任务计划程序」图形界面中配置「登录时启动」。

### macOS（launchd）

创建 `~/Library/LaunchAgents/com.oldgao.api-aegislens.plist`：

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

生效：

```bash
launchctl load ~/Library/LaunchAgents/com.oldgao.api-aegislens.plist
```

（`node` 路径用 `which node` 确认，Apple Silicon 上通常是 `/opt/homebrew/bin/node`。）

### Linux（systemd 用户服务）

创建 `~/.config/systemd/user/api-aegislens.service`：

```ini
[Unit]
Description=API-AegisLens (local-first API key manager)

[Service]
ExecStart=/usr/bin/node /opt/api-aegislens/app/server.js
Restart=on-failure
# 需要代理时取消注释并修改地址
# Environment=AKM_PROXY=http://127.0.0.1:7897

[Install]
WantedBy=default.target
```

生效：

```bash
systemctl --user daemon-reload
systemctl --user enable --now api-aegislens

# 未登录也随开机启动（可选）
loginctl enable-linger $USER
```

## 远程访问

服务设计上只绑定本机回环地址，**推荐用 SSH 隧道**从另一台电脑访问（加密、零暴露面）：

```bash
# 在你的笔记本上执行，把远端服务映射到本地 37700
ssh -N -L 37700:127.0.0.1:37700 user@your-server
```

然后浏览器访问 <http://127.0.0.1:37700>。

## 反向代理（谨慎）

本应用**没有任何登录鉴权**——它被设计为只在你自己的电脑上运行。一旦用 nginx 等反代暴露到局域网/公网，任何能访问该地址的人都能看到你的全部密钥明文。仅建议在完全可信的家庭内网使用，且务必加上 Basic Auth：

```nginx
server {
    listen 8080;

    # 必须加一层认证
    auth_basic "API-AegisLens";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:37700;
        proxy_set_header Host $host;   # 应用校验 Origin 与 Host 一致，必须透传
    }
}
```

## 数据备份与迁移

所有数据都在数据目录（默认 `~/.api-aegislens`）：

```
~/.api-aegislens/
├── master.key    # 主密钥（丢失则数据无法解密，务必备份；它与数据文件同目录，整目录等同明文密钥）
└── store.json    # 或 keys.db —— AES-256-GCM 加密的密钥库
```

**备份**：停掉服务后，把整个目录复制到安全位置（加密盘/U 盘）。

**迁移到新机器**：新机器上 `git clone` 项目并启动一次（生成目录结构）→ 停止服务 → 用旧机器的整个数据目录覆盖 → 重新启动。

**彻底重置**：停止服务后删除整个数据目录（所有密钥记录将清空，无法恢复）。

## 升级

```bash
cd api-aegislens
git pull
npm test        # 可选：跑一遍 85 项测试确认环境正常
# 重启服务（自启方式对应的 restart 命令，或重新运行 npm start）
```

数据目录与代码仓库完全分离，升级不影响已录入的密钥。

## 常见问题

**端口被占用（EADDRINUSE）**
换端口启动：`AKM_PORT=38000 node server.js`（Windows PowerShell：`$env:AKM_PORT=38000; node server.js`）。

**境外端点测试报「网络请求失败：fetch failed」或超时**
目标站点直连不可达，需代理。确认代理软件运行中且系统代理开启，或显式指定 `AKM_PROXY`。代理软件没开时服务会报「无法连接代理 … 请确认代理软件正在运行」。

**中转站报 401 unauthorized client detected**
中转站做客户端指纹检测，本应用已自带编程工具 User-Agent。若仍被拒，可能是该站仅允许特定工具，需联系中转站方。

**测试报 404「接口不存在」**
该端点未提供 `/models` 列表接口（如火山方舟 Agent Plan）。测试会自动回退对话接口鉴权探测；拉模型对 Agent Plan 返回内置官方目录，其他端点请手动添加模型。

**忘了数据存在哪**
默认 `~/.api-aegislens`（Windows 即 `C:\Users\<你>\.api-aegislens`）；设置了 `AKM_DATA_DIR` 则在对应位置。服务启动日志会打印数据目录。

**Node 版本过低**
`node -v` 确认 >= 18。建议用 nvm / nvm-windows 管理 Node 版本。
