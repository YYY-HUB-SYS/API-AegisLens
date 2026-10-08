# 随仓口令规则数据来源 / Apple password-manager-resources provenance

**password-manager-resources** — 两份站点规则表，随仓提交，运行时不联网。

| 文件 | 取得路径 | 字节数 | 条目数 |
| --- | --- | --- | --- |
| `app/src/password-rules.json` | `quirks/password-rules.json` | 63,935 | 436 |
| `app/src/change-password-URLs.json` | `quirks/change-password-URLs.json` | 46,955 | 652 |

- 上游仓库：<https://github.com/apple/password-manager-resources>（`main` 分支）
- 取得方式：`curl -sL` 直接取 raw 文件，未做任何编辑，字节级原样落盘（LF，无 BOM，保留末尾换行）
- 下载时间：2026-10-08
- 许可证：MIT，正文见下方，原文取自上游仓库 `LICENSE.md`。
  上游要求仅为保留版权声明与许可声明——本文件即为履行该条件。
- 版权行：`Copyright 2020 - 2026 Apple Inc.`

## 数据结构（消费方 `app/src/passgen.js` 依赖的形态）

- `password-rules.json`：键是注册域（`apple.com`、`maybank2u.com.my`），值是
  `{"password-rules":"minlength: 6; maxlength: 16;"}` 这种单键对象。
- `change-password-URLs.json`：键是域名，值是改密页 URL 字符串（全部为 `http(s)://` 绝对地址）。
- 两份表的键**都不含 `www.` 前缀**，也都**不含裸公后缀**（没有 `co.uk`、`com.my` 这种条目），
  所以子域逐层回退到注册域的查法不会误命中。

规则串里有一个坑值得单独记：显式字符集写作
``required: [-!@#$%^&*()_+|~=`{}[:;"'<>,.?];``，
**字符集内部真的含有 `;` 和 `:`**，直接 `split(';')` 会把一条规则切成好几段。
上游另有 6 条这类字符集的方括号本身不配对（少写一个 `]`），所以解析器不能假设括号一定闭合。
`passgen.js` 的 `splitRuleSegments` 用括号深度断句、并对不配对降级为忽略碎片，
`app/test/passgen.test.js` 里对着 `maybank2u.com.my` 和 `bochk.com` 两条实测钉住了这个行为。

## 为什么随仓而不是在线取

这是本地优先工具，保险库的改密建议不能依赖第三方 CDN 可达；
MIT 许可也允许再分发，代价只是仓库里多 108KB 数据。

## 升级办法

没有 `npm update`。要更新就按上面的路径重新 `curl` 一次覆盖这两个文件，
并同步更新本表的字节数、条目数和下载时间。
`app/test/passgen.test.js` 会校验两份 JSON 可解析、条目数达标、许可证文件在位且含 MIT 正文，
条数若变化则需要同步更新测试里的下限常量。

---

## MIT License（上游原文）

```
Copyright 2020 - 2026 Apple Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
