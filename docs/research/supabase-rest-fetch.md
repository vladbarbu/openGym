# Supabase Auth and PostgREST with plain fetch

Research notes for issue #4: calling Supabase Auth (GoTrue) and PostgREST from a browser client
without `@supabase/supabase-js`. Checked against primary sources on 2026-11-25. Each section lists
its sources; `[src]` marks a claim read in source code rather than docs.

Base URL: `https://<project>.supabase.co` (hosted) or `http://127.0.0.1:54321` (local CLI).
Auth lives under `/auth/v1`, PostgREST under `/rest/v1`.

## 1. Keys and headers

| Key | Looks like | Use | Postgres role |
|---|---|---|---|
| Publishable | `sb_publishable_...` | browser, apps, safe to expose | `anon` (or `authenticated` with a user JWT) |
| Secret | `sb_secret_...` | backend only, bypasses RLS | `service_role` |
| `anon` (legacy) | JWT | "Legacy version of publishable keys" | `anon` |
| `service_role` (legacy) | JWT | "Legacy version of secret keys" | `service_role` |

- "Send publishable and secret keys on the `apikey` header, not on `Authorization: Bearer`."
  Publishable keys are not JWTs. The signed-in user's own access token goes in
  `Authorization: Bearer <access_token>`.
- So every request carries `apikey: <publishable key>`; authenticated requests add
  `Authorization: Bearer <access_token>`. With the legacy anon key, the old pattern was to also send
  `Authorization: Bearer <anon key>` when signed out; with a publishable key, just omit
  `Authorization` when signed out.
- "Supabase is deprecating the `anon` and `service_role` keys in early 2027." Existing legacy keys
  stay valid until disabled in the dashboard.

Local CLI: the `supabase start` docs show an "Authentication Keys" box with only "Publishable"
(`sb_publishable_...`) and "Secret" (`sb_secret_...`). `supabase status -o env` still emits the
legacy values: the CLI's status fields are `PUBLISHABLE_KEY`, `SECRET_KEY`, `JWT_SECRET`,
`ANON_KEY`, `SERVICE_ROLE_KEY`, with a source comment saying the deprecated fields (`jwt_secret`,
`anon_key`, `service_role_key`) "are still emitted" [src].

Sources:
- https://supabase.com/docs/guides/api/api-keys
- https://supabase.com/docs/guides/local-development/cli/getting-started
- https://supabase.com/docs/reference/cli/supabase-status
- https://github.com/supabase/cli/blob/develop/apps/cli/src/command-internal/status-values.ts [src]

## 2. Auth endpoints

All take `apikey`, and `Content-Type: application/json` for bodies.

### Sign up: `POST /auth/v1/signup`

```json
{ "email": "a@example.com", "password": "secret" }
```

- Email confirmation off (autoconfirm): `200` with a session (`AccessTokenResponse`, below).
- Email confirmation on: `200` with a bare user object (`id`, `email`, `confirmation_sent_at`,
  `created_at`, `updated_at`, ...) and no tokens. Detect this by the absence of `access_token`.
- Duplicate email of an already confirmed user:
  - autoconfirm on: `422`, `error_code: "user_already_exists"`, `msg: "User already registered"`.
  - confirmation on: no error. A sanitized fake user is returned with `200` (random UUID, empty
    `identities`) so the response does not reveal the account exists. An empty `identities` array
    is the usual tell.
- Signups disabled: `422`, `signup_disabled`, "Signups not allowed for this instance".
- Empty password: `400`, `validation_failed`. Too weak: `weak_password` (status not checked in
  source here; supabase-js treats it as an `AuthWeakPasswordError`).

### Sign in: `POST /auth/v1/token?grant_type=password`

```json
{ "email": "a@example.com", "password": "secret" }
```

Success `200`, `AccessTokenResponse`:

```json
{
  "access_token": "<jwt>", "token_type": "bearer", "expires_in": 3600,
  "expires_at": 1764070000, "refresh_token": "<opaque>", "user": { "id": "...", "email": "..." }
}
```

(`provider_token`, `provider_refresh_token`, `weak_password` are omitted when empty.)

Errors (both `400`, built with `NewBadRequestError`, i.e. the HTTPError shape, not OAuth):
- wrong email or password, or no password set: `invalid_credentials`, "Invalid login credentials".
- email unconfirmed: `email_not_confirmed`, "Email not confirmed".

