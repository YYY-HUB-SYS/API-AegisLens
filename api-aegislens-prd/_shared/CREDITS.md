# `_shared/` 第三方资产 —— 许可与来路

本目录服务于 `api-aegislens-prd.html`（产品设计文档，浏览器直接打开的静态页），
**不属于应用运行时**：应用自己的前端在 `app/public/`，那里只随仓一份 JetBrains Mono 的
latin 子集 woff2（许可证见 `app/public/vendor/fonts/`）。

## 清单

| 文件 | 是什么 | 许可 |
|---|---|---|
| `fonts/BricolageGrotesque-{Regular,Bold}.ttf` | 文档标题用无衬线体 | SIL OFL 1.1 → `fonts/OFL-BricolageGrotesque.txt` |
| `fonts/InstrumentSans-{Regular,Bold}.ttf` | 文档正文用无衬线体 | SIL OFL 1.1 → `fonts/OFL-InstrumentSans.txt` |
| `fonts/JetBrainsMono-{Regular,Bold}.ttf` | 文档代码块用等宽体 | SIL OFL 1.1 → `fonts/OFL-JetBrainsMono.txt` |
| `js/mermaid.min.js` | 渲染文档里的流程图/时序图 | MIT → `js/LICENSE-mermaid-MIT.txt` |

## 这份记录是怎么来的（2026-10-09）

**这些二进制是 PRD 生成时放进来的，当时没有随附任何许可证文件**——OFL 明确要求许可与版权声明
必须随字体分发，MIT 要求在副本中保留声明，所以那是一处实打实的合规缺口，不是"少写个说明"。

本次补齐的是**许可证正文**，取回渠道逐条可查：

- 三款字体的 `OFL.txt` 取自 `google/fonts` 仓库对应目录
  （`ofl/bricolagegrotesque/`、`ofl/instrumentsans/`、`ofl/jetbrainsmono/`），
  经 `api.github.com/repos/google/fonts/contents/...` 原样取回，未做任何编辑。
- `LICENSE-mermaid-MIT.txt` 取自 `mermaid-js/mermaid` 仓库的 `LICENSE`
  （`api.github.com/repos/mermaid-js/mermaid/license`，SPDX 标识 `MIT`）。

🔴 **仍未核验的部分，别当成已核验**：上面四份许可证是**按字体家族与 mermaid 本身**取的，
而本目录里那几个 `.ttf` / `.min.js` 二进制的**具体版本、构建号与下载来源没有做过字节级比对**
（不像 `app/public/vendor/icons/CREDITS.md` 那样逐个对过 git blob SHA）。
如果将来要把这份 PRD 对外分发或重打包，请先按图标那份记录的做法，把二进制与上游版本对齐一次。

## 为什么留在这个仓库里

PRD 记录的是设计意图与取舍，其中若干条已经落地、若干条明确不做。它是文档不是承诺；
应用当前能力以 `README.md` 为准，安全边界以 `SECURITY.md` 为准。
