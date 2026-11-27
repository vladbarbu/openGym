# Supabase patterns for offline-first per-row sync

Research notes for issue #20 (parent #18, blocks #21). Question: when openGym moves from one JSON
document per user (`put_state` / `get_state` in `supabase/migrations/20261125000000_opengym.sql`
on `dev`) to about 15 normalized tables, how should an offline-first client push and pull many
rows? Checked against primary sources on 2026-11-27. Each section lists its sources. Lines marked
**(inference)** are my reasoning from the quoted behaviour, not a statement in the docs.

## TL;DR

- Push with **one `security invoker` RPC** that takes a jsonb batch across all tables and writes
  it in one transaction. PostgREST bulk upsert is fine for a single table but cannot span tables
  atomically, and 15 tables means 15 requests.
- Pull with **one RPC** that returns every row with `rev > cursor`, across all tables, paged.
- The cursor is a **per-user `bigint` counter**, bumped by a trigger that row-locks the user's
  counter row. The lock serializes a user's writers, so rev order equals commit order and a pull
  never skips a row. Timestamps (`now()`) and global sequences do not have that property.
- Deletes are **`deleted_at` tombstones** carrying a `rev` like any edit, purged after a horizon by
  `pg_cron`. A client whose cursor is older than the horizon does a full pull.
- RLS: `user_id = (select auth.uid())`, `to authenticated`, an index starting with `user_id`
  (in practice `(user_id, rev)`).
- Limits to design around: `max_rows` 1000 (Supabase default), `statement_timeout` 8 s for
  `authenticated`, 16 KB URL. Request body limit is not documented.
- No offline-first library fits the "no new dependencies" rule. The pattern above is about two
  SQL functions, one trigger, and a small change to the existing `sync-merge.js` flow.

## 1. Bulk upsert through PostgREST

What PostgREST offers (`POST /rest/v1/<table>`):

- Bulk insert: "provide either a JSON array of objects having uniform keys". It "uses a single
  INSERT statement on the back-end for efficiency."
- Upsert: "`POST` and the `Prefer: resolution=merge-duplicates` header". "By default, upsert
  operates based on the primary key columns, so you must specify all of them."
  `Prefer: resolution=ignore-duplicates` skips existing rows instead.
- `on_conflict=<cols>`: "make upsert work on a column(s) that has a UNIQUE constraint."
- `columns=<list>`: names "the payload keys that will be inserted", and is "more efficient for
  Bulk Insert". `Prefer: missing=default` fills absent keys from column defaults ("Missing
  properties will be set to default values when applicable").
- Response: no body by default; `Prefer: return=representation` returns the affected rows (needed
  if the client wants the server-assigned `rev` back).
