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
`ALTER DATABASE`, no session reconnect, and **updating the Vault copy** is a one-liner (the key is not baked
into the stored command). Note this is only the Vault *copy* — a genuine credential change is not a Vault-only
operation (the function env, Vercel, and code may need to move too); see **Credential procedures** below.

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

### Also key-dependent: the two Vercel crons (NOT pg_cron, NOT Vault)

`vercel.json` schedules **two** Vercel crons, and **both** call edge functions via `invokeEdgeFunction`
(`api/_lib/cron.ts`), which sends the Vercel **`SUPABASE_SERVICE_ROLE_KEY`** env var (the same legacy JWT) as
BOTH `apikey` and `Authorization: Bearer`. They read the **Vercel env**, not Vault — so an emergency credential
change must update Vercel + redeploy AND pause/gate these, not only the pg_cron jobs.

| Vercel cron | Schedule | Sends? | Invokes |
|---|---|---|---|
| `/api/cron/daily-emails` | `0 12 * * *` | **Yes** | `process-onboarding-emails`, `send-digest-emails` |
| `/api/cron/daily-maintenance` | `0 6 * * *` | **Yes** (+ maintenance) | payments observability (lost-webhook detector, `reconcile_payments`, 💓 heartbeat) + other jobs |

Each is gated by `CRON_SECRET` (proves the caller is Vercel) — that is NOT a Supabase-auth kill switch, so an
invocation still runs with whatever `SUPABASE_SERVICE_ROLE_KEY` Vercel holds. The pg_cron `invoice-health-check-
daily` is a redundant legacy trigger.

## Verify — which endpoints are SAFE to probe

List the jobs first:

```sql
select jobname, schedule, active from cron.job order by jobname;
```

> ⚠️ **Most drainers SEND on invocation — never use a live worker as an auth health check.** An authenticated
> call to `notification-email-worker` claims + sends pending rows (no kill switch); `auto-rebook-reminder`
> (esp. `?force=1`, which bypasses the daytime window) and `notify-rebook-member-open` send real emails. Do NOT
> invoke these to "test the key" — you will send real customer email.

**Side-effect-free auth probe (today):** only a worker whose SEND is switched OFF is safe to invoke as an
authentication check — its disabled branch returns `200` before claiming/sending, with zero DB writes:

| Endpoint | Safe auth-only probe? | Why |
|---|---|---|
| `notification-digest-worker` | **Yes, when `DIGEST_SEND_ENABLED` ≠ `"true"`** | disabled → `200 {"status":"disabled"}`, zero DB |
| `notification-whatsapp-worker` | **Yes, when `WHATSAPP_SEND_ENABLED` ≠ `"true"`** | returns before claiming |
| `notification-email-worker` | **No** | no kill switch — invoking it SENDS |
| `auto-rebook-reminder`, `notify-rebook-member-open` | **No** | invoking them SENDS (force bypasses quiet hours) |

Probe the Vault key with a switched-off worker (async — `net.http_post` returns a pg_net **request id**):

```sql
select net.http_post(
  url := 'https://<project-ref>.supabase.co/functions/v1/notification-digest-worker',  -- DIGEST_SEND_ENABLED off
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
  body := '{}'::jsonb
);
-- then inspect the response (status + body only):
select id, status_code, content, error_msg, created from net._http_response where id = <the returned id>;
```

Expect `status_code = 200` with `{"status":"disabled","reason":"disabled"}`. A `401` means the Vault secret
isn't the key the function's `requireServiceRole` expects. **The senders above have NO safe probe** — a reviewed
auth-only / dry-run mode must be added to each before it can be smoke-tested; until then, verify the shared Vault
key via a switched-off worker and trust that the senders use the same key + auth path.

## Credential procedures — two DISTINCT paths, never conflated

