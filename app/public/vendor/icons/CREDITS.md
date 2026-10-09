# Lucide 图标 sprite —— 来源与许可

本目录**只有两份文件**：这一份说明，和 `LICENSE-ISC.txt`（上游 LICENSE 的逐字副本）。
图标本体不在这里——sprite 是**内联在 `app/public/index.html`** 里的一组 `<symbol>`，
所以本目录里没有 `sprite.svg`、`raw/`、`report.json` 之类的构建产物。

## 来源

| 项 | 值 |
| --- | --- |
| 上游仓库 | `lucide-icons/lucide` · <https://github.com/lucide-icons/lucide> |
| 取用时的分支与提交 | `main` @ `a04f228cd01185e09c188b7227b9600c08c565ec`（2026-10-08 取用，未使用任何 release tag） |
| 源文件路径模板 | `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg` |
| 许可证 | ISC；其中 12 个图标另带 MIT（Feather 派生，见下） |
| 许可证正文 | `LICENSE-ISC.txt`，含 ISC 与 Feather/MIT 两段声明，**必须随仓分发** |

## 生成时做过的校验

- 图标名与路径全部取自 `GET /repos/lucide-icons/lucide/git/trees/main?recursive=1` 的清单，没有一个是凭记忆写的。
- 提交号由 `GET /repos/.../commits/main` 与 `GET /repos/.../git/ref/heads/main` 两处各自返回一次并相符。
- 取回的 33 个源文件逐个算 git blob SHA，与上面那棵 tree 里记录的 blob SHA 相等，即字节级等同 `a04f228` 的内容。
- 呈现属性只从根 `<svg>` 上剥除（`xmlns` / `width` / `height` / `fill` / `stroke` / `stroke-width` /
  `stroke-linecap` / `stroke-linejoin`），`viewBox` 移到 `<symbol>` 上；`<symbol>` 内只保留几何元素。
  唯一的例外是 `#i-key` 里子元素级的 `fill="currentColor"`（钥匙上那个 0.5 半径的圆点），
  它是有几何含义的，剥掉会画成一个空心环。

⚠ **`rows-3` 是这批之后补进 sprite 的**，没有重跑上面那轮 blob 校验，也没有核对它在 `a04f228` 里的
源文件名与改名史。它的形状与元素数是从当前 sprite 量出来的（见下表），但**来源核验状态与其余 33 个不同**。

## 在界面里怎么被消费

`index.html` 里有一个 `display:none` 的容器装着这些 `<symbol>`，统一由 `ic(name, size)` 引用。
呈现属性**必须由 `ic()` 在引用处重复声明**（`fill="none"` / `stroke="currentColor"` /
`stroke-width="1.5"` / `stroke-linecap` / `stroke-linejoin` / `aria-hidden="true"`）——
`display:none` 容器自身的属性不会传递到 `<use>` 实例，这一点由 `app/test/workbench.test.js` 钉住：
它还盯「每个被引用的图标名都有 symbol」「两份许可文件在位」「图标不许走外链」。

## 命名替换（语义 id ≠ 上游源文件名），共 3 处

1. `key` → `key-round.svg`：按界面观感选的，`key.svg` 当时也在 `main` 上，不是被 404 逼的。
2. `clock-off` → `clock-fading.svg`：`icons/clock-off.svg` 返回 **HTTP 404**，且 `clock-off` 不在那棵 tree 的
   `clock*` 家族里（`clock`、`clock-1`…`clock-12`、`clock-alert`、`clock-arrow-*`、`clock-check`、`clock-fading`、`clock-plus`）。
   语义 id 保持 `i-clock-off`。
3. `trash-2` → `trash.svg`：`icons/trash-2.svg` 返回 **HTTP 404**；上游自己的 `icons/trash.json` 把
   `trash-2` 声明为 `trash` 的废弃别名（`alias.duplicate`），所以这是上游的映射而非我们的取舍。

