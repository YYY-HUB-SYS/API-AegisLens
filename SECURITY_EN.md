# Security model / SECURITY

[简体中文](./SECURITY.md) | [English](./SECURITY_EN.md)

This document states three things plainly: **what this tool defends against, what it does not, and the
preconditions under which each defence actually holds**. It goes further than the "Known limitations" list in
the README, because those limitations *are* the threat model.

---

## The short version

API-AegisLens stores your secrets **encrypted, on your own machine**, and turns "when does plaintext leave"
into a gated door. It is **not** a system that resists "a process running on this machine as you" — unless you
complete step 4 below.

---

## Trust boundaries, by where the attacker stands

### 1. Someone with a backup file or your stolen disk — defended, with a precondition

- Secret fields for keys and credentials are encrypted at rest with **AES-256-GCM** (`keys.db` or `store.json`);
  everything else is stored in plaintext.
- Once you set an unlock passphrase, the passphrase is stretched with **scrypt (N=2^15, r=8, p=1)** into a KEK
  that wraps the master key (DEK) into `vault.key`.
- With only the vault file and no passphrase, an attacker is left with offline guessing; the scrypt parameters
  exist to make every attempt expensive.
- **Precondition**: `master.key` must have been discarded (step 4). Until then the plaintext DEK sits in the same
  directory, so copying the directory copies everything — the passphrase adds a layer, it does not remove the
  original key.

### 2. Devices on the same network — absent by default, and gated when you enable it

- The service binds to `127.0.0.1` by default.
- If you widen the bind address with `AKM_BIND` while the data directory has no passphrase, **the service refuses
  to start (exit code 1)**. There is no environment variable that bypasses this; that is deliberate.
- Once open: while locked, every data endpoint answers `423`; even unlocked, list endpoints carry masks only.
- Note though: **inside an unlocked session this is not an encryption boundary** — anyone who can drive that
  unlocked page can reveal keys one at a time.

### 3. A malicious website in your browser — only half covered

- Every **write** request compares `Origin` with `Host`; a mismatch returns 403 "拒绝跨域写请求".
- 🔴 **`GET` is not checked, and requests with no `Origin` header at all are allowed through** (curl, or a browser
  whose `Host` was rewritten by a reverse proxy, both fall in this class). This is a CSRF defence, not
  authentication. It stops "another web page driving your browser into a mutation"; it does not stop "any process
  that can reach this port sending a request directly".

### 4. A process running on this machine as you — not defended by default, and this is stated design

The README says it at the top; here is its exact meaning:

- **Passphrase-free install**: any local process can call `POST /api/keys/:id/reveal` and take plaintext, with no
  credential at all.
- **Passphrase set, currently locked**: nothing is obtainable (`423`).
- **Passphrase set, currently unlocked**: a process that can reach the port can still reveal — the passphrase
  defends "nobody is at the keyboard", not "a process acts after you logged in".
- **Account pools are not a second plaintext exit**: `GET /api/pools` returns the same masked view `GET /api/keys`
  uses (last 4 characters only) and answers `423` while the vault is locked. This deserves its own line because a
  pool resolves its members into full key records to render them, so leaking `rec.key` here is one careless line
  away — and that would turn "we closed `/api/keys`" into "just call `/api/pools` instead".
- To tighten it: **discard `master.key` under "credential vault → plaintext key"**, then press "lock" when you are
  done. After that, with the vault locked, no file on this machine can decrypt the data on its own.

Machine consumers (CLIs, agent frameworks, internal services) should not share that one master key. Issue each of
them a [scoped consumer token](./README_EN.md#issuing-a-narrow-scoped-key-for-a-script-a-real-round-trip): individually revocable, expiring,
and covering only the resources you enumerated.

### 5. Cloud hosts and hardware someone else operates — keep the data off them

A cloud VPS is recommended as a **tunnel endpoint**, not as the place your vault lives. Static data on someone
else's hardware puts disks, snapshots, images and platform operator access out of your reach; and connectivity
tests plus balance queries send your Bearer keys to providers from that cloud IP, which is exactly the pattern
that trips providers' geo/IP risk controls. See the [deployment guide](./DEPLOYMENT_EN.md#lan-and-remote-access).

---

## What is not defended, plainly

- **Weak passphrases.** scrypt makes guessing expensive, not immune. Passphrase strength is your responsibility;
  the tool enforces a minimum length and nothing more.
- **A forgotten passphrase.** The only way back in is the 52-character recovery code from when you set the
  passphrase (`recovery.env` plus the code you wrote down). Lose both and the vault is permanently unreadable —
  **there is no backdoor**, not even for the maintainers.
- **Keyloggers, memory reads, an already-unlocked browser window.** All of these fall under "a process running as
  you", see item 4.
- **Backups.** A whole-directory backup (still containing `master.key`) is plaintext-equivalent. Store it with at
  least the care you give the machine itself.
- **Exports.** No plaintext keys by default; ticking "include plaintext keys" is explicit, rate-limited, self-risk.
- **`index.html` is read into memory at startup.** Editing front-end files needs a service restart; a browser
  refresh will not show new code.

---

## Supply chain and telemetry

- **Zero dependencies**: `package.json` declares no dependencies, there is no `npm install` and no build step.
- **At run time** exactly three third-party artefacts ship in the repository. Their licences and provenance live
  next to them and `vendor.test.js` fails if they go missing:

  | Material | Licence | Files |
  |---|---|---|
  | Lucide icons (inlined sprite) | ISC, plus MIT for the Feather-derived set | `app/public/vendor/icons/LICENSE-ISC.txt`, `CREDITS.md` |
  | JetBrains Mono, latin subset | SIL OFL 1.1 | `app/public/vendor/fonts/OFL.txt`, `CREDITS.md` |
  | Apple `password-manager-resources` rule tables | MIT | `app/src/LICENSE-apple-password-rules.md` |

- **The documentation folder carries more**: `api-aegislens-prd/_shared/` ships 6 `.ttf` files and a
  `mermaid.min.js` (~3.0 MB) for the product-design page. They are **not part of the running app**; the OFL / MIT
  licence texts and where they were retrieved from are recorded in `api-aegislens-prd/_shared/CREDITS.md`, which
  also states plainly that those binaries' **exact versions were not byte-verified** — a known gap left when the
  licences were added on 2026-10-09, not something already checked.

- **No external references**: no CDN, no remote fonts, no iframes — `homepage.test.js` fails the build over this.
- **No telemetry**: apart from the endpoints you enter yourself and the public model catalogs fetched by online
  completion (which carry no key), the app sends requests nowhere.

---

## Reporting a security issue

Please use the repository's **Private vulnerability reporting** (Security tab → Report a vulnerability) rather
than a public issue. Expect a reply within a reasonable time; fixes usually ship with the next release.

## Related documents

- [README](./README_EN.md) — capabilities and known limitations
- [DEPLOYMENT](./DEPLOYMENT_EN.md) — bind addresses, tunnels, backups, discarding the plaintext key
