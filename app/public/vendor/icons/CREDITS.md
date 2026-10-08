# Lucide icon sprite — provenance & license

Generated: 2026-10-08T12:56Z (UTC) · Working dir: `C:\Users\YQQ-Agent\AppData\Local\Temp\aegis-icons\`

## Source

| item | value |
| --- | --- |
| Repository | `lucide-icons/lucide` (https://github.com/lucide-icons/lucide) |
| Branch fetched | `main` |
| Commit SHA at fetch time | `a04f228cd01185e09c188b7227b9600c08c565ec` |
| Commit verification | `GET /repos/lucide-icons/lucide/commits/main` **and** `GET /repos/lucide-icons/lucide/git/ref/heads/main` both returned that SHA (`type: commit`); commit date `2026-10-08T07:16:31Z`, message `feat(icons): added \`lens\` icon (#4923)`. No release tag was used. |
| File URL template | `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg` |
| Name authority | Full icon inventory taken from `GET /repos/lucide-icons/lucide/git/trees/main?recursive=1` (`truncated: false`, 1870 files in `icons/`). No icon name or path datum was written from memory. |
| Content verification | Every `raw/<name>.svg` on disk has a git blob SHA (`sha1("blob <len>\0"+content)`) equal to the `icons/<name>.svg` blob SHA recorded in that tree object, i.e. byte-identical to the files at commit `a04f228`. See `report.json → icons[*].git_blob_sha_matches_repo_tree` (33/33 true). |
| License | ISC, plus MIT for the Feather-derived icons. Verbatim copy of the repo `LICENSE` is in `LICENSE-ISC.txt`. |

## License notice

The sprite in `sprite.svg` is a derivative work of Lucide icons and must ship together with
`LICENSE-ISC.txt` (the copyright + permission notice has to appear in all copies, per the ISC text).

Two license layers apply:

1. **ISC** — Lucide Icons and Contributors, covers all 33 icons.
2. **MIT (Cole Bemis / Feather)** — the `LICENSE` file lists icons derived from the Feather project;
   9 of the files used here are on that list: `trash`, `plus`, `x`, `chevron-down`, `arrow-left`,
   `download`, `upload`, `moon`, `link`. Both notices are already inside `LICENSE-ISC.txt`, so keeping
   that file next to the sprite satisfies both.

## Icon inventory (sprite order = semantic name, alphabetical)

| symbol id | source file at `icons/` | geometry elements | license note |
| --- | --- | --- | --- |
| `#i-activity` | `activity.svg` | 1 | ISC |
| `#i-arrow-left` | `arrow-left.svg` | 2 | ISC + MIT (Feather) |
| `#i-ban` | `ban.svg` | 2 | ISC |
| `#i-calendar-days` | `calendar-days.svg` | 10 | ISC |
| `#i-chevron-down` | `chevron-down.svg` | 1 | ISC + MIT (Feather) |
| `#i-clock-alert` | `clock-alert.svg` | 4 | ISC |
| `#i-clock-off` | `clock-fading.svg` | 6 | ISC — name substituted, see below |
| `#i-columns-2` | `columns-2.svg` | 2 | ISC |
| `#i-copy` | `copy.svg` | 2 | ISC |
| `#i-cpu` | `cpu.svg` | 14 | ISC |
| `#i-download` | `download.svg` | 3 | ISC + MIT (Feather) |
| `#i-eye` | `eye.svg` | 2 | ISC |
| `#i-eye-off` | `eye-off.svg` | 4 | ISC |
| `#i-gauge` | `gauge.svg` | 2 | ISC |
| `#i-globe` | `globe.svg` | 3 | ISC |
| `#i-key` | `key-round.svg` | 2 | ISC — name substituted, see below |
| `#i-layers` | `layers.svg` | 3 | ISC |
| `#i-link` | `link.svg` | 2 | ISC + MIT (Feather) |
| `#i-loader-circle` | `loader-circle.svg` | 1 | ISC |
| `#i-moon` | `moon.svg` | 1 | ISC + MIT (Feather) |
| `#i-pencil` | `pencil.svg` | 2 | ISC |
| `#i-plus` | `plus.svg` | 2 | ISC + MIT (Feather) |
| `#i-refresh-cw` | `refresh-cw.svg` | 4 | ISC |
| `#i-shield-check` | `shield-check.svg` | 2 | ISC |
| `#i-sliders-horizontal` | `sliders-horizontal.svg` | 9 | ISC |
| `#i-star` | `star.svg` | 1 | ISC |
| `#i-sun` | `sun.svg` | 9 | ISC |
| `#i-trash-2` | `trash.svg` | 5 | ISC + MIT (Feather) — name substituted, see below |
| `#i-triangle-alert` | `triangle-alert.svg` | 3 | ISC |
| `#i-upload` | `upload.svg` | 3 | ISC + MIT (Feather) |
| `#i-wallet` | `wallet.svg` | 2 | ISC |
| `#i-x` | `x.svg` | 2 | ISC + MIT (Feather) |
| `#i-zap` | `zap.svg` | 1 | ISC |

