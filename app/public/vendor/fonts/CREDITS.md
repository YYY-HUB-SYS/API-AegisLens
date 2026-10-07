# 内置字体来源 / Font provenance

**JetBrains Mono** — latin 子集，可变字重（`wght` 100–800），单文件 31,432 字节。

- 取得方式：Google Fonts `css2?family=JetBrains+Mono:wght@400;600;700` 的 `/* latin */` 分片，
  三个请求权重返回的是同一个 woff2（可变字体），故只保留一份。
- 下载时间：2026-10-07
- 许可证：SIL Open Font License 1.1，正文见同目录 `OFL.txt`。
  该字体声明中**没有 Reserved Font Name**，且我们未改动字体本身，可按原名引用。

## 为什么只做 latin

界面固定文案的中文字集可以子集化，但密钥名、备注、自定义平台名是用户当场敲的，
子集一漏字就会出现「半句新字体、半句微软雅黑」的混排，比全用系统字体更差。
所以中文继续交给系统字体栈，内置字体只负责数字、URL、模型 id、密钥尾巴这些拉丁内容。

## 升级办法

没有 `npm update`。要换版本就重新按上面的 URL 取一次 woff2 覆盖本目录文件，
并同步更新本段的下载时间。`app/test/vendor.test.js` 会校验签名、体积上限和许可证在位。