### Refresh: `POST /auth/v1/token?grant_type=refresh_token`

```json
{ "refresh_token": "<opaque>" }
```

Same `AccessTokenResponse` on success, with a new refresh token. Errors [src]:
- missing token: OAuth-style `invalid_request`, "refresh_token required".
- `refresh_token_not_found`, "Invalid Refresh Token: Refresh Token Not Found".
- `refresh_token_already_used`, "Invalid Refresh Token: Already Used".
- `session_not_found`, `session_expired`, `user_banned`.
- `409` conflict: "Too many concurrent token refresh requests on the same session or refresh
  token" (row lock retry loop gave up after about 5 s).

Treat any 4xx from refresh other than network/409 as "signed out".

### Sign out: `POST /auth/v1/logout?scope=global|local|others`

Headers `apikey` + `Authorization: Bearer <access_token>`. No body. Success `204 No Content`.
Default scope is `global` (all sessions of the user); `local` is this session only; any other value
is `400`. The access token JWT stays valid until it expires; only refresh tokens are revoked.

### Current user: `GET /auth/v1/user`

Headers `apikey` + `Authorization: Bearer <access_token>`. Returns the user object. Use it to
validate a stored token on startup.

Sources:
- https://github.com/supabase/auth/blob/master/README.md
- https://github.com/supabase/auth/blob/master/internal/api/signup.go [src]
- https://github.com/supabase/auth/blob/master/internal/api/token.go [src]
- https://github.com/supabase/auth/blob/master/internal/tokens/service.go [src]
- https://github.com/supabase/auth/blob/master/internal/api/logout.go [src]

## 3. Auth error shape

Two Go types, serialized as-is [src]:

```go
type HTTPError struct {
    HTTPStatus int    `json:"code"`                 // the HTTP status number
    ErrorCode  string `json:"error_code,omitempty"` // e.g. "invalid_credentials"
    Message    string `json:"msg"`
    ErrorID    string `json:"error_id,omitempty"`
}
type OAuthError struct {
    Err         string `json:"error"`
    Description string `json:"error_description,omitempty"`
}
```

So a legacy-shape error body is
`{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}`. OAuth errors
(always HTTP 400) look like `{"error":"invalid_request","error_description":"..."}`.

If the request sends `X-Supabase-Api-Version: 2024-01-01` (or later), HTTPErrors switch to
`{"code":"invalid_credentials","message":"..."}`: here `code` is the string error code [src,
`internal/api/errors.go`]. OAuth errors ignore the header.

A robust parser: `code = body.error_code ?? (typeof body.code === 'string' ? body.code : null) ?? body.error`,
`message = body.msg ?? body.message ?? body.error_description`. Branch on the code, never the message.

Relevant codes (from the error code table): `invalid_credentials`, `user_already_exists`,
`email_exists`, `email_not_confirmed`, `weak_password`, `signup_disabled`,
`refresh_token_not_found`, `refresh_token_already_used`, `over_request_rate_limit` (429).
General statuses: 403 feature unavailable, 422 cannot process in current state, 429 rate limit,
500 Auth degraded, 501 feature disabled.

Sources:
- https://supabase.com/docs/guides/auth/debugging/error-codes
- https://github.com/supabase/auth/blob/master/internal/api/apierrors/apierrors.go [src]
- https://github.com/supabase/auth/blob/master/internal/api/errors.go [src]

## 4. PostgREST RPC

```
POST /rest/v1/rpc/<function>
apikey: <publishable key>
Authorization: Bearer <access_token>
Content-Type: application/json

{ "arg_name": 1, "other_arg": "x" }
```

- Each JSON key maps to a named function parameter. A function with one unnamed `json`/`jsonb`
  parameter gets the whole body.
- Functions that do not modify the database can also be called with `GET` and query parameters.
- Scalar return: bare JSON value. Table/setof return: array of objects.
- Without `Authorization`, the request runs as role `anon`; with a user JWT, as `authenticated`,
  and `auth.uid()` reads the JWT `sub`.

### Error shape

```json
{ "code": "23502", "message": "null value in column ...", "details": "Failing row contains ...", "hint": null }
```

`code` is the Postgres SQLSTATE, or `PGRSTxxx` for PostgREST's own errors.

### SQLSTATE to HTTP status (selected)