33 symbols · 112 geometry elements (102 `path`, 5 `circle`, 5 `rect`; the sources contained no
`line`/`polyline`/`polygon`).

## Naming substitutions performed (semantic name ≠ source file)

1. `key` → `key-round.svg` — requested explicitly. Note `key.svg` also exists on `main`; `key-round`
   was chosen, not forced by a 404.
2. `clock-off` → `clock-fading.svg` — `icons/clock-off.svg` returned **HTTP 404** and `clock-off` is
   absent from the tree inventory (the `clock*` family on `main` is: `clock`, `clock-1`…`clock-12`,
   `clock-alert`, `clock-arrow-down/left/right/up`, `clock-check`, `clock-fading`, `clock-plus`).
   Used the fallback you pre-approved. The semantic id stays `i-clock-off`.
3. `trash-2` → `trash.svg` — `icons/trash-2.svg` returned **HTTP 404**. Confirmed by upstream metadata:
   `icons/trash.json` declares alias `{ "name": "trash-2", "deprecated": true,
   "deprecationReason": "alias.duplicate" }`, i.e. upstream itself maps `trash-2` onto `trash`.
   The semantic id stays `i-trash-2`.

Names you listed that needed no substitution but are upstream-deprecated aliases (kept as-is because
the canonical file was fetched directly): `alert-triangle` → now `triangle-alert`
(`icons/triangle-alert.json`: alias `alert-triangle`, deprecated `alias.name`), `columns` → now
`columns-2`, `layers-3` → now `layers`, `loader-2` → now `loader-circle`.

Nothing requested was dropped for lack of a source; all 33 requested semantic names resolved.

## Attribute processing

**Stripped from the root `<svg>` of every source file** (all 33 files carried exactly this set):
`xmlns="http://www.w3.org/2000/svg"`, `width="24"`, `height="24"`, `fill="none"`,
`stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
`viewBox="0 0 24 24"` was moved onto the `<symbol>`.

**Kept inside `<symbol>`**: only geometry elements — `path`, `circle`, `rect`, `line`, `polyline`,
`polygon` — with their geometric attributes (`d`, `cx`, `cy`, `r`, `x`, `y`, `width`, `height`, `rx`,
`ry`). No `<g>`, `<defs>`, `<mask>`, `<text>`, `<style>` or `<use>` existed in any source; if one had,
the build would have logged it (`report.json → non_geometry_content_dropped` is `null` for all 33).

**One deliberate exception**: `child`-level `fill="currentColor"` is **preserved**, because it is
geometry-bearing, not theme. Only `#i-key` uses it (`<circle cx="16.5" cy="7.5" r=".5"
fill="currentColor"/>`, the key's dot); dropping it would render a hollow 0.5-radius ring.
`stroke-linecap` / `stroke-linejoin` / `stroke-dasharray` never appear at child level in these 33
files — Lucide puts them on the root only — so nothing semantic was lost; they must be declared once
by the outer layer.

**Normalisation**: self-closing tags re-emitted as `<tag …/>`, one element per line, source attribute
order preserved, no path-data re-encoding (coordinates are byte-identical to the fetched files).

## How to consume

The container is `display:none`, so its own attributes never reach the instantiated content — the
referencing `<svg>` must repeat the presentation attributes (or a CSS class must):

```html
<!-- paste sprite.svg once, anywhere in the body -->
<svg class="aegis-icon" width="20" height="20" aria-hidden="true"
     fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round"><use href="#i-key"></use></svg>
```

```css
.aegis-icon { fill: none; stroke: currentColor; stroke-width: 2;
              stroke-linecap: round; stroke-linejoin: round; }
```

## Files in this folder

| file | what |
| --- | --- |
| `sprite.svg` | the deliverable (7,581 bytes, UTF-8, no BOM, LF) |
| `LICENSE-ISC.txt` | verbatim `LICENSE` from commit `a04f228` |
| `CREDITS.md` | this notice |
| `report.json` | per-icon URL / HTTP status / symbol id / element counts / substitution notes / blob verification |
| `mapping.tsv` | the 33 `semantic → source file` pairs actually used |
| `raw/` | 33 `.svg` sources (byte-verified against the tree) + 33 `icons/*.json` upstream metadata files |
| `tree.json`, `commit.json`, `all-icons.txt`, `fetch-status.csv` | audit trail: repo tree object at `a04f228`, commit response, the 1870 icon names, and the per-file HTTP status / byte count |
| `build.js`, `verify.js` | the generator and the acceptance checks (`node verify.js` exits 0) |
