# API & limits

> This is the **reference**, not a getting-started guide. First contact with the project belongs to
> the [README](../README_EN.md); deployment to [DEPLOYMENT](../DEPLOYMENT_EN.md); threat model to
> [SECURITY](../SECURITY_EN.md).
>
> Every path and every number here is counted out of the code and re-checked against it by
> `app/test/docs.test.js` — documenting an endpoint that does not exist, or a number that disagrees
> with the source, turns the suite red. The Chinese original is [docs/API.md](./API.md); the two
> files must keep the same set of `/api` paths.

## Keys and the board

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/keys` | List. **Last 4 characters only**, never the ciphertext |
| `GET` | `/api/keys/{id}` | One key. **Last 4 characters only**, never the ciphertext; plaintext goes through `POST /api/keys/{id}/reveal` |
| `POST` | `/api/keys` | Create |
| `PUT` | `/api/keys/{id}` | Update |
| `DELETE` | `/api/keys/{id}` | Delete |
| `POST` | `/api/keys/{id}/reveal` | Plaintext of one key; needs an unlocked session, its own rate-limit bucket, audited |
| `POST` | `/api/keys/{id}/test` | Connectivity test; `endpointIndex` picks which base URL |
| `GET` | `/api/keys/{id}/history?kind=test\|balance\|usage` | Observation history: last 1000 rows per key, 200 returned by default. **No UI entry point** |
| `POST` | `/api/refresh-balances` | Batch balance refresh |
| `POST` | `/api/keys/{id}/usage` | Fetch this key's **limit snapshot** (usage / rate-limit windows). **Account-level** data, stored against the key that was queried |
| `POST` | `/api/refresh-usage` | Batch refresh of limit snapshots. Responds `{keys, updated, failed, skipped}`; `skipped` counts platforms with no public endpoint |
| `GET` | `/api/platforms` | Built-in platform catalogue (13 + custom) |
| `GET` | `/api/meta` | Version, meta-models date, storage backend, data directory, hostname, shadow store |

### Balance vs limit snapshot: two different readings

These are **different things** and must not both be called "quota":

| | What it is | Granularity | How the UI shows it |
|---|---|---|---|
| **Balance** | How much money is left on the account | Per key | `余额 ￥12.34` + `· 10-21 13:05 查到` |
| **Limit snapshot** | The platform's window limits (calls left in 5 hours, 30-day quota) | **Per account** | `限额快照 · 5 小时窗口已用 1200/1500` + `· 10-21 13:05 查到` |

- A limit snapshot must say **"snapshot"** and carry its timestamp: it is a reading
  taken at the **last query**, not the current state. Writing "300 credits left"
  is dishonest — that number changes the next second.
- Three states must stay distinguishable: `snapshot found` / `never queried` /
  `this platform publishes no such endpoint`. "Never tested" is not "unlimited"
  and not "no data".
- When a platform publishes no endpoint (SenseNova, LongCat), the quota is only
  visible in the vendor console — say so plainly instead of reporting a generic
  "query failed".
- An authentication failure and a parse failure are different things: Zhipu
  (`body.code`) and MiniMax (`body.base_resp.status_code`) wrap authentication
  failures in **HTTP 200**. Without checking the platform error code first, an
  invalid key gets reported as "the platform returned balance data but the amount
  could not be parsed".

Platforms with a balance endpoint wired up: DeepSeek, Moonshot·Kimi, Zhipu,
StepFun, SiliconFlow, MiniMax, OpenRouter, Novita.
Platforms with a limit endpoint wired up: Zhipu (`{origin}/monitor/usage/quota/limit`, where `{origin}` is the vendor's API root),
MiniMax (`/v1/token_plan/remains`), Anthropic (`/v1/organizations/usage/costs`,
**requires an organization admin key** — a normal project key gets 403).

### Endpoints (models)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/keys/{id}/models` | Add a model by hand |
| `POST` | `/api/keys/{id}/models/fetch` | Pull the platform's `/models` list |
| `POST` | `/api/keys/{id}/models/enrich` | Fill in models with missing parameters: built-in metadata, then public web catalogues |
| `PATCH` | `/api/keys/{id}/models/{modelId}` | Edit one row. **Existing rows only** — anything else is a 404 |