另有四个名字本身是上游已废弃的别名，但规范文件是直接按新名取到的，未做替换：
`alert-triangle` → `triangle-alert`、`columns` → `columns-2`、`layers-3` → `layers`、`loader-2` → `loader-circle`。

## 清单

**34 个 symbol · 115 个几何元素**（元素数与类型是从当前 `index.html` 里的 sprite 实量出来的）。
「许可」列按上游 LICENSE 的 Feather 名单逐字比对：改了名的图标按**旧名**算，所以
`triangle-alert`（旧名 `alert-triangle`）、`columns-2`（旧名 `columns`）、`loader-circle`（旧名 `loader`）也带 MIT。
两段声明都在 `LICENSE-ISC.txt` 里，整体合规不依赖这一列的判断。

| symbol id | 上游源文件 | 元素 | 许可 |
| --- | --- | --- | --- |
| `activity` | `activity.svg` | 1（1 path） | ISC |
| `arrow-left` | `arrow-left.svg` | 2（2 path） | ISC + MIT（Feather） |
| `ban` | `ban.svg` | 2（1 path + 1 circle） | ISC |
| `calendar-days` | `calendar-days.svg` | 10（9 path + 1 rect） | ISC |
| `chevron-down` | `chevron-down.svg` | 1（1 path） | ISC + MIT（Feather） |
| `clock-alert` | `clock-alert.svg` | 4（4 path） | ISC |
| `clock-off` | `clock-fading.svg` | 6（6 path） | ISC |
| `columns-2` | `columns-2.svg` | 2（1 path + 1 rect） | ISC + MIT（Feather，LICENSE 里记的是旧名 `columns`） |
| `copy` | `copy.svg` | 2（1 path + 1 rect） | ISC |
| `cpu` | `cpu.svg` | 14（12 path + 2 rect） | ISC |
| `download` | `download.svg` | 3（3 path） | ISC + MIT（Feather） |
| `eye` | `eye.svg` | 2（1 path + 1 circle） | ISC |
| `eye-off` | `eye-off.svg` | 4（4 path） | ISC |
| `gauge` | `gauge.svg` | 2（2 path） | ISC |
| `globe` | `globe.svg` | 3（2 path + 1 circle） | ISC |
| `key` | `key-round.svg` | 2（1 path + 1 circle） | ISC |
| `layers` | `layers.svg` | 3（3 path） | ISC |
| `link` | `link.svg` | 2（2 path） | ISC + MIT（Feather） |
| `loader-circle` | `loader-circle.svg` | 1（1 path） | ISC + MIT（Feather，LICENSE 里记的是旧名 `loader`） |
| `moon` | `moon.svg` | 1（1 path） | ISC + MIT（Feather） |
| `pencil` | `pencil.svg` | 2（2 path） | ISC |
| `plus` | `plus.svg` | 2（2 path） | ISC + MIT（Feather） |
| `rows-3` ⚠ | `rows-3.svg` | 3（2 path + 1 rect） | ISC |
| `refresh-cw` | `refresh-cw.svg` | 4（4 path） | ISC |
| `shield-check` | `shield-check.svg` | 2（2 path） | ISC |
| `sliders-horizontal` | `sliders-horizontal.svg` | 9（9 path） | ISC |
| `star` | `star.svg` | 1（1 path） | ISC |
| `sun` | `sun.svg` | 9（8 path + 1 circle） | ISC |
| `trash-2` | `trash.svg` | 5（5 path） | ISC + MIT（Feather） |
| `triangle-alert` | `triangle-alert.svg` | 3（3 path） | ISC + MIT（Feather，LICENSE 里记的是旧名 `alert-triangle`） |
| `upload` | `upload.svg` | 3（3 path） | ISC + MIT（Feather） |
| `wallet` | `wallet.svg` | 2（2 path） | ISC |
| `x` | `x.svg` | 2（2 path） | ISC + MIT（Feather） |
| `zap` | `zap.svg` | 1（1 path） | ISC |
