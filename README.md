# AI Key Manager

[简体中文](./README.md) | [English](./README_EN.md)

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-4B3FE3)
![Dependencies](https://img.shields.io/badge/依赖-零-0E9F6E)

**本地优先的 AI API Key 管理工具：一次录入，全盘掌握，随处可用。**

把散落各处的 AI 平台 API Key 收拢到本地统一管理——加密存储、连通性测试、模型目录自动拉取，一键生成 Dify / n8n / Claude Code / .env 配置片段。全程只监听 `127.0.0.1`，数据不出本机。

## 功能特性

- **加密存储** — 密钥以 AES-256-GCM 字段级加密落盘，主密钥独立保管，明文永不落盘；存储文件拷走也无法解出密钥
- **双存储后端** — 自动优选 SQLite（`node:sqlite`），环境不支持时无缝回退 JSON 文件
- **多兼容端点** — 同一 Key 可配最多 6 个 Base URL（OpenAI / Anthropic / 自定义兼容模式），如 DeepSeek 可同时登记 `https://api.deepseek.com` 与 `https://api.deepseek.com/anthropic`
- **连通性测试** — 调用平台模型列表接口验证密钥可用性；无列表接口的端点（如火山方舟 Agent Plan）自动回退对话接口鉴权探测
- **模型目录** — 自动拉取模型列表；上下文长度与最大输出经四级兜底补全：平台接口 → 内置元数据库 → 联网检索（OpenRouter / models.dev）→ 手动补充；火山方舟 Agent Plan 端点内置官方模型目录
- **配置生成** — 按目标工具套用模板，自动带入模型参数；Dify / n8n 取 OpenAI 兼容端点，Claude Code 取 Anthropic 兼容端点（生成 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`）
- **余额监控** — 按 Base URL 域名自动匹配官方余额接口（DeepSeek / Moonshot / Kimi / SiliconFlow），自定义平台指向官方域名同样可查，多端点依次回退，一键刷新全部密钥
- **有效期管理** — 临期（30 天内）/ 过期状态自动判定与看板标记
- **代理自动检测** — 境外中转站等直连不可达的端点自动走系统 / 环境变量代理（CONNECT 隧道），请求带编程工具 User-Agent 以通过中转站客户端检测
- **零依赖** — 纯 Node.js 标准库实现，`git clone` 后无需 `npm install` 即可运行

## 快速开始

环境要求：[Node.js](https://nodejs.org/) >= 18（无需安装任何依赖）。

```bash
git clone https://github.com/roseion/ai-key-manager.git
cd ai-key-manager/app
npm start
```

浏览器打开 <http://127.0.0.1:37700> 即可使用。Windows 用户也可以直接双击 `app/start.bat` 启动。

更详细的部署方式（开机自启、systemd / launchd / 计划任务、反向代理、数据备份与升级）见 [部署指南](./DEPLOYMENT.md)。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AKM_PORT` | `37700` | 服务监听端口（仅 127.0.0.1） |
| `AKM_DATA_DIR` | `~/.ai-key-manager` | 数据目录（加密存储与主密钥） |
| `AKM_PROXY` | 自动检测 | 外发请求代理。默认依次检测 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量与 Windows 系统代理；设为 `off` 强制直连，或设为 `http://127.0.0.1:7897` 显式指定 |

## 使用流程

1. **新增密钥** — 选择平台（DeepSeek / 智谱 / 硅基流动 / 火山方舟 / Moonshot / OpenAI / Anthropic 等 12 个内置平台，或自定义），填入 API Key，地址与默认模型自动填充；同一 Key 可配多个兼容端点
2. **测试连通** — 一键验证密钥可用性
3. **拉取模型** — 自动拉取模型目录，参数不足时联网补全，仍缺可手动补充
4. **生成配置** — 按 Dify / n8n / Claude Code / .env 模板生成配置片段，整段复制到目标工具

## 运行测试

```bash
cd app
npm test
```

94 项测试覆盖加密、存储（双后端）、API 集成、适配器（平台目录与余额域名匹配）、代理与启动脚本。

## 目录结构

```
├── app/                    # 主应用（Node.js，零依赖）
│   ├── server.js           # 启动入口
│   ├── src/                # 加密 / 存储 / API / 平台适配器
│   ├── public/             # 前端单页
│   └── test/               # 测试
├── ai-key-manager-prd/     # 产品设计文档（PRD）
└── demo/                   # 交互演示页
```

## 安全说明

- 密钥字段 AES-256-GCM 加密后落盘，主密钥与数据同目录分离保管
- 服务仅监听 `127.0.0.1`，写接口校验同源，拒绝跨域写入
- 本仓库所有 `sk-` 样例均为演示用的假密钥

## 作者

- 个人主页：<https://www.oldgao.com>
- QQ：638694
- 微信：reincat

## 许可证

[MIT](./LICENSE)
