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
long **`eyJ…` JWT**, *not* a new-style `sb_secret_…` key (the cron sends it as a `Bearer` token,
which must be a JWT so the Functions gateway's `verify_jwt` accepts it and the function's
byte-exact check matches its `SUPABASE_SERVICE_ROLE_KEY` env).

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