There is **no routine "rotate the service-role key" operation**. Legacy `service_role`/`anon` JWTs cannot be
issued/rotated individually
([guidance](https://supabase.com/docs/guides/troubleshooting/rotating-anon-service-and-jwt-secrets-1Jq6yd)).
Only two real scenarios exist, and they are **implemented differently** — do not run one as the other:

- **A — Emergency (the legacy JWT secret is compromised):** rotate the shared JWT secret; you stay on the SAME
  legacy-JWT mechanism (a new `eyJ…` value), and you re-sync it everywhere. See below.
- **B — Planned migration off the legacy JWT (before end-2026):** move to a supported new-key mechanism. This is
  **not a key swap** — it requires CODE changes (different env source + `apikey` transport) and a blocking
  per-worker probe prerequisite. See `## ⏳ Deprecation` below.

### A. Emergency: the legacy JWT secret is compromised

**0. PREFLIGHT — is a legacy-secret rotation even available for this project? (do this FIRST).** Supabase's
current guidance is that a project **not migrated to the new JWT signing-key system can no longer rotate its
legacy `anon`/`service_role` secret**
([guidance](https://supabase.com/docs/guides/troubleshooting/rotating-anon-service-and-jwt-secrets-1Jq6yd)).
Check the project's signing-key state (Dashboard → **Authentication → JWT Keys / Signing Keys**). **If legacy
rotation is unavailable, STOP — the steps below do not exist for you.** Treat the compromise as forcing the
**Path B migration** to new `sb_secret_` keys on an emergency timeline, and follow Supabase's official
incident / new-API-key process. Only if legacy rotation IS available do the remaining steps apply.

Rotating the project's **shared JWT secret** re-signs a **new legacy `service_role` JWT** and **invalidates the
old anon/service keys AND every active user session at once** — a break-everything action, owner-directed only,
downtime expected. It keeps the existing mechanism (legacy JWT via `Authorization: Bearer`, byte-exact-checked
in `requireServiceRole`); you re-sync the NEW legacy JWT to every holder. Do NOT print the value at any step.

1. **Pause EVERY dependent caller FIRST — pg_cron AND both Vercel crons** (a caller left running with the old
   key while the secret is invalidated will 401 and, for a sender, silently drop customer messages):
   - **pg_cron** — pause the expected set, then assert all-inactive + none mid-run, for those job IDs only
     (adjust the expected set when the digest cron or any new drainer is added):

     ```sql
     SELECT cron.alter_job(jobid, active := false)
       FROM cron.job
      WHERE jobname IN ('notification-email-worker','notification-whatsapp-worker','notify-rebook-member-open','auto-rebook-reminder');

     -- assert: exactly the 4 expected jobs exist AND all are inactive (both must equal the expected count)
     SELECT count(*) AS expected_present, count(*) FILTER (WHERE NOT active) AS inactive
       FROM cron.job
      WHERE jobname IN ('notification-email-worker','notification-whatsapp-worker','notify-rebook-member-open','auto-rebook-reminder');
     -- expect expected_present = 4 AND inactive = 4

     -- assert: no RUNNING execution for THOSE jobs only (global 'running' would include unrelated jobs)
     SELECT d.jobid, j.jobname, d.status, d.start_time
       FROM cron.job_run_details d JOIN cron.job j USING (jobid)
      WHERE d.status = 'running'
        AND j.jobname IN ('notification-email-worker','notification-whatsapp-worker','notify-rebook-member-open','auto-rebook-reminder');
     -- expect ZERO rows
     ```
   - **Vercel crons** — `/api/cron/daily-emails` and `/api/cron/daily-maintenance` (see the Vercel-cron
     inventory) cannot be `cron.alter_job`'d. Disable both in the **Vercel dashboard → Project → Settings →
     Crons** (or remove them from `vercel.json` and redeploy) **before** invalidating the old credential.
2. **Re-sync the new legacy JWT everywhere it is held** (still `SUPABASE_SERVICE_ROLE_KEY` / the Vault
   `service_role_key`):
   - **Vault:** `select vault.update_secret((select id from vault.secrets where name='service_role_key'), 'NEW_LEGACY_JWT');`
   - **Vercel:** update the `SUPABASE_SERVICE_ROLE_KEY` env var **and then redeploy / promote production** — a
     Vercel env change applies **only to new deployments**, so production keeps the old value until redeployed
     ([Vercel env docs](https://vercel.com/docs/environment-variables/managing-environment-variables)).
   - **Function env:** the edge runtime re-injects `SUPABASE_SERVICE_ROLE_KEY` automatically; redeploy the
     functions only if a redeploy is needed to pick up the new value.
3. **Verify SAFELY — TWO separate paths, neither may send:**
   - **Vault → function:** the switched-off-worker probe from `## Verify` → `HTTP 200`. This proves ONLY the
     `Vault → digest worker` path.
   - **Vercel → function:** the Vault probe does **not** prove the redeployed Vercel deployment can
     authenticate, and **both Vercel crons SEND on invocation** — so there is **no side-effect-free way to
     smoke-test the Vercel path today.** ⚠️ **BLOCKING RUNTIME PREREQUISITE:** a reviewed **Vercel-side no-send
     auth probe** must be added before Vercel recovery can be verified. Until it exists, **never invoke
     `/api/cron/daily-emails` or `/api/cron/daily-maintenance` to "test the key"** (you will send real customer
     email); instead confirm out-of-band that the redeploy picked up the new env, and watch the first scheduled
     run for auth errors.
4. **Resume** pg_cron with `cron.alter_job(jobid, active := true)` after its safe probe passes; re-enable the
   Vercel crons only after the Vercel env change is confirmed. **Any 401 → keep everything paused, fix forward.**
   Do not declare recovery complete, and do not claim that updating Vault alone re-synced the key.

## ⏳ B. Planned migration off the legacy JWT (before end of 2026)

Supabase is **deprecating legacy `service_role` / `anon` JWT keys by the end of 2026**
([migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)). Every
Vault-backed cron→function path here relies on the legacy `eyJ…` service-role JWT (checked byte-exact against
`SUPABASE_SERVICE_ROLE_KEY`). **This is NOT a key swap** — the new keys are a different mechanism, so it needs
CODE changes, not just a Vault/Vercel value update. `SUPABASE_SERVICE_ROLE_KEY` stays the legacy JWT; the new
`sb_secret_` key is exposed as `SUPABASE_SECRET_KEYS` and must be sent via the **`apikey`** header, not
`Authorization: Bearer`
([pg_net requirement](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys#database-webhooks-and-pg_net)).

- **Owner:** platform owner (info@racketsportsoftware.com) — a reviewed migration in 2026 (not piecemeal; a
  wrong cutover 401s every drainer at once).
- **Required implementation changes (all before disabling the legacy key):**
  1. **Function auth:** change each worker's check to accept the new key — read `SUPABASE_SECRET_KEYS` (or a
     dedicated named worker secret), not `SUPABASE_SERVICE_ROLE_KEY`. Note the auth is **not shared today**:
     `notification-email/whatsapp/digest-worker` use `requireServiceRole`
     (`supabase/functions/_shared/service-role-auth.ts`), but `notify-rebook-member-open` / `auto-rebook-reminder`
     have their **own inline `Bearer` comparisons** — every path must be updated.
  2. **pg_net cron commands:** send the new key via the **`apikey`** header (not `Authorization: Bearer`); update
     `20260722100000_rebook_crons_use_vault.sql` and any digest cron.
  3. **Vercel caller + env contract:** the Vercel cron helper (`api/_lib/cron.ts`) currently sends the legacy
     service-role key; move it (and the `SUPABASE_SERVICE_ROLE_KEY` env it reads) to the new mechanism and
     redeploy production.
  4. **Deploy all of the above**, then verify (below), then **disable/remove the legacy JWT LAST**.
- **BLOCKING PREREQUISITE (do not start the cutover until this exists):** because the auth paths are not shared,
  **every live sender must gain a reviewed side-effect-free auth-only probe** (a mode that authenticates and
  returns 200 **without** sending), OR all workers must be routed through **one genuinely shared, tested auth
  boundary**. One disabled `notification-digest-worker` invocation proves only its own path — it cannot authorize
  resuming `notification-email-worker` or the rebook workers after their auth changes.
- **Verification (never sends):** each worker's **side-effect-free auth-only probe** returns `HTTP 200` with the
  NEW credential; the legacy JWT is then removed from Vault + Vercel. Verification MUST NOT invoke a live sender
  or accept "expected send behaviour" — no customer message is sent to prove auth.
- **Exit condition:** no function auth check and no cron/Vercel credential depends on a legacy `service_role`
  JWT; `check-edge-fn-config.mjs` + this doc reflect the new model.
