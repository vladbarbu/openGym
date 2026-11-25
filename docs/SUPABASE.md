# Running openGym on Supabase

The web app can run without the Node `api` container, on Supabase Auth and Postgres instead. A
build gets that backend when `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` (the project's
publishable key) are set. Without them nothing changes, and the self-hosted build works as before.

What the Supabase build has: sign-in with e-mail and password, your profile synced across
devices, workout logging, and the friends leaderboard with groups and invite codes. What it
leaves out for now: passkeys, phone pairing, push notifications, the coach, uploads,
integrations, trainers and the admin pages.

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