- Every request is one transaction ("every request to an API resource runs inside a
  transaction"), so one bulk upsert is all-or-nothing for that table.

Postgres rules that bite a sync batch:

- `ON CONFLICT DO UPDATE` "will not be allowed to affect any single existing row more than once; a
  cardinality violation error will be raised". The client must collapse its queue to one row per
  key before sending, or the whole statement fails.
- `DO UPDATE ... WHERE <condition>` updates only rows where the condition holds (all conflicting
  rows are still locked). That is how a "only if newer" or "only if base rev matches" guard is
  written. PostgREST does not expose that `WHERE`, so a guarded upsert needs an RPC.
- An `INSERT ... ON CONFLICT DO UPDATE` "may cause both insert and update operations, so it will
  fire both kinds of triggers as needed", and "the effects of all per-row BEFORE INSERT triggers
  are reflected in `excluded` values".

Verdict: good for a single table with plain last-write-wins. Not enough for openGym: no atomicity
across tables (a workout and its sets land in different requests), no conditional update, and one
round trip per table.

Sources: [PostgREST tables and views](https://docs.postgrest.org/en/v12/references/api/tables_views.html),
[PostgREST transactions](https://docs.postgrest.org/en/v12/references/transactions.html),
[Postgres INSERT](https://www.postgresql.org/docs/current/sql-insert.html),
[Postgres CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html).

## 2. One RPC taking a jsonb batch across tables

PostgREST facts:

- Functions are called with `POST /rpc/<fn>`; "each key becomes a function argument". A function
  with one unnamed `json`/`jsonb` parameter receives the whole body.
- For bulk work the docs suggest a `jsonb` parameter holding an array and looping with
  `jsonb_array_elements`, which "can reduce the number of HTTP requests".
- "only VOLATILE functions called with POST get read-write access"; GET runs read-only.
- The call is one transaction, so every table in the batch commits or none does.
- "Whenever you create or change a function you must refresh PostgREST's schema cache" (Supabase
  migrations do this; a hand edit needs `NOTIFY pgrst, 'reload schema'`).

Supabase facts:

- "Prefer `security invoker`, which is also the default." A definer function owned by `postgres`
  "bypasses Row Level Security" and "can return rows the caller isn't allowed to read". With
  `security invoker`, RLS on each table still guards every row the batch touches. Today's
  `put_state` is `security definer`; the per-row version does not need to be.
- "When you use `security definer`, you must set the `search_path`." Setting `search_path = ''`
  on invoker functions too, as the current migration does, costs nothing.

Shape that fits openGym (sketch, not tested):

```sql
-- body: {"changes": {"workouts": [{...}], "sets": [{...}], ...}}
create function public.sync_push(changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare r jsonb; conflicts jsonb := '[]';
begin
  -- one block per table, from a fixed list: never build SQL from a client-sent table name
  for r in select * from jsonb_array_elements(coalesce(changes -> 'workouts', '[]')) loop
    insert into public.workouts as t (id, user_id, data, deleted_at)
    values ((r->>'id')::uuid, (select auth.uid()), r->'data', (r->>'deleted_at')::timestamptz)
    on conflict (id) do update
      set data = excluded.data, deleted_at = excluded.deleted_at
      where t.rev = (r->>'base_rev')::bigint;          -- compare-and-set per row
    if not found then
      conflicts := conflicts || (select to_jsonb(w) from public.workouts w where w.id = (r->>'id')::uuid);
    end if;
  end loop;
  -- ... same for the other tables ...
  return jsonb_build_object('conflicts', conflicts);
end $$;
```

Row-by-row loops are simple; a set-based `insert ... select from jsonb_to_recordset(...)` per
table is faster for a big first upload. Conflicting rows come back to the client, which merges
them with the existing field stamps (`_f`, `mergeEntry` in `frontend/src/lib/sync-merge.js`) and
retries: the same 409 loop as today, but per row instead of per document **(inference)**.

Sources: [PostgREST functions](https://docs.postgrest.org/en/v12/references/api/functions.html),
[PostgREST transactions](https://docs.postgrest.org/en/v12/references/transactions.html),
[Supabase database functions](https://supabase.com/docs/guides/database/functions).

## 3. The change cursor for "everything since X"

The hard requirement: if a pull returns cursor C, no row that later becomes visible may carry a
cursor value at or below C. Otherwise that row is silently never pulled.

### `updated_at` set by trigger

- `now()` / `current_timestamp` return "the start time of the current transaction", and "their
  values do not change during the transaction." `clock_timestamp()` is wall time at the call.
- Pitfall **(inference)**: transaction A starts at 10:00:00.100, transaction B at 10:00:00.200.
  B commits first; a pull at 10:00:00.300 sees B and sets cursor = .200. A then commits with
  `updated_at` = .100 and is never pulled. `clock_timestamp()` only narrows the window: the stamp
  is still taken before commit.
- Equal timestamps need a tiebreaker (`(updated_at, id)`), which is what RxDB's checkpoint does.
- Clock skew: only server time may be a cursor. WatermelonDB's backend guide: "never trust local
  timestamps". Device times stay what they are today, merge stamps, not cursors.
- WatermelonDB's guide works around the same race by asking the pull to run "synchronously or in a
  write lock", or to return a timestamp taken before querying starts.

### A global `bigint` sequence

- `nextval` is "not reclaimed for re-use if the calling transaction later aborts", so there are
  gaps (harmless for a cursor). Values follow call order, not commit order, so the same race as
  timestamps applies **(inference)**.

### `xid8` / snapshots

- `pg_current_xact_id()` returns the transaction's 64-bit id; `xid8` "does not wrap around during
  the life of an installation". `pg_current_snapshot()` gives `xmin:xmax:xip_list`, where "All
  transaction IDs less than xmin are either committed and visible, or rolled back and dead."
- Pattern **(inference)**: store `pg_current_xact_id()` on each written row, and have the pull
  return only rows with `xid < pg_snapshot_xmin(pg_current_snapshot())`, with that xmin as the
  next cursor. Correct across all users with no lock, but the pull lags behind any long-running
  transaction in the cluster, and the cursor exposes cluster-wide transaction ids.

### A per-user counter behind a row lock (recommended)

- "Row-level locks are released at transaction end", and a second `UPDATE` of a locked row "waits
  for the transaction that acquired the lock to complete."
- So **(inference)**: keep `opengym_private.sync_clock(user_id uuid primary key, seq bigint)`. A
  `BEFORE INSERT OR UPDATE` trigger on each synced table runs
  `update opengym_private.sync_clock set seq = seq + 1 where user_id = new.user_id returning seq into new.rev`.
  The second writer for the same user blocks on that row until the first commits, then reads the
  committed `seq`. Per user, rev order is commit order, and `where user_id = me and rev > C` can
  never skip a row.
- The trigger function is `security definer` (it touches a private table) with `search_path = ''`;
  that is the one place definer is needed.
- Cost: two devices of the same user writing at the same moment wait for each other for the length
  of a transaction. Other users are untouched. The current `put_state` already serializes per user
  the same way (`perform 1 from auth.users where id = caller for no key update`).
- An upsert that hits a conflict fires both BEFORE INSERT and BEFORE UPDATE, so it bumps the
  counter twice. Gaps are harmless.
- The pull RPC should also return the user's current `seq`, so a client with nothing to pull still
  learns where it stands.

Sources: [Postgres date/time functions](https://www.postgresql.org/docs/current/functions-datetime.html),
[Postgres sequence functions](https://www.postgresql.org/docs/current/functions-sequence.html),
[Postgres system information functions](https://www.postgresql.org/docs/current/functions-info.html),
[Postgres explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html),
[WatermelonDB sync backend](https://watermelondb.dev/docs/Sync/Backend),
[RxDB Supabase replication](https://rxdb.info/replication-supabase.html).

## 4. `deleted_at` tombstones and cleanup

- A hard-deleted row cannot be pulled, so other devices never learn it is gone. Every library
  below says the same: RxDB ("rows should not be hard-deleted"), Legend-State (soft delete because
  Supabase cannot list deleted rows), WatermelonDB (soft delete flag or a `deleted_xxx` table).
- A delete is an update that sets `deleted_at = now()` and clears the payload; the trigger gives it
  a new `rev`, so it flows through the same pull.
- Read paths that are not sync (leaderboard, coach, MCP) must filter `deleted_at is null`. A
  partial index `where deleted_at is null` keeps those queries off the tombstones.
- Cleanup **(inference)**: a nightly `pg_cron` job deletes tombstones older than a horizon (for
  example 90 days) and records the highest purged rev per user (`sync_clock.purged_rev`). A pull
  with `since < purged_rev` answers "resync" and the client does a full pull, then re-applies its
  own queue. This matches today's behaviour for a device that has been away a long time.
- WatermelonDB also notes revoked access should be reported as a deletion; for openGym that only
  matters for shared data (groups), not a user's own rows.

Sources: [RxDB Supabase replication](https://rxdb.info/replication-supabase.html),
[Legend-State Supabase](https://legendapp.com/open-source/state/v3/sync/supabase/),
[WatermelonDB sync backend](https://watermelondb.dev/docs/Sync/Backend),
[Supabase Cron](https://supabase.com/docs/guides/cron).

## 5. RLS cost on large tables

- "Add an index on every column your policies filter on"; a column counts as indexed only when it
  comes first in a btree index.
- Wrap auth calls: `(select auth.uid())` makes the planner run an `initPlan` once per statement
  instead of calling the function per row. Only valid when the result does not depend on the row,
  which holds for `auth.uid()`.
- "Always name the role a policy applies to, using the `to` clause" (`to authenticated`), so the
  policy is not evaluated for `anon`.
- Add the filter in the query too (`user_id = ...` in the RPC, not only in the policy): "Postgres
  can use the filter to construct a better query plan."
- Avoid joins in policies; give every synced table its own `user_id`, even child tables like sets,
  so no policy has to join to the parent workout **(inference from the "avoid a join" advice)**.
- The guide's own example: a seq scan under RLS took 171 ms with "Rows Removed by Filter: 100000";
  an index scan took 0.046 ms. Not a controlled before/after, but the order of magnitude is clear.

Policy and index per table:

```sql
create policy own_rows on public.workouts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create index on public.workouts (user_id, rev);   -- serves both RLS and "rev > cursor"
```

Sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Supabase RLS performance](https://supabase.com/docs/guides/database/postgres/row-level-security-performance).

## 6. Request and row limits

| Limit | Value | Source |
|---|---|---|
| Rows returned (`max_rows`) | 1000 by default on Supabase; caps rows "from a view, table, or function" | [CLI config](https://supabase.com/docs/guides/local-development/cli/config), [PostgREST config `db-max-rows`](https://docs.postgrest.org/en/v12/references/configuration.html) |
| `statement_timeout` | `anon` 3 s, `authenticated` 8 s; Data API max configurable 60 s | [Supabase timeouts](https://supabase.com/docs/guides/database/postgres/timeouts) |
| Per-function timeout | `set statement_timeout to '...'` on the function "works with the Database REST API" | same |
| URL length | 16 KB, then a 520 (long `in` filters) | [Supabase 520 troubleshooting](https://supabase.com/docs/guides/troubleshooting/fixing-520-errors-in-the-database-rest-api-Ur5-B2) |
| Request body | Not documented by PostgREST or Supabase. Do not rely on any number; chunk instead. | (searched, none found) |
| Pool wait | `db-pool-acquisition-timeout` 10 s by default | PostgREST config |

What this means for the design **(inference)**:

- A pull RPC that returns one `jsonb` value is one row, so `max_rows` does not cut it; but it should
  still page itself (`limit` per call, `more: true`) to stay well inside 8 s and a sane response
  size. Page by `rev`, not by table, so one cursor covers all tables.
- Push in chunks (a few hundred rows) and send the next chunk only after the previous one commits;
  a first sync of years of history is then many small transactions, each under the timeout.
- Pull by cursor in the request body (POST), never with long id lists in the URL.

## 7. Offline-first libraries that work with Supabase

| Library | What it is | Fit for openGym |
|---|---|---|
| [PowerSync](https://docs.powersync.com/integration-guides/supabase-+-powersync) | Sync service reading Postgres by logical replication into a client SQLite; writes go back through an `uploadData()` you write against PostgREST. Service is [Apache-2.0](https://github.com/powersync-ja/powersync-service), self-hostable from Docker. | Poor: a third container plus a wasm SQLite client SDK; replaces the Zustand state model. |
| [ElectricSQL](https://electric.ax/docs/guides/writes) | Read-path sync of "shapes" from Postgres over HTTP; "Electric does not do write-path sync". | Poor: another server to run, and it solves only the pull half. |
| [RxDB Supabase replication](https://rxdb.info/replication-supabase.html) | `rxdb` + `@supabase/supabase-js`; needs `_modified` (trigger) and `_deleted` columns; pulls by `(modified, id)` checkpoint, plus Realtime. | Poor: two large dependencies and a new local database; its timestamp checkpoint has the commit-order gap from section 3. |
| [WatermelonDB](https://watermelondb.dev/docs/Sync/Backend) | Local DB (SQLite / LokiJS) with a pull/push protocol; you build the backend endpoints. | Poor: a whole database layer; useful only as a well-written protocol spec. |
| [Legend-State](https://legendapp.com/open-source/state/v3/sync/supabase/) | Observable state with a Supabase plugin; `changesSince: 'last-sync'` on `updated_at`, soft delete via `fieldDeleted`, local persistence. | Poor: replaces Zustand and pulls in supabase-js; same `updated_at` cursor gap. |

None fits a project that treats new dependencies as a hard sell, and all of them would replace
code openGym already has (the store, the queue, the field-level merge). What is worth taking from
them is the protocol: tombstones, a server cursor, a transactional push, a full-resync escape.

## 8. Recommendation

Keep plain `fetch` and the existing store; add two RPCs and one trigger:

1. Every synced table gets `user_id`, `rev bigint not null`, `deleted_at timestamptz`, the
   `own_rows` policy, and an index on `(user_id, rev)`.
2. `opengym_private.sync_clock(user_id, seq, purged_rev)` and a `BEFORE INSERT OR UPDATE` trigger
   on each table that bumps `seq` under the row lock and writes it to `new.rev`. This is the cursor;
   do not use `updated_at` or a global sequence for it.
3. `sync_push(changes jsonb)`: `security invoker`, volatile, one transaction for the whole batch,
   per-row compare-and-set on `base_rev`, returns `{revs, conflicts}`. The client merges conflicts
   with `sync-merge.js` field stamps and retries, as it does with the 409 today.
4. `sync_pull(since bigint, lim int)`: `security invoker`, stable, returns
   `{rows: {table: [...]}, cursor, more}` or `{resync: true}` when `since < purged_rev`.
5. Revoke direct `insert/update/delete` on synced tables from `authenticated` so every write goes
   through `sync_push` (the trigger would still keep the cursor correct if a direct PostgREST
   upsert slipped through, but conflict checks would not run).
6. Nightly `pg_cron` purge of tombstones older than 90 days, bumping `purged_rev`.

Upgrade path if per-user locking ever shows up as contention (it should not for one person with a
few devices): switch the cursor to the `xid8` snapshot pattern in section 3, which needs no lock.