Provenance has 6 values: `api` / `meta` / `web` / `builtin` / `manual` / `unknown`, with a separate
`ctxSrc` / `outSrc` per field, so values a human edited survive a re-fetch.
Capability flags: `reasoning`, `modalitiesIn`, `rpm`, plus the `outGtCtx` and `conflict` warning bits.

### Assignment trail

One assignment = `{tool, host}`: the tool plus which computer it runs on. The same
tool can be registered on several computers; legacy data (plain string arrays)
normalizes to `host: ""` (unknown computer) on read.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/keys/{id}/assigned` | Record which tool a key was configured into; body `{tool, host}`, empty `host` = this computer |
| `DELETE` | `/api/keys/{id}/assigned/{tool}?host=` | Remove the record; with `host` only that computer is removed, without it all computers at once |

## Account pools

| Method | Path | Notes |
|---|---|---|
| `GET` / `POST` | `/api/pools` | List / create (names unique, ≤40 characters) |
| `GET` / `PUT` / `DELETE` | `/api/pools/{id}` | Single pool / rename / delete |
| `POST` | `/api/pools/{id}/keys` | Add members |
| `DELETE` | `/api/pools/{id}/keys/{keyId}` | Remove a member |
| `POST` | `/api/pools/{id}/rotate` | Rotate: swap the active key for the first healthy backup |

`GET /api/pools` returns members through **the same masked view** as `GET /api/keys`, and answers
`423` while the vault is locked.

### The three roles of a pool member

| Role | Field | Meaning |
|---|---|---|
| Active | `role: "active"` | At most one per pool. A new pool's first member is it |
| Backup queue | `role: "backup"` | Ordered by `sortIndex`; rotation takes over in that order |
| Queue position | `sortIndex` | The active key always occupies `0`; backups are numbered from `1` — `0` is the active slot, backups never take it |

Editing the member list **does not change which key is active**: if it is still in the list it stays,
otherwise the first member takes over. Removing the active key promotes the head of the backup queue
(otherwise the pool would end up with nothing usable).

### Health snapshot

Every key carries two health fields (`failCount` / `lastHealthAt`) that follow the test outcome:
a pass resets the consecutive-failure counter, a failure increments it, and any concluded probe
refreshes the timestamp.

**Unhealthy means 2 or more consecutive failures.** A key that was never tested is not unhealthy —
never tested is not the same as broken, so an untested key still counts as able to take over, and
rotation filters on that rule.

`GET /api/pools/{id}` and the rotation response both carry `health[]`, one entry per member
(`keyId` / `name` / `role` / `failCount` / `lastHealthAt` / `lastStatus` / `healthy`),
with **no key material**.

### Rotation

`POST /api/pools/{id}/rotate`, the request body is optional:

- no body: switch to the first healthy key in backup-queue order;
- with `{"toKeyId": N}`: switch to that specific key (it must belong to this pool, otherwise `400`).
  An explicit rotation does not apply the health filter — an explicitly named key is honoured.

The response is `{ ok, changed, pool, rotatedFrom, rotatedTo, skipped }`, where `skipped` lists the
unhealthy backups that were examined and passed over. Rotating to the key that is already active is
**idempotent**: it answers `200` with `changed:false` and leaves the state untouched. A backup
queue with no healthy key answers `400` 「备用队列里没有健康的密钥」.

Rotation is audited (`kind: rotate`) and the audit entry records **key ids only, never key material**.

## Credential vault

| Method | Path | Notes |
|---|---|---|
| `GET` / `POST` | `/api/credentials` | List / create (`site` required: the list groups by site) |
| `GET` | `/api/credentials/health` | Reused usernames, weak passwords, age stats. **Contains no secret content** |
| `GET` / `PUT` / `DELETE` | `/api/credentials/{id}` | Read (masked) / update / delete |
| `POST` | `/api/credentials/{id}/reveal` | The only plaintext exit: `password` `secret` `note` `totpSecret` |
| `GET` | `/api/credentials/{id}/totp` | Live code plus `step` / `digits` / `algorithm` / `secondsRemaining` |
| `GET` | `/api/credentials/{id}/password-policy` | This site's password rules (data from Apple's public table) |

Field limits: title 200, username / URL / folder / tag 200 each, password 256, secret 512, note 2000.
The TOTP seed may be bare Base32 or a whole `otpauth://` URI (in which case `period` / `digits` /
`algorithm` come from the URI).

