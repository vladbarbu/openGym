# Running openGym on Supabase

The web app can run without the Node `api` container, on Supabase Auth and Postgres instead. A
build gets that backend when `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` (the project's
publishable key) are set. Without them nothing changes, and the self-hosted build works as before.

What the Supabase build has: sign-in with e-mail and password or a passkey, your profile synced
across devices (the iPhone and Android apps sign in directly, no pairing), workout logging, the
friends leaderboard with groups and invite codes, photo and video uploads, web push
notifications, the AI coach with your own key, and the admin pages. What it leaves out:
integrations, trainers, the community library, sign-in with OIDC, the coach running on a server,
API tokens and the MCP server. Passkeys are web only for now.

## How it works

- `frontend/src/lib/supabase.js` answers the `/api/...` calls the app makes (`api()` in
  `lib/api.js` hands them over), using plain `fetch` against Supabase Auth and PostgREST.
- `supabase/migrations/` holds the schema. There is one `app_state` row per profile (the same
  synced document as `state-<uid>.json`). `put_state` compares the revision and answers a stale
  write with a 409 and the current document, which the app merges as usual.
- Raw documents are private to their owner (row-level security). The `leaderboard()` function
  returns only the ranking fields of the caller's group, and the groups have their own invite
  codes.

## Local

Needs Docker and the Supabase CLI.

```bash
supabase start                     # in the repo root; API on http://127.0.0.1:56421
cd frontend && npm run dev:supabase
node supabase/tests/leaderboard-parity.mjs   # SQL scoring against api/leaderboard.js, plus access checks
```

`frontend/.env.supabase` points the dev server at the local stack. The ports are moved to 564xx
in `supabase/config.toml` so they don't clash with other local Supabase projects.

## Hosted project

```bash
supabase link --project-ref <ref>
supabase db push
```

Then build with the project's URL and publishable key, for example in
`frontend/.env.supabase.local` (git-ignored): `npm run build:supabase`. In the dashboard, set the
site URL and redirect URLs under Auth. Whether sign-up needs a confirmed e-mail is your choice.
With confirmation on, a new profile is asked to confirm before signing in.

## Passkeys, uploads, the coach and the admin pages

- **Passkeys** use Supabase Auth's passkey API (`frontend/src/lib/supabase-passkeys.js`). Turn
  them on under Auth in the dashboard and set the relying party to your app's host name and
  origin (locally `[auth.passkey]` and `[auth.webauthn]` in `supabase/config.toml`). A profile is
  created with e-mail and password first, then adds a passkey in Settings.
- **Uploads** go to the private Storage bucket `media`, one folder per profile, with the same
  limits and 200 MB quota as the Node server (`supabase-media.js`, the media migration).
- **The coach** runs in the browser with your own provider key or an OpenRouter sign-in. The
  key stays on the device.
- **The admin pages** read `profiles.role`. The first profile is the owner. Disabling, deleting
  and password resets go through the Edge Function `admin`: deploy it with
  `supabase functions deploy admin`. For invite-only sign-up, enable the hook
  `public.before_user_created_admin` under Authentication, Hooks, Before User Created.

## Notifications

Web Push supports rest timers, workout reminders, missed-workout nudges, check-in reminders,
monthly leaderboard recaps, and Wrapped. Open the web app over HTTPS and turn on push in
**Settings → Notifications**. The iPhone and Android apps use local notifications.

Generate a VAPID key pair once, for example with `npx web-push generate-vapid-keys`. Set
`VITE_VAPID_PUBLIC_KEY` to the public key in `frontend/.env.supabase.local` or in the hosted
web build's environment. The build only needs the public key.

For the hosted project, apply the push migration with `supabase db push --remote`. Set these
Edge Function secrets in the dashboard or with `supabase secrets set --env-file <file>`:

- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` from the same key pair
- `VAPID_SUBJECT` with a contact address such as `mailto:you@example.com`
- `PUSH_CRON_SECRET` with a random value such as the output of `openssl rand -hex 32`

Deploy from the repository root with `supabase functions deploy push --use-api`. The API
bundler includes the notification rules and copy shared with the Node server.

In Supabase Vault, create `push_function_url` with the full function URL and `push_cron_secret`
with the same value as `PUSH_CRON_SECRET`. Use `https://<ref>.supabase.co/functions/v1/push`
on the hosted project. The database calls this URL every 10 seconds, so a rest alert can take
up to one tick to reach the push service after its timer ends.

Locally, put the Edge Function secrets in `supabase/functions/.env` and run
`supabase functions serve push --env-file supabase/functions/.env`. Set the same two Vault
entries in the local database, using `http://supabase_kong_opengym:8000/functions/v1/push`
for the URL. A local HTTP catcher can be used for smoke tests by adding its exact URL as
`push_test_endpoint` in local Vault and removing that entry after testing.

## Phones

From `frontend/`, run `npm run build:mobile:supabase`. The build reads
`.env.supabase` and `.env.supabase.local` and syncs the iPhone and Android projects.
On the phone, sign in with the same e-mail and password you use on the web.

In the hosted project, add `capacitor://localhost` (iPhone) and `https://localhost`
(Android) under Auth → URL Configuration → Redirect URLs. The API gateway already
allows cross-origin API requests. If you put a proxy with an origin allowlist in
front of it, allow both origins there too.

`127.0.0.1` on a phone means the phone itself. Use your hosted Supabase URL or the
Mac's LAN IP and the local Supabase API port for testing.
