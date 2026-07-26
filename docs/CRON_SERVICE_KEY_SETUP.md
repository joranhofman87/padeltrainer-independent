# Cron → Edge Function auth: the service-role key (Supabase Vault)

Several `pg_cron` jobs invoke Edge Functions over HTTP (`net.http_post`) and must send the
**service-role key** as a `Bearer` token. This doc is the single source of truth for how that
key is provisioned. It supersedes the older `ALTER DATABASE ... SET app.settings.service_role_key`
instructions embedded in some migration comments — **that approach does not work on Supabase.**

## Why not `ALTER DATABASE ... SET`

Supabase's managed `postgres` role is not a superuser, so:

```sql
ALTER DATABASE postgres SET app.settings.service_role_key = '...';
-- ERROR: 42501: permission denied to set parameter "app.settings.service_role_key"
```

Any scheduler guarded on `current_setting('app.settings.service_role_key')` therefore reads
empty and silently skips — the cron job is never created.

## The working pattern: Supabase Vault

Store the key once in Vault and read it **at tick time** inside each cron command. No
`ALTER DATABASE`, no session reconnect, and rotation is a one-liner (the key is not baked into
the stored command).

### 1. Store the secret (once per project)

Use the **`service_role` key** from Dashboard → Project Settings → API → Project API keys — the
long **`eyJ…` JWT**, *not* a new-style `sb_secret_…` key. These functions run `verify_jwt = false`,
so the gateway does **not** verify the token — the legacy JWT is required because the function
itself does a **byte-exact** compare of the request's `Bearer` against its injected
`SUPABASE_SERVICE_ROLE_KEY` env (which is that same legacy JWT) in `requireServiceRole`. The new
`sb_secret_` keys live in `SUPABASE_SECRET_KEYS` and are sent via the `apikey` header; they do NOT
replace the service-role key and would fail this byte-exact check.

```sql
select vault.create_secret('PASTE_SERVICE_ROLE_JWT', 'service_role_key');
-- already exists? update it instead:
select vault.update_secret((select id from vault.secrets where name = 'service_role_key'), 'PASTE_SERVICE_ROLE_JWT');
```

### 2. Schedule (or let a migration schedule) the jobs

Cron commands read the key live from `vault.decrypted_secrets`:

```sql
perform cron.schedule('some-job', '*/15 * * * *', $cmd$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/<fn>',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
$cmd$);
```

Migration `20260722100000_rebook_crons_use_vault.sql` does exactly this for the two rebook
notifier crons and is idempotent — re-running it (or a fresh `db push` once the Vault secret
exists) reschedules them cleanly. On a DB with no `pg_cron` or no Vault secret it skips.

## Which crons depend on this key

| Cron job | Schedule | Needs the key? | Notes |
|---|---|---|---|
| `notification-email-worker` | `*/2 * * * *` | **Yes** | v2 email outbox drainer. Self-auth via `requireServiceRole`. |
| `notification-whatsapp-worker` | `*/2 * * * *` | **Yes** | v2 WhatsApp outbox drainer. Self-auth via `requireServiceRole`. |
| `notification-digest-worker` | *(not scheduled)* | **Yes** (when scheduled) | 10c-a3 digest worker — deployed but INERT; its cron is a gated 10c-b step. Same Vault-key path when enabled. |
| `notify-rebook-member-open` | `*/15 * * * *` | **Yes** | Rebook "sessions opened" email. No fallback. |
| `auto-rebook-reminder` | `0 6-19 * * *` | **Yes** | Rebook deadline reminder (daytime-only). No fallback. |
| `release-expired-rebook-holds` | `*/5 * * * *` | No | Pure SQL, self-schedules. |
| `release-expired-guest-slot-holds` | `*/5 * * * *` | No | Pure SQL, self-schedules. |
| `expire-lapsed-priority-claims` | `*/15 * * * *` | No | Pure SQL, self-schedules. |

**Payments observability** (lost-webhook detector, `reconcile_payments`, the 💓 heartbeat) does
**not** use `pg_cron` in production — it runs from the **Vercel cron** `/api/cron/daily-maintenance`
authenticated with `CRON_SECRET` + the Vercel `SUPABASE_SERVICE_ROLE_KEY` env var, independent of
Vault. Keep those two Vercel env vars set; the pg_cron `invoice-health-check-daily` is a redundant
legacy trigger.

## Verify

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Smoke-test a job without waiting for its tick (the reminder's `?force=1` also bypasses the
daytime window):

```sql
select net.http_post(
  url := 'https://<project-ref>.supabase.co/functions/v1/auto-rebook-reminder?force=1',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
  body := '{}'::jsonb
);
```

`net.http_post` is asynchronous — it returns a pg_net **request id**, not a result. Inspect the
actual response:

```sql
select id, status_code, content, error_msg, created
from net._http_response
where id = <the returned id>;
```

Expect `status_code = 200`. A `401` means the Vault secret isn't the correct service-role JWT.

## Key rotation

Rotating the service-role key = update the Vault secret only:

```sql
select vault.update_secret((select id from vault.secrets where name = 'service_role_key'), 'NEW_JWT');
```

No reschedule needed — cron commands read Vault live at tick time. (Also update the Vercel
`SUPABASE_SERVICE_ROLE_KEY` env var, which the payments cron uses independently.)

## ⏳ Deprecation deadline — migrate off the legacy service-role JWT (before end of 2026)

Supabase is **deprecating legacy `service_role` / `anon` JWT keys by the end of 2026**
([migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)). Every
Vault-backed cron→function path in this doc currently relies on the legacy `eyJ…` service-role JWT (the
function's `requireServiceRole` byte-exact-compares against `SUPABASE_SERVICE_ROLE_KEY` = that JWT). That must
move to a supported credential before the deadline or these crons will 401 and silently stop.

- **Owner:** platform owner (info@racketsportsoftware.com) — schedule a reviewed migration in 2026.
- **Scope:** all self-authenticating cron drainers — `notification-email-worker`, `notification-whatsapp-worker`,
  `notification-digest-worker`, `notify-rebook-member-open`, `auto-rebook-reminder` — plus any future one.
- **Exit condition:** neither the function's auth check nor the Vault cron secret depends on a legacy
  `service_role` JWT; auth uses a supported mechanism (a new `sb_secret_` key via `apikey`, or a dedicated
  named worker secret compared server-side), and `check-edge-fn-config.mjs` + this doc reflect the new model.
- **Verification:** for each worker, the authenticated Vault/pg_net smoke test still returns HTTP 200 (disabled
  → `{"status":"disabled"}`, or the expected send behaviour) with the NEW credential, and the legacy JWT is
  removed from Vault. Do not perform this migration piecemeal without owner approval — a wrong cutover 401s
  every cron drainer at once.
