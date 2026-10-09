# 部署指南

[简体中文](./DEPLOYMENT.md) | [English](./DEPLOYMENT_EN.md)

API-AegisLens 是**本地优先**工具：默认只监听 `127.0.0.1`，数据目录独立于代码仓库。要让局域网里其他设备访问，得显式放开监听地址，而放开之前必须先给保险库设解锁口令——这条不变量由服务自己在启动时把关，不靠文档提醒。本指南覆盖日常启动、后台运行、开机自启、局域网与远程访问、反向代理、备份与升级。

## 目录

- [环境要求](#环境要求)
- [启动方式](#启动方式)
- [后台运行](#后台运行)
- [配置项](#配置项)
- [开机自启](#开机自启)
- [局域网与远程访问](#局域网与远程访问)
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

**Windows**：双击 `app/start.bat`（后台起服务并自动打开浏览器；弹出来的那个窗口关掉也不会把服务带走），要停就双击 `app/stop.bat`。命令行起前台实例：

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

## 后台运行

前台启动的进程挂在终端上：窗口一关（Windows 上那个 cmd 一叉）服务就没了。不想开窗口就用 `--daemon`：

```powershell
cd app
node server.js --daemon    # 派生一个脱离终端的实例，打印 pid 后父进程就退出
node server.js --stop      # 停掉后台实例
```

`--daemon` 把 pid 与端口写到数据目录的 `server.pid`；`--stop` 要求 **pid 进程还活着并且监听的端口对得上**才动手，所以它找不到实例时只会说「没有在运行」，不会去杀别的 node 进程。已经有一个实例在跑时再 `--daemon` 会直接报错退出，让你先 `--stop`——不存在两个实例抢同一份数据目录的情况。

上面这两条实测过（隔离数据目录 + 换端口跑完整回合）：`--daemon` 起实例返回 pid → `/api/meta` 200 → 再 `--daemon` 报「已有一个实例在跑（pid …）」退出码 1 → `--stop` 报「已停止」后端口无监听、`server.pid` 自清。`app/start.bat` / `app/stop.bat` 就是这条路径的双击版；`app/workbench.bat` 刻意保持前台，给外部托管进程用（日志由托管方收）。

## 配置项

环境变量都是可选的，按需设置：

> 前缀为什么是 `AKM_` 而不是项目现在的名字：它是更名前那个名字留下的（上游仓库叫
> `ai-key-manager`，见 [README 的许可与致谢](./README.md#-许可与致谢)），`AKM_PORT` 自首个可运行
> 版本 `c809121` 就在用。改名没有动环境变量——所以不存在 `AEGIS_` 前缀，别照着项目名去猜。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AKM_PORT` | `37700` | 监听端口 |
| `AKM_BIND` | `127.0.0.1` | 监听地址。默认只有本机能连；填局域网 IP（如 `192.168.1.20`）或 `0.0.0.0` 才对其他设备可达，而**放开的前提是已有解锁口令**，见[局域网与远程访问](#局域网与远程访问) |
| `AKM_DATA_DIR` | `~/.api-aegislens` | 数据目录：加密存储（`store.json` 或 `keys.db`）+ `master.key` + 设过口令后的 `vault.key` / `recovery.env` |
| `AKM_PASSPHRASE` | 未设 | 启动时用它自动解锁。**只在没得选的时候用**：它等于把口令写成明文放在计划任务/systemd 单元里，界面上的解锁门才是常规路径。口令不对时非交互环境（计划任务、systemd）直接启动失败退出，不会伪装成「已启动、只是锁着」 |
| `AKM_IDLE_LOCK_MINUTES` | `5` | 解锁之后无操作多久自动上锁（分钟，可写小数）。留空、写 0 或写不成数字都等于没设，落回 5 分钟。「无操作」指真正读写了保险库数据的请求：密钥看板的增删改查、凭证揭示、令牌签发都会续期；平台表、元数据、`/api/vault/status` 这类页面轮询**不**续期，否则标签页一直开着就永远不会锁。免口令安装没有锁可上，这个变量设了也不生效 |
| `AKM_SCHEDULE_ENABLED` | 关 | `1` / `true` / `on` 开启定时探测；开了以后每个间隔都会朝全部端点发真实请求 |
| `AKM_SCHEDULE_INTERVAL_MINUTES` | `60` | 定时探测间隔（分钟，超出上下限会被夹住） |
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
  /TR "\"C:\Program Files\nodejs\node.exe\" \"D:\ai\api-aegislens\app\server.js\" --daemon"
```

`--daemon` 让任务进程打印完 pid 就退出，服务作为一个独立实例继续跑（实测：子进程脱离父进程存活，`daemon.test.js` 里有一条专门盯这件事）。不设 `AKM_PASSPHRASE` 时，开机后的服务是**锁定态**——浏览器打开会先要求解锁，这正是设了口令之后想要的行为。

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

**这两份单元里都不要加 `--daemon`**：launchd 和 systemd 要的是前台进程。父进程一退出，监督器就认为服务挂了并重新拉起，而第二次 `--daemon` 只会报「已有一个实例在跑」并以退出码 1 结束——结果是监督器里一个永远在崩的假服务，真在跑的那个反倒不归它管。要后台化请交给 `Restart=on-failure` / `KeepAlive`，`--daemon` 是给双击和手动启动用的。

上面 macOS 的 launchd 与 Linux 的 systemd 都要求**前台**进程，`ProgramArguments` / `ExecStart` 里不要加 `--daemon`：加了之后监督进程看到的主进程一退出就被判成服务挂了，`KeepAlive` / `Restart` 会把它反复拉起来。`--daemon` 只用于 Windows 计划任务那种「起完就走」的场景。

## 局域网与远程访问

在运行服务的那台机器上，浏览器直接进 `http://127.0.0.1:37700` 就够了。要从别的设备看，按「打算连多久」选一条路。

### 1. 临时看一眼：SSH 隧道（推荐）

服务照旧只听回环，其他设备一个端口都不开，暴露面为零：

```bash
# 在笔记本 / 手机上执行，把远端服务映射到自己本机的 37700
ssh -N -L 37700:127.0.0.1:37700 user@运行服务的机器
```

然后这台设备的浏览器访问 <http://127.0.0.1:37700>。Windows 10 起自带 OpenSSH 客户端，PowerShell 里直接敲；手机用 Termius / Blink 这类支持本地端口转发的 SSH 客户端。代价是每次都得先把隧道开起来，且 SSH 服务端要可达。

### 2. 常年多端：WireGuard（或 Tailscale）

手机、平板、笔记本都要随时进来时，给每台设备发一个 WireGuard Peer，组一张自己的私网：流量不走明文 HTTP 出网卡，也不要在路由器上开任何端口。嫌配置麻烦可以直接用 Tailscale——同一套 WireGuard 协议，代价是多依赖一个第三方协调服务。

### 3. 图省事直接放开监听：可以，但先设口令

```powershell
# PowerShell；macOS / Linux 用 export AKM_BIND=192.168.1.20
$env:AKM_BIND = "192.168.1.20"    # 这台机器在局域网里的地址
node server.js
```

这条路上服务会先检查数据目录里有没有解锁口令，没有就**拒绝启动**（下面这段是实测输出，退出码 1）：

```
拒绝启动：监听地址 192.168.1.99 不是回环，而数据目录还没有解锁口令。
先在界面上给保险库设一个解锁口令（或启动时给 AKM_PASSPHRASE），再放开局域网监听。
```

口令就是这条路唯一的防线，所以把它能做到和做不到的都说清楚：

- 锁定态下密钥与凭证接口一律返回 423，同网段的设备取不到任何东西。
- 解锁后，列表里只有掩码；完整 Key 要点「显示明文」走 `POST /api/keys/:id/reveal`，逐条取、带限流、写审计（审计只记动作，不记明文）。闲置 5 分钟自动回到锁定态。
- **解锁窗口内它不是加密边界**：能操作你这个已解锁页面的人，就能逐条点出明文。所以 `AKM_BIND` 只填自己那台机器的局域网地址，别为了省事填 `0.0.0.0`；共用机器、访客网络、咖啡馆网络不要走这条路。

### 为什么不用容器

容器要能被局域网访问就必须把监听绑到 `0.0.0.0`，而口令又只能塞进 `docker-compose.yml` 的环境变量长期明文躺着——等于用一道门换了一道更松的门。本项目无需构建产物、无需多服务编排，容器在这里只增加暴露面，不解决问题。

## 反向代理（谨慎）

免口令的安装**没有任何鉴权**，一条不带口令的 GET 就能拿到掩码列表，而 `reveal` 能逐条点出明文。设过口令之后好一些（锁定态 423、解锁需口令、写入校验 Origin），但**应用本身没有账号体系**：一次解锁对整个会话有效。用 nginx / Caddy 暴露到局域网或公网前，务必在反代上再加一层 Basic Auth：

```nginx
server {
    listen 8080;

    # 必须加一层认证
    auth_basic "API-AegisLens";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:37700;
        proxy_set_header Host $host;   # 写请求会校验 Origin 与 Host 一致，Host 被改写会全部 403
    }
}
```

（实测：带外来 `Origin` 头的写请求返回 403「拒绝跨域写请求」，GET 不校验这条；不带 `Origin` 头的请求，比如 curl 或经反代改写过 `Host` 的浏览器请求，能通过这条校验——所以它防的是 CSRF，不是外人。）

## 数据备份与迁移

所有数据都在数据目录（默认 `~/.api-aegislens`）：

```
~/.api-aegislens/
├── keys.db          # 或 store.json —— AES-256-GCM 加密的密钥库 + 凭证库
├── master.key       # 主密钥（DEK）；免口令的安装里它就是解开数据的唯一凭据
├── vault.key        # 设过解锁口令才有：用口令派生的 KEK 把上面那把 DEK 包起来
├── recovery.env     # 设口令时生成的恢复码信封，只在生成那一刻显示一次
└── server.pid       # --daemon 的哨兵文件，正常停服会自己清掉
```

**备份**：停掉服务后，把整个目录复制到安全位置（加密盘/U 盘）。备份必须**成对**——库文件与解开它的凭据缺一即不可恢复；备份文件本身等同明文密钥，请放在与本机同等或更高的保护级别下。

`master.key` 和 `vault.key` 不是二选一的关系：设口令只是**多包了一层**，`master.key` 原地留着不动，删掉它要在「凭证保险库 → 明文密钥」里专门执行一次「拆除明文密钥」（该操作会先用口令解一次验证通过才允许删；没设口令时这个入口不出现）。拆除之后，能解开这个库的凭据就只剩「解锁口令」或「恢复码 + `recovery.env`」两把，此时 `vault.key` 与 `recovery.env` 必须一并备份。

**恢复是否可用，用这条实测过**（2026-10-07 在临时数据目录演练：建密钥 → 停服 → 整目录复制 → 删除原目录 → 复制回来 → 重启，密钥解密一致、手动模型与已分配工具全部存活）：

```bash
# 停服后备份（SQLite 无 -wal/-shm 残留，整目录复制即为一致快照）
cp -a ~/.api-aegislens /你的加密盘/api-aegislens-$(date +%F)
```

**缺 `master.key` 的后果（已改为启动即拒绝）**：若恢复时只拿回密钥库而漏了 `master.key`，早期版本会**静默生成一把新主密钥**，服务照常启动、界面只在读取密钥时报错，而旧库自此永久无法解密。现在这种情况会在启动时直接终止并提示「数据目录已有密钥库但缺少 master.key」，从备份补齐即可；确实想放弃旧库，走界面上的恢复码入口或连密钥库一起删除再启动。

**忘了解锁口令**：用设口令时抄下来的 52 位恢复码在解锁门上走「用恢复码重置」，服务会就地重建可解密的会话，不需要重启、不需要重录密钥。恢复码没抄下来且 `master.key` 已拆除，那这个库就解不开了——这是这类设计的定价，不是本项目的缺陷。

**迁移到新机器**：新机器上 `git clone` 项目并启动一次（生成目录结构）→ 停止服务 → 用旧机器的整个数据目录覆盖 → 重新启动。

**彻底重置**：停止服务后删除整个数据目录（所有密钥记录将清空，无法恢复）。

## 升级

```bash
cd API-AegisLens        # git clone 出来的目录名跟仓库名一致
git pull
cd app && npm test      # 可选：跑一遍全部测试确认环境正常（项数以命令输出为准，别信文档里的固定数字）
# 重启服务（自启方式对应的 restart 命令，或在 app 下重新运行 npm start）
```

`package.json` 在 `app/` 里，不在仓库根——`npm test` / `npm start` 都得先 `cd app`，
在外面敲只会得到 `ENOENT: no such file or directory, open '…\package.json'`。

数据目录与代码仓库完全分离，升级不影响已录入的密钥。

### 回滚到旧版本

回滚就是把代码换回旧 tag/commit 再重启，数据目录不用动。三件事先确认：

- **拆过 `master.key` 就别往回滚。** 旧版本只认 `master.key`，完全不知道 `vault.key` 的存在，后果按版本分两种，
  哪一种都不是好消息：
  - 回滚到 `c08bde3` **之后**的版本：启动即被拒，报「数据目录已有密钥库但缺少 master.key」。这是安全地失败。
  - 回滚到比它更早的版本（包括上游最初那份）：**静默生成一把新的 `master.key`**，服务照常起、界面照常开，
    只在读取旧数据时报错——而旧库自此永久解不开。这比报错糟得多。
  真要回滚，先从升级前的整目录备份把 `master.key` 放回去；没有备份就留在当前版本，别回退。
- **新表旧版本读不到，但不会被改坏。** `credentials` / `tokens` / `pools` 这几张表旧版本根本不查，
  JSON 后端里未知的字段也是原样读写回去——回滚是「功能看不见」，不是「数据损坏」。再升上来它们还在。
- **回滚前照例整目录备份一次**（同上面那条 `cp -a`），这样无论回滚还是再升级都有一条退路。

## 常见问题

**一打开就要求解锁，接口返回 423**
说明这台安装设过解锁口令，而当前会话是锁定态：输入口令解锁即可。忘记口令就走解锁门上的「用恢复码重置」，用设口令时抄下来的 52 位恢复码。锁定态下密钥列表、凭证、账号池三类数据接口一律 423（`boot-lock.test.js` 逐条钉住），而首页、平台目录、`/api/vault/*` 照常可用——界面才不至于变成一块打不开的白屏。闲置满 5 分钟会自动回到锁定态。

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
