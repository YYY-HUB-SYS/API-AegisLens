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
| `GET` | `/api/keys/{id}/history?kind=test\|balance` | Observation history: last 1000 rows per key, 200 returned by default. **No UI entry point** |
| `POST` | `/api/refresh-balances` | Batch balance refresh |
| `GET` | `/api/platforms` | Built-in platform catalogue (13 + custom) |
| `GET` | `/api/meta` | Version, meta-models date, storage backend, data directory, hostname, shadow store |

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

There are 4 scopes; resource lists are **enumerations** — an empty list grants nothing rather than
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
| Total routes | 52 (method + path combinations; 41 distinct path shapes) | `app/src/api.js`, `credentials-api.js`, `consumer-api.js` |
| UI actions | 75 distinct `data-act` values | `app/public/*.js`, `app/public/index.html` |
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