## Vault sessions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/vault/status` | `unlocked` / `mode` / `passphraseSet` / `rawKeyPresent` / `needsSetup` / `idleRemainingMs` / `recent` (last 8 audit entries) |
| `POST` | `/api/vault/unlock` | Unlock; failures count against the rate limit  separate bucket from the recovery code: mistyping the recovery code does not lock the unlock door |
| `POST` | `/api/vault/lock` | Lock now (also closes the store) |
| `POST` | `/api/vault/passphrase` | Set / change the passphrase; changing requires `current` |
| `POST` | `/api/vault/recover` | Reset the passphrase with the 52-character recovery code, rotating it at the same time  failures count toward their own rate-limit bucket  on success **every previously issued token is invalidated** (the issued-token records are cleared; the response carries `tokensRevoked`); keys, credentials and pools are untouched |
| `POST` | `/api/vault/discard-master-key` | Remove the plaintext DEK copy. **Irreversible**; refused on a passphrase-free install |
| `POST` | `/api/vault/master-key-location` | Move the master key between "plaintext file in the data directory" and "system credential store", body `{target:"os"|"file"}`. **Reversible**; after moving to `os` the data directory keeps only a placeholder file with no key in it. Needs an available system credential store (install the optional `@napi-rs/keyring`), otherwise 400 |

## Machine consumer tokens

Management side (used from the browser; same-origin writes):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/consumer/tokens` | List, metadata only |
| `POST` | `/api/consumer/tokens` | Mint. **The plaintext token is returned in this one response only**; the store keeps the first 8 hex of an HMAC fingerprint |
| `POST` | `/api/consumer/tokens/{tid}/revoke` | Revoke |

Machine side (Bearer token):

| Method | Path | Required scope |
|---|---|---|
| `GET` | `/api/consumer/keys/{id}` | `key:read` |
| `POST` | `/api/consumer/keys/{id}/test` | `key:test` |
| `GET` | `/api/consumer/keys/{id}/balance` | `balance:read` |
| `GET` | `/api/consumer/credentials/{id}` | `cred:read` |

There are 5 scopes; resource lists are **enumerations** — an empty list grants nothing rather than
everything. The server stores the payload exactly as requested: check a scope but pick no resources
and you get a token that can read nothing (**an empty resource list means zero readable**, not
"everything readable"). The browser's minting form blocks that case; a script calling the API
directly does not.
Limits: label 40 characters, 64 resource ids in total, lifetime 60 seconds to 90 days
(30 days by default). Status codes: `423` vault locked (says nothing about your token), `401` token
missing / invalid / expired / revoked, `403` scope not granted, `429` too frequent (with `retryAfterMs`).
The revocation check runs **after** the scope check: a revoked token used against an endpoint whose
scope it does not carry gets `403` scope, not `401` revoked — to confirm that a token was revoked,
call with a token whose scope matches.
A token has two gates: the signature (derived from the DEK) and the **issued-token record** (the
`tokens` table in the store). Resetting the passphrase with the recovery code takes the second gate:
the DEK does not change and not one ciphertext is rewritten, but the issued-token records are wiped,
so old tokens answer `401` (`reason: unknown`) and have to be re-issued.

## Local gateway (data plane)

Any OpenAI-compatible client (Dify / n8n / Claude Code / Cherry Studio) can call the
vendor keys inside this machine's account pools by holding one **consumer token**:
the client only ever sees its own token, the vendor key is fetched server-side from
the pool.

| Method | Path | Required scope |
|---|---|---|
| `POST` | `/api/proxy/v1/chat/completions` | `proxy:invoke` |
| `GET` | `/api/proxy/v1/models` | `proxy:invoke` |

- **`proxy:invoke` binds to the existing `keyIds` resource list**: the gateway
  only uses the keys the token lists, and falls back to the pool's active key when
  the list is empty. The **payload shape is unchanged** — adding a field would
  invalidate every token already issued.
- Key order: the pool's `role=active` key first, then the backup queue;
  keys with **2 or more consecutive failures are skipped** (never tested is not broken).
- A vendor 401 / 429 / 5xx or a timeout **switches to the next key automatically**;
  if every key fails the answer is `502` and it says how many were tried and why —
  never a fake success. A key switch is audited.
- **Never in a response**: vendor key plaintext, request bodies (prompt / messages).
  The audit record holds metadata only (token fingerprint, pool id, model, how many
  switches, HTTP status, token usage).
- Its own rate-limit bucket: **60 requests / 60 s per token**; upstream timeout
  120 s per attempt with a 5-minute budget for the whole request; request bodies
  capped at 1 MiB (`413` beyond that).
- Streaming is **not supported** in this version (`stream:true` answers `400`
  explicitly rather than silently degrading).
- Cross-origin write requests are rejected with `403`.

## Local usage

`GET /api/local-usage?days=30&sources=1`

Reads the usage logs that the local AI coding agents (MiniMax Code / cc-switch / WorkBuddy AI) keep for themselves, and aggregates them by day, by model and by agent.

- **Numbers and model names only**: no conversation content is read, no session title is carried over, and no path from this machine is exposed. Collection opens the other application's sqlite database **read-only** and closes it right after; a changed source format or an unreadable source degrades to an empty result instead of a 500.
- **Two separate readings**: consumption (token counts, cost) and context occupancy (how much of the window is in use) are **not the same thing** — they come back as `totals` and `context` respectively. Don't merge them.
- `423` while the vault is locked; rate limit 60 requests / 60 s; results cached in-process for 5 seconds.
- UI entry point: "本机用量" in the top bar.

## Local usage

`GET /api/local-usage?days=30&sources=1`

Reads the usage logs that the local AI coding agents (MiniMax Code / cc-switch / WorkBuddy AI) keep for themselves, and aggregates them by day, by model and by agent.

- **Numbers and model names only**: no conversation content is read, no session title is carried over, and no path from this machine is exposed. Collection opens the other application's sqlite database **read-only** and closes it right after; a changed source format or an unreadable source degrades to an empty result instead of a 500.
- **Two separate readings**: consumption (token counts, cost) and context occupancy (how much of the window is in use) are **not the same thing** — they come back as `totals` and `context` respectively. Don't merge them.
- `423` while the vault is locked; rate limit 60 requests / 60 s; results cached in-process for 5 seconds.
- UI entry point: "本机用量" in the top bar.

## Scheduler

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/schedule` | Current state |
| `POST` | `/api/schedule` | Runtime toggle; **not persisted**, a restart goes back to the environment variable. **No UI switch** |
| `POST` | `/api/schedule/run` | **Run one round now** (test every key once + refresh balances in bulk). **It really does send requests to the vendors**, so it requires an unlocked vault; it has its own rate limit of 5 per hour. The outcome is written into "last run" |

## Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/import` | Accepts `{keys:[…]}`; the `type` field is validated in the frontend only (see Known limitations in the README) |

Export happens in the frontend and **omits the `key` field by default**; plaintext requires the
explicit checkbox, which then reveals items one by one.

## The numbers

| Item | Value | Source |
|---|---|---|
| Total routes | 57 (method + path combinations; 46 distinct path shapes) | `app/src/api.js`, `credentials-api.js`, `consumer-api.js`, `proxy-api.js` |
| UI actions | 77 distinct `data-act` values | `app/public/*.js`, `app/public/index.html` |
| Built-in platforms | 13 + custom | `app/src/platform-catalog.json` |
| Base URLs per key | 6 (enforced once in the frontend, once in the backend) | `MAX_EPS` in `index.html`, literal `6` in `adapters.js` |
| Passphrase length | 8 characters minimum, 1024 characters maximum | `crypto.js` |
| KDF | scrypt `N=32768, r=8, p=1` | `crypto.js` |
| Recovery code | 52 characters (base32, 256 bits) | `recovery.js` |
| Idle auto-lock | 5 minutes by default | `AKM_IDLE_LOCK_MINUTES` |
| Rate limits (failures / 5-minute window) | unlock 5, **recovery code 5 (own bucket)**, key reveal 30 (**bucketed per key id**), credential 20, token mint 20, passphrase change 5 | `server.js` |
| Rate limits (requests / 60-second sliding window) | consumer data plane **120** (bucketed per token; 401/403/404/423 do not count) | `consumer-api.js` |
| Rate limits (requests / 60-minute sliding window) | manual "run one round" **5** (bucketed per source IP; it really does send requests to the vendors) | `server.js` |
| Plaintext auto-retract | 30 seconds; immediate when the tab loses focus | `credentials-view.js` |
| Observation history | 1000 rows per key, 200 returned by default | `storage.js` |
