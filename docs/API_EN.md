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
| `POST` | `/api/keys` | Create |
| `PUT` | `/api/keys/{id}` | Update |
| `DELETE` | `/api/keys/{id}` | Delete |
| `POST` | `/api/keys/{id}/reveal` | Plaintext of one key; needs an unlocked session, its own rate-limit bucket, audited |
| `POST` | `/api/keys/{id}/test` | Connectivity test; `endpointIndex` picks which base URL |
| `GET` | `/api/keys/{id}/history?kind=test\|balance` | Observation history: last 1000 rows per key, 200 returned by default. **No UI entry point** |
| `POST` | `/api/refresh-balances` | Batch balance refresh |
| `GET` | `/api/platforms` | Built-in platform catalogue (13 + custom) |
| `GET` | `/api/meta` | Version, storage backend, data directory, shadow store |

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

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/keys/{id}/assigned` | Record which tool a key was configured into |
| `DELETE` | `/api/keys/{id}/assigned/{tool}` | Remove the record |

## Account pools

| Method | Path | Notes |
|---|---|---|
| `GET` / `POST` | `/api/pools` | List / create (names unique, ≤40 characters) |
| `PUT` / `DELETE` | `/api/pools/{id}` | Rename / delete |
| `POST` | `/api/pools/{id}/keys` | Add members |
| `DELETE` | `/api/pools/{id}/keys/{keyId}` | Remove a member |

`GET /api/pools` returns members through **the same masked view** as `GET /api/keys`, and answers
`423` while the vault is locked.

## Credential vault

| Method | Path | Notes |
|---|---|---|
| `GET` / `POST` | `/api/credentials` | List / create |
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
| `POST` | `/api/vault/unlock` | Unlock; failures count against the rate limit |
| `POST` | `/api/vault/lock` | Lock now (also closes the store) |
| `POST` | `/api/vault/passphrase` | Set / change the passphrase; changing requires `current` |
| `POST` | `/api/vault/recover` | Reset the passphrase with the 52-character recovery code, rotating it at the same time |
| `POST` | `/api/vault/discard-master-key` | Remove the plaintext DEK copy. **Irreversible**; refused on a passphrase-free install |

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
everything. Limits: label 40 characters, 64 resource ids in total, lifetime 60 seconds to 90 days
(30 days by default). Status codes: `423` vault locked (says nothing about your token), `401` token
missing / invalid / expired / revoked, `403` scope not granted, `429` too frequent (with `retryAfterMs`).

## Scheduler

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/schedule` | Current state |
| `POST` | `/api/schedule` | Runtime toggle; **not persisted**, a restart goes back to the environment variable. **No UI switch** |

## Import / export

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/import` | Accepts `{keys:[…]}`; the `type` field is validated in the frontend only (see Known limitations in the README) |

Export happens in the frontend and **omits the `key` field by default**; plaintext requires the
explicit checkbox, which then reveals items one by one.

## The numbers

| Item | Value | Source |
|---|---|---|
| Total routes | 47 (method + path combinations; 38 distinct path shapes) | `app/src/api.js`, `credentials-api.js`, `consumer-api.js` |
| UI actions | 67 distinct `data-act` values | `app/public/*.js`, `app/public/index.html` |
| Built-in platforms | 13 + custom | `app/src/platform-catalog.json` |
| Base URLs per key | 6 (enforced once in the frontend, once in the backend) | `MAX_EPS`, `normEps` in `adapters.js` |
| Minimum passphrase length | 8 characters | `crypto.js` |
| KDF | scrypt `N=32768, r=8, p=1` | `crypto.js` |
| Recovery code | 52 characters (base32, 256 bits) | `recovery.js` |
| Idle auto-lock | 5 minutes by default | `AKM_IDLE_LOCK_MINUTES` |
| Rate limits (failures / 5-minute window) | unlock 5, key reveal 30, credential 20, token mint 20, passphrase change 5 | `server.js` |
| Plaintext auto-retract | 30 seconds; immediate when the tab loses focus | `credentials-view.js` |
| Observation history | 1000 rows per key, 200 returned by default | `storage.js` |