| SQLSTATE | HTTP | Meaning |
|---|---|---|
| `P0001` | 400 | default for plain `RAISE EXCEPTION` |
| `23505` | 409 | unique violation |
| `23503` | 409 | foreign key violation |
| `42501` | 403 if authenticated, else 401 | insufficient privilege |
| `28*` | 403 | invalid auth specification |
| `PTxyz` | xyz | custom status, e.g. `PT409` gives 409 |

### Raising errors the client can detect

Plain custom message (400, `code: "P0001"`):

```sql
raise exception 'routine_name_taken' using detail = 'A routine with that name exists', hint = 'Pick another name';
```

Custom HTTP status via a `PT` SQLSTATE (this is the simple way to make an RPC return 409):

```sql
raise sqlstate 'PT409' using message = 'routine_name_taken', detail = '...', hint = '...';
-- HTTP 409, body {"code":"PT409","message":"routine_name_taken","details":"...","hint":"..."}
```

Full control of the body, status and headers via SQLSTATE `PGRST`, with JSON in message and detail:

```sql
raise sqlstate 'PGRST' using
  message = '{"code":"routine_name_taken","message":"Name taken","details":null,"hint":null}',
  detail  = '{"status":409,"headers":{}}';
```

If those JSON strings do not parse, PostgREST returns `PGRST121`. Alternatives: `errcode = '23505'`
also yields 409, but collides with genuine unique violations; a machine-readable token in `message`
(or a custom `code` via `PGRST`) is easier to branch on. Recommended: `PT409` / `PT4xx` for the
status, a stable snake_case token in `message` for the client.

Sources:
- https://docs.postgrest.org/en/stable/references/errors.html
- https://docs.postgrest.org/en/stable/references/api/functions.html

## 5. Refresh token rotation pitfalls

- Refresh tokens "never expire but can only be used once"; each refresh returns a new pair.
  Access tokens default to 1 hour (`expires_in: 3600`); below 5 minutes is discouraged.
- Reuse interval: a used token can be reused for 10 s by default ("we do not recommend changing
  this value"). Also, if the presented token is the parent of the session's currently active
  token, the server returns the active token (covers a lost response).
- Outside those exceptions, reuse is treated as theft: "the whole session is regarded as terminated
  and all refresh tokens belonging to it are marked as revoked." In the server this is
  `refresh_token_already_used` plus revocation of the token family (and the session is logged out
  on the v2 token path) [src].
- Two tabs: if both hold the same refresh token and refresh within 10 s, both succeed (server
  returns the current token). If tab B wakes later (a hidden tab, a laptop resume) with a token
  that tab A already rotated more than 10 s ago and that is not the active token's parent, the
  whole session is revoked and both tabs are signed out.
- Server concurrency: refresh locks the session rows (`FOR UPDATE`) and retries for about 5 s, then
  answers `409`; retry that once instead of signing out.
- What supabase-js does (as a reference design): since auth-js v2.107.0 it no longer takes
  `navigator.locks`. It deduplicates refreshes in-tab with a single-flight promise, relies on the
  server's parent-of-active rule across tabs, and re-reads storage after the fetch, discarding the
  rotated tokens if another tab already replaced them.

For a hand-rolled client:
1. Keep one in-flight refresh promise per tab.
2. Store the session in `localStorage` and, before refreshing, re-read it: if another tab already
   wrote a newer token, use it instead of refreshing.
3. After the fetch, if storage changed meanwhile, keep the stored session rather than overwriting.
4. Listen to the `storage` event (or a `BroadcastChannel`) so tabs pick up each other's tokens.
5. Optionally wrap the refresh in `navigator.locks.request('sb-refresh', ...)` for strict
   cross-tab serialization; it is a native API, no dependency.
6. Refresh proactively a little before `expires_at`, and on `visibilitychange` when a tab returns.

Sources:
- https://supabase.com/docs/guides/auth/sessions
- https://github.com/supabase/auth/blob/master/README.md (`GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED`, `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`)
- https://github.com/supabase/auth/blob/master/internal/tokens/service.go [src]
- https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/migrations/lockless-coordination.md

## Open points

- Exact HTTP status of `weak_password` and of the refresh-token errors was not confirmed from
  source here (they are built as bad-request errors, so 400 is expected); verify against a local
  `supabase start` before hard-coding.
