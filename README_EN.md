# AI Key Manager

[简体中文](./README.md) | [English](./README_EN.md)

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-4B3FE3)
![Dependencies](https://img.shields.io/badge/dependencies-zero-0E9F6E)

**A local-first AI API key manager: enter once, see everything, use anywhere.**

Bring the API keys scattered across AI platforms into one local dashboard — encrypted storage, connectivity testing, automatic model catalog fetching, and one-click config generation for Dify / n8n / Claude Code / `.env`. The service listens on `127.0.0.1` only; your data never leaves your machine.

## Features

- **Encrypted storage** — Keys are encrypted field-by-field with AES-256-GCM before hitting disk; the master key is stored separately and plaintext never touches disk. A stolen data file cannot reveal your keys
- **Dual storage backends** — Prefers SQLite (`node:sqlite`) and seamlessly falls back to a JSON file when unsupported
- **Multiple compatible endpoints** — Each key can hold up to 6 Base URLs (OpenAI / Anthropic / custom compatibility styles). For example, DeepSeek can register both `https://api.deepseek.com` and `https://api.deepseek.com/anthropic`
- **Connectivity testing** — Verifies key validity via the platform's model list endpoint; endpoints without a list API (e.g. Volcano Ark Agent Plan) automatically fall back to an auth probe against the chat endpoint
- **Model catalog** — Auto-fetches model lists; context window and max output are filled by a four-level fallback chain: platform API → built-in metadata DB → web search (OpenRouter / models.dev) → manual entry. Volcano Ark Agent Plan endpoints ship with a built-in official model catalog
- **Config generation** — Renders per-tool templates with model parameters included. Dify / n8n pick the OpenAI-compatible endpoint; Claude Code picks the Anthropic-compatible one (generating `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`)
- **Balance monitoring** — DeepSeek balance queries with one-click refresh for all keys
- **Expiry management** — Automatic expiring (within 30 days) / expired status detection with kanban badges
- **Proxy auto-detection** — Endpoints unreachable by direct connection (e.g. overseas relay stations) automatically route through the system or environment-variable proxy (CONNECT tunnel); requests carry a coding-tool User-Agent to pass relay-side client fingerprinting
- **Zero dependencies** — Pure Node.js standard library. Run right after `git clone`, no `npm install` needed

## Quick Start

Requirement: [Node.js](https://nodejs.org/) >= 18 (no dependencies to install).

```bash
git clone https://github.com/roseion/ai-key-manager.git
cd ai-key-manager/app
npm start
```

Open <http://127.0.0.1:37700> in your browser. Windows users can simply double-click `app/start.bat`.

For more deployment options (auto-start on boot, systemd / launchd / Task Scheduler, reverse proxy, data backup and upgrades), see the [Deployment Guide](./DEPLOYMENT_EN.md).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AKM_PORT` | `37700` | Port the service listens on (127.0.0.1 only) |
| `AKM_DATA_DIR` | `~/.ai-key-manager` | Data directory (encrypted store and master key) |
| `AKM_PROXY` | auto-detect | Proxy for outbound requests. Detection order: `HTTPS_PROXY`/`HTTP_PROXY` environment variables, then the Windows system proxy. Set to `off` to force direct connection, or e.g. `http://127.0.0.1:7897` to pin a proxy |

## Workflow

1. **Add a key** — Pick a platform (DeepSeek / OpenAI / Anthropic / Moonshot / custom), paste the API key; endpoint URLs and the default model are auto-filled. One key can carry multiple compatible endpoints
2. **Test connectivity** — One click to verify the key works
3. **Fetch models** — Pull the model catalog automatically; missing parameters are enriched online, and anything still missing can be entered manually
4. **Generate config** — Render Dify / n8n / Claude Code / `.env` snippets and copy them into your target tool

## Running Tests

```bash
cd app
npm test
```

85 tests cover encryption, storage (both backends), API integration, adapters, proxying, and the start script.

## Project Layout

```
├── app/                    # Main app (Node.js, zero dependencies)
│   ├── server.js           # Entry point
│   ├── src/                # Crypto / storage / API / platform adapters
│   ├── public/             # Frontend single page
│   └── test/               # Tests
├── ai-key-manager-prd/     # Product design document (PRD, in Chinese)
└── demo/                   # Interactive demo page
```

## Security Notes

- Key fields are AES-256-GCM encrypted on disk; the master key is kept separately in the same data directory
- The service listens on `127.0.0.1` only; write endpoints enforce same-origin checks and reject cross-origin writes
- All `sk-` samples in this repository are fake keys for demonstration

## Author

- Homepage: <https://www.oldgao.com>
- QQ: 638694
- WeChat: reincat

## License

[MIT](./LICENSE)
