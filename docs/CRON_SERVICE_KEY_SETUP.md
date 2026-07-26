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
| `invoice-health-check-daily` | `0 6 * * *` | **Yes** (legacy) | Redundant duplicate of the Vercel maintenance job; posts to `invoice-health-check` with a `Bearer` from the old `sr_key` path. Pause/unschedule in an emergency. |
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
invocation still runs with whatever `SUPABASE_SERVICE_ROLE_KEY` Vercel holds. The pg_cron
`invoice-health-check-daily` is a **redundant legacy trigger wired to send the key via the dead pre-Vault
`app.settings` path** (it posts to the `invoice-health-check` function with a `Bearer` from `sr_key`, which reads
**empty** on Supabase → an inert/dead token, not a live key). Pausing it in an emergency is therefore *defensive*;
(preferably) unschedule it as the duplicate it is.

## The legacy service-role-key dependency class (full inventory)

The cron tables above are only the **inbound-auth** slice. Deactivating the legacy `service_role` JWT (Path B, or
an emergency) breaks a **much larger class**: of the **116 registered consumers**, **98 are runtime** (the other
18 are `scripts-ci` + test fixtures), and of those **81 use the key *internally* to build a privileged
(RLS-bypassing) supabase-js admin client** — every one **500s** the moment the legacy key is turned off. The
other 17 runtime consumers split by *how* they fail: the inbound-auth / downstream-caller / vercel ones **401 /
lose the invoked call**, while several `via-shared-helper` members (e.g. `notification-digest-worker`,
`backup-database`, `invoice-storage-gc`) *also* build an admin client and **500** like their literal peers (the
"admin-client wins" rule below). Either way, a migration that only fixed the cron→function auth would leave the
admin-client class broken. So the inventory below — not just the drainers — is what Path B must migrate or prove.

This inventory is **machine-checked and self-enforcing**, not a hand-list that rots. `npm run check:legacy-key`
(`scripts/check-legacy-service-role-consumers.mjs`, a CI gate) runs **three checks**:

1. **Source consumers** — content-scans `supabase/functions`, `api`, `scripts` (a content scan, *not* an
   extension allow-list) and fails on any file referencing the key — under **any `*_SERVICE_ROLE_KEY` name** (not
   just the `SUPABASE_` literal — the storage scripts read `SOURCE_`/`TARGET_SERVICE_ROLE_KEY`), **directly OR via
   a shared service-role helper** (`requireServiceRole` / `getEnvServiceRoleKey` / `isServiceRoleRequest` /
   `resolveServiceRoleToken` / an import of `_shared/service-role-auth`) — that is not in the categorized registry
   (or a registered file that no longer does). The biggest live consumers (`notification-digest-worker`,
   `backup-database`, `twilio-content-admin`) carry **no literal at all**, so the helper signal is essential.
2. **SQL/Vault consumers** — scans `supabase/migrations` for cron commands that SEND the key (`net.http_post` + a
   service_role key) or STORE it in Vault, against a **second registry** (`MANAGED_SQL`). Migrations are immutable
   + cumulative, so that registry gives this class **different lifecycle semantics**: each entry is classified
   **active / active-legacy / superseded** and names its **forward replacement** (table below).
3. **Repo-wide escape** — scans the WHOLE repo and fails if the key/helper is referenced **outside the guarded
   roots** and outside a documented allow-list (docs `.md`, `src/test/**`, `tests/**`, `supabase/config.toml`), so
   a consumer added under a NEW runtime root cannot hide from checks 1–2.

`npm run check:legacy-key:selftest` proves the guard's own detection + diff logic against fixtures (literal,
alias, helper-only, extensionless, SQL sender, stale registration, escape, and the real baseline); both run in CI.
**No single registry is "the" authority — the three checks together are.** A NEW consumer of any class cannot slip
past the deactivation plan.

| Category | Count* | What it is | Legacy-off impact |
|---|---|---|---|
| `inbound-auth` | 6 | The self-auth boundary that verifies the incoming request's `Bearer`/`apikey` against the key: the shared `service-role-auth.ts` + `digest-worker-{entry,handler}.ts` modules and `forward-invoice` / `generate-cycle-commitment-invoices` / `slack-notify`. (The email/whatsapp/rebook drainers land in `admin-client`/`via-shared-helper` under the "admin-client wins" rule below.) | 401s the cron caller. |
| `admin-client` | 81 | Builds a privileged supabase-js client with the key (`createClient(url, SERVICE_ROLE_KEY)`). **The class the old doc missed.** | Every one 500s / loses its RLS-bypass. |
| `downstream-caller` | 5 | Forwards the key to invoke another function / shared email helper that does. | The invoked call 401s. |
| `via-shared-helper` | 5 | **No literal** — consumes the key transitively through a registered shared module (`requireServiceRole`/`getEnvServiceRoleKey`): `notification-digest-worker`, `backup-database`, `invoice-storage-gc`, `twilio-content-admin`, `_shared/forward-invoice-auth.ts`. Caught only by the helper-signal pass. | 500 / 401 like their literal peers; each must be re-verified individually after a rotation. |
| `vercel-caller` | 1 | `api/_lib/cron.ts` — reads the key from the **Vercel env** (not Vault), sends it as `apikey` + `Bearer`. | Both Vercel crons 401. |
| `scripts-ci` | 14 | One-off migration scripts (incl. cross-project storage scripts reading `SOURCE_`/`TARGET_SERVICE_ROLE_KEY`), local seed, and the CI guards themselves. | Dev/CI tooling only (no prod runtime). |
| `tests` | 4 | Fixtures exercising the auth — no production credential. | None. |
| **pg_net / Vault (SQL)** | 8 (4 active) | Cron commands in `supabase/migrations` that send the key as `Bearer` (Vault or the old `app.settings` path) or store it in Vault. **Machine-checked** by the second registry (`MANAGED_SQL`), classified active / active-legacy / superseded with forward replacements — not just the "see cron table" note. | The cron's `net.http_post` sends a dead token. |
| **Third parties** | **0** | The service-role key **never leaves for an external provider** — provider functions authenticate to Resend/Twilio/Mollie/Stripe with those providers' *own* keys. | — |

\* Live counts come from the guard's success line (`npm run check:legacy-key`); the guard's registries (`MANAGED`
+ `MANAGED_SQL`) are the source of truth **for these counts** (distinct from completeness, which the three checks
together enforce — see above). The categories are a *primary* classification — many functions both
self-authenticate **and** build an admin client; `admin-client` wins because that is the failure mode a legacy-off
migration must not miss.

The repo-wide escape check treats these as the **explicit out-of-scope allow-list** — a reference here is fine,
but a reference anywhere else outside the guarded roots fails CI: docs `.md`, `supabase/config.toml` (function env
injection), `.env*` (templates / secret material, never scanned), and **test-only** references under `src/test/`
and `tests/` (vitest/Playwright harnesses that set placeholder keys like `'test-service-role-key'` — never a real
credential). The client bundle (`src/`, excluding tests) must **never** reference a service-role key — and now
**cannot** without failing the escape check.

### SQL/Vault migration lifecycle (the second registry)

Migrations are immutable and cumulative — one that once sent the key stays on disk forever — so `MANAGED_SQL` (in
the guard) tracks **lifecycle**, not membership. Current state:

| Migration | Status | Cron / action | Forward replacement |
|---|---|---|---|
| `20260722100000_rebook_crons_use_vault.sql` | **active** | rebook crons; reads the Vault `service_role_key` secret at tick time (secret created out-of-band by the owner, not by this migration) | (Path B) `sb_secret_` cutover |
| `20260912110000_notification_email_worker_cron.sql` | **active** | notification-email-worker via Vault | (Path B) `sb_secret_` cutover |
| `20260919110000_notification_whatsapp_worker_cron.sql` | **active** | notification-whatsapp-worker via Vault | (Path B) `sb_secret_` cutover |
| `20260606120000_phase5_email_idempotency_and_cron_ficwb.sql` | **active-legacy** | invoice-health-check-daily via `app.settings` (redundant; `app.settings` reads empty on Supabase → effectively inert) | unschedule the redundant cron, or (Path B) `sb_secret_` |
| `20260714110000_notify_rebook_member_open_cron.sql` | superseded | notify-rebook-member-open via `app.settings` | `20260722100000_rebook_crons_use_vault.sql` |
| `20260721100000_auto_rebook_reminder.sql` | superseded | auto-rebook-reminder via `app.settings` | `20260722100000_rebook_crons_use_vault.sql` |
| `20260531110000_schedule_invoice_health_check_job.sql` | superseded | invoice-health-check-daily via `app.settings` | `20260606120000_phase5_email_idempotency_and_cron_ficwb.sql` |
| `20260511165940_…-….sql` | superseded | enrich-locations / fetch-location-logos crons via `app.settings` | `20260606120000_…` (jobs later unscheduled) |

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

> 🚦 **Hard precondition — confirm the switch is OFF *before* you post.** This probe is side-effect-free ONLY
> while `notification-digest-worker` has `DIGEST_SEND_ENABLED` unset / ≠ `"true"`. There is no SQL to read a
> function's env, so confirm it out-of-band from the function's deployed configuration (Dashboard → Edge Functions
> → the worker → secrets, or your deploy manifest). **If you cannot positively confirm the flag is off, do NOT run
> `net.http_post`** — an enabled worker would claim + send real digest emails. Do not infer "off" from the
> response: by the time you read a non-`disabled` body, the send has already happened.

Then probe the Vault key with the switched-off worker (async — `net.http_post` returns a pg_net **request id**):

```sql
-- PRECONDITION (verified out-of-band): notification-digest-worker DIGEST_SEND_ENABLED is unset / != 'true'.
select net.http_post(
  url := 'https://<project-ref>.supabase.co/functions/v1/notification-digest-worker',  -- DIGEST_SEND_ENABLED off
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
  body := '{}'::jsonb
);
-- then inspect the response (status + body only — see the secret caution below):
select id, status_code, content, error_msg, created from net._http_response where id = <the returned id>;
```

> 🔒 **Never `select *` from — or dump — pg_net's request/queue tables.** The probe above lists specific
> `net._http_response` columns on purpose: the **request** side (`net.http_request_queue`, and the request
> headers echoed in some pg_net versions) **retains the `Authorization: Bearer <service-role JWT>` in cleartext**.
> Inspect only the named response columns; do not `select *` or query the request/queue tables while debugging, or
> you will surface the live key in query output/logs — violating the "never print a credential value" rule below.

Expect `status_code = 200` with `{"status":"disabled","reason":"disabled"}` — a `disabled` body confirms the flag
was off (zero writes). A `401` means the Vault secret isn't the key *this* function's `requireServiceRole` expects.

> ⚠️ **A disabled-worker probe proves only that ONE worker's path — never generalise it to the senders.** It
> does NOT prove `notification-email-worker`, `notify-rebook-member-open`, or `auto-rebook-reminder` will
> authenticate: those verify the key with **their own separate checks** (the rebook crons use inline `Bearer`
> comparisons, not the shared `requireServiceRole`; see Path B, step 2 — `inbound-auth`). Each sender needs its **own**
> reviewed side-effect-free auth-only probe before its auth can be considered verified. **The senders have NO
> safe probe today** — one must be added to each before it can be smoke-tested.

## Credential procedures — two DISTINCT paths, never conflated

There is **no routine "rotate the service-role key" operation**, and — critically — on a project **still on the
legacy shared JWT secret** (this one), Supabase **no longer lets you rotate the legacy `anon`/`service_role`/JWT
secret at all**; that control returns only **after** migrating to the newer signing-key system
([guidance](https://supabase.com/docs/guides/troubleshooting/rotating-anon-service-and-jwt-secrets-1Jq6yd)). So no
emergency step below tells you to "regenerate the JWT secret" — that button is not available to us.
Only two real scenarios exist, and they are **implemented differently** — do not run one as the other:

- **A — Emergency (a credential is compromised):** there is **no operation that mints a replacement legacy key**,
  and no self-serve legacy-JWT-secret rotation. Emergency = immediate containment (pause every caller) + the
  remediation that **matches which secret leaked** — a leaked **API key** → **disable the legacy key in
  Settings → API Keys** (accept the outage) and/or migrate to a new `sb_secret_` key (**Path B on an emergency
  timeline**), then disable; a compromised **signing secret** → **pause callers + engage Supabase incident/support
  + an accelerated signing-key migration** (there is no dashboard rotation to click on legacy). Two independent
  incidents; see below.
- **B — Planned migration off the legacy JWT (before end-2026):** move to a supported new-key mechanism. This is
  **not a key swap** — it requires CODE changes (different env source + `apikey` transport) and a blocking
  per-worker probe prerequisite. See `## ⏳ B. Planned migration off the legacy JWT` below.

### A. Emergency: a credential is compromised

**There is NO operation that issues a replacement legacy `service_role`/`anon` JWT.** You cannot "rotate the
legacy key" to a new legacy value and redistribute it. Supabase's supported remediation for a compromised legacy
**API key** is to **replace it with a new `sb_secret_` key**
([API-key guidance](https://supabase.com/docs/guides/getting-started/api-keys)) — containment + a forced Path-B
migration, not a key re-sync. But that is only **one** of the incidents: first triage **WHICH secret leaked** —
a leaked API key and a compromised **signing secret** are **two independent incidents** with different severity,
urgency, and procedure. Run **Step 1 (containment)** for either, then follow the matching track. **If both leaked,
run both** — and note that **Track A2 (signing secret) is urgent and independent: it does NOT wait for Track A1's
API-key migration**.

- **Track A1 — leaked legacy `service_role` API key** (the *signing secret is safe*): the attacker cannot mint new
  tokens, but that single token is already a **full-database RLS-bypass compromise**. An **API-authorization**
  problem → **disable the legacy key in Settings → API Keys** now (accept the outage) if exposure outweighs
  availability, or migrate every caller to a new `sb_secret_` key (**Path B on an emergency timeline**) and then
  disable it. Do **not** touch the signing secret. See Track A1 below.
- **Track A2 — compromised JWT *signing* secret** (the secret that signs/validates **every** Supabase JWT): the
  attacker can **mint arbitrary tokens for any role** — categorically more severe. An **Auth-trust** problem, and
  on legacy there is **no self-serve rotation** → **pause callers + engage Supabase incident/support + run an
  accelerated signing-key migration**, on its own urgent timeline. See Track A2 below.

**Step 1 — Immediate containment (do this FIRST, regardless of which credential leaked):** pause EVERY dependent
caller so nothing keeps using the compromised key.
- **pg_cron** — pause the expected set, then assert all-inactive + none mid-run, for those job IDs only (adjust
  the expected set when the digest cron or any new drainer is added):

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
- **Vercel crons** — `/api/cron/daily-emails` and `/api/cron/daily-maintenance` cannot be `cron.alter_job`'d.
  Turn them off with Vercel's **project-level `Settings → Cron Jobs → Disable Cron Jobs` control**
  ([Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs)) (or remove them from
  `vercel.json` and redeploy). **Verify both configured jobs (`daily-emails`, `daily-maintenance`) are still
  listed but disabled.**
- **Legacy `invoice-health-check-daily`** — if still scheduled, it is *wired* to send the key (via the dead
  `app.settings` path → an inert token, so defensive rather than a live leak); `cron.alter_job(... , active := false)`
  it by that jobname too. It is intentionally *outside* the 4-job assert above (a redundant trigger that may
  already be unscheduled — check `cron.job` and pause it if present).

Then follow **only** the matching track. They differ in *how* the credential is killed: Track A1 **disables the
legacy keys in Settings → API Keys** (the signing secret is untouched, so session JWTs stay validly signed — but
the legacy `anon` key goes down *with* `service_role`, see the blast-radius note); Track A2 cannot self-serve on
legacy and must go through **Supabase support + an accelerated signing-key migration**.

**Track A1 — leaked legacy `service_role` API key.** ⚠️ **This is a live, full-database compromise, not a
low-severity availability issue.** The leaked key **bypasses RLS for read/write** against the REST / Storage /
Auth API **from anywhere**, and it stays valid until it is actually disabled. **Fail-closing your own crons does
NOT contain the attacker** — it only stops *your* outbound sends, not their direct use of the key. So the first
decision is **exposure vs availability**:

- **If data exposure is unacceptable (the default for a confirmed leak):** **disable the legacy keys in
  Settings → API Keys NOW.** ⚠️ **Blast radius — you cannot disable `service_role` alone: Supabase disables the
  legacy `anon` and `service_role` keys as a PAIR.** So this also kills the `anon` key, and **every request
  carrying it goes down** — the entire public/anon surface *plus* normal authenticated user REST/Storage/Auth
  traffic (the client sends the `anon` key in the `apikey` header). The **signing secret is untouched**, so
  issued session JWTs stay validly signed, but those requests still fail because the `anon` key they present is
  disabled. Accept the outage: every legacy-key consumer (the 81 `admin-client` functions + all crons) **and** the
  anon/public surface are down until migrated. Also apply project API-gateway / network restrictions + anomaly
  monitoring. Then rebuild on the new `sb_secret_` path. Do **not** rotate the JWT signing secret (that control is
  unavailable on legacy anyway).
- **Only if the exposure window is genuinely tolerable:** the availability-first path — the **only** way to kill
  `service_role` *without* also dropping the anon/public surface: migrate every consumer to a **named `sb_secret_`
  key first** (so the app runs on the new key), then **disable the legacy pair LAST** in Settings → API Keys. Keep
  the window **as short as possible**; the leaked key is live for its entire duration.

Whichever posture, the migration itself must cut **every category in *The legacy service-role-key dependency
class*** over, not just the drainers (the 81 `admin-client` functions 500 the moment the legacy key dies), and
**your own senders must not resume until verified**. All drainer crons — pg_cron AND both Vercel crons —
**stay FAIL CLOSED**. Do **NOT** re-enable on "out-of-band confirmation" or by "watching the first scheduled run":
the first run of a live sender sends real customer email, exactly the unsafe check forbidden in `## Verify`.
Resume ONLY after BOTH side-effect-free auth probes pass with **zero writes**:
- **Vault → function:** the switched-off-worker probe from `## Verify` → `HTTP 200`, zero writes (proves only the
  `Vault → worker` path — not the senders, which self-authenticate separately).
- **Vercel → function:** a **reviewed Vercel-origin auth-only probe is deployed and returns 200 with zero
  writes.** ⚠️ **BLOCKING RUNTIME PREREQUISITE — none exists today:** both Vercel crons SEND on invocation, so
  there is no side-effect-free way to prove the Vercel path yet. Until such a probe is deployed and passes, the
  two Vercel crons **remain disabled** and recovery is **not** complete. Never invoke `/api/cron/daily-emails`
  or `/api/cron/daily-maintenance` to "test the key". Never print any credential value.

**Track A2 — compromised JWT *signing* secret: contain via support + accelerated migration; do not wait behind the
API cutover.** This is **URGENT and INDEPENDENT of Track A1** — the attacker can forge tokens for any role. But
there is a hard constraint: **on the legacy shared JWT secret there is no self-serve rotation** — the dashboard
"regenerate JWT secret" control is unavailable until the project migrates to signing keys. Containment is therefore
**not a button you click**; sequence it as:
1. **Contain immediately with the levers you DO have:** Step 1 has already paused every caller (your own infra
   stops presenting the key); now blunt the attacker's direct forged-token access with **project API-gateway /
   network restrictions** and heightened **anomaly monitoring**.
2. **Engage Supabase support at once** to report the compromise and **initiate/accelerate the signing-key
   migration** — Supabase's published guidance documents **no** legacy-secret rotation (self-serve *or*
   support-assisted); migrating to the signing-key system is the only path that restores rotate/revoke control.
   (Do not assume support can rotate the legacy secret out of band — treat the migration as the remedy.)
3. **Expect the eventual secret change to be nuclear.** Once you can rotate (after the signing-key migration), it
   **invalidates all active user sessions** (every user re-authenticates) **and** every legacy
   `service_role`/`anon` JWT — the latter via **signature validation on the OUTBOUND path**: the admin-client's
   `createClient(url, SERVICE_ROLE_KEY)` calls to PostgREST/GoTrue (and any `verify_jwt=true` path) reject the
   now-invalidly-signed JWT. The **inbound** byte-exact cron→worker check is rotation-*insensitive* (it
   string-compares the presented Bearer against the stored env copy), so the drainers are contained by the Step-1
   manual pause + their admin-client calls failing, not by inbound auth self-closing.
4. **Rebuild on the new key.** Track A1 / Path B still follows to move every consumer onto `sb_secret_` — but as
   *recovery*, never as a precondition for containment. Drainer crons stay **FAIL CLOSED** through the cutover,
   exactly as in Track A1.

If the project has **already migrated to asymmetric signing keys**, skip the support dependency: revoke the
compromised key directly via the [signing-keys](https://supabase.com/docs/guides/auth/signing-keys) rotate/revoke
flow (a standby key makes it graceful), then rebuild.

Do **not** conflate the two: signing-secret containment (Auth-token trust) and API-key replacement (Path B) are
different operations, and neither substitutes for the other.

## ⏳ B. Planned migration off the legacy JWT (before end of 2026)

Supabase is **deprecating legacy `service_role` / `anon` JWT keys by the end of 2026**
([migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)). This migration
spans the **entire *legacy service-role-key dependency class*** above — **not only** the cron→function auth, but
every `admin-client` function that builds a privileged supabase-js client with the key, **and** the SQL/Vault cron
migrations. `npm run check:legacy-key`'s **three checks together** (source registry + SQL/Vault registry +
repo-wide escape — no single one is authoritative alone) are the CI-enforced checklist: the legacy key cannot be
disabled while any check still lists an un-migrated consumer. **This is NOT a key swap** — the new keys are a
different mechanism, so it needs CODE changes, not just a Vault/Vercel value update.
`SUPABASE_SERVICE_ROLE_KEY` stays the legacy JWT; the new `sb_secret_` key is exposed as `SUPABASE_SECRET_KEYS`
and must be sent via the **`apikey`** header, not `Authorization: Bearer`
([pg_net requirement](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys#database-webhooks-and-pg_net)).

- **Owner:** platform owner (info@racketsportsoftware.com) — a reviewed migration in 2026 (not piecemeal; a
  wrong cutover 401s every drainer at once).
- **Required implementation changes — migrate or explicitly PROVE every category (all before disabling the legacy
  key).** Work the categories from *The legacy service-role-key dependency class*; the guard is the checklist:
  1. **`admin-client` (81 functions) — the largest class, and the one an auth-only migration silently misses.**
     Each constructs `createClient(url, SUPABASE_SERVICE_ROLE_KEY)` for its RLS-bypass — disabling the legacy key
     500s **all** of them. Repoint each to the new key (`SUPABASE_SECRET_KEYS` / the supported admin-client
     construction), function by function; there is no shared shim to flip once.
  2. **`inbound-auth` (6) — worker/self-auth checks.** Change each to accept the new key — read
     `SUPABASE_SECRET_KEYS` (or a dedicated named worker secret), not `SUPABASE_SERVICE_ROLE_KEY`. The auth is
     **not shared today**: `notification-email/whatsapp/digest-worker` use `requireServiceRole`
     (`supabase/functions/_shared/service-role-auth.ts`), but `notify-rebook-member-open` / `auto-rebook-reminder`
     have their **own inline `Bearer` comparisons** — every path must be updated.
  3. **`downstream-caller` (5).** Functions/shared email helpers that forward the key to invoke another function —
     update the forwarded credential + header (`apikey`, not `Bearer`) to match the callee's new check.
  4. **pg_net / Vault cron commands** — the `MANAGED_SQL` **active** entries (rebook-crons-use-vault, the
     email-worker cron, the whatsapp-worker cron, + the active-legacy invoice-health-check trigger) and any future
     digest cron. Add a NEW migration that reschedules each to send the new key via the **`apikey`** header (not
     `Authorization: Bearer`). Superseded entries are immutable history — leave them; do not edit past migrations.
  5. **`vercel-caller` (1) + env contract.** The Vercel cron helper (`api/_lib/cron.ts`) sends the legacy
     service-role key; move it (and the `SUPABASE_SERVICE_ROLE_KEY` env it reads) to the new mechanism and
     redeploy production.
  6. **`via-shared-helper` (5) — NO literal, easy to drop from a manual list.** `notification-digest-worker`,
     `backup-database`, `invoice-storage-gc`, `twilio-content-admin`, and `_shared/forward-invoice-auth.ts`
     consume the key through `requireServiceRole` / `getEnvServiceRoleKey`. Migrating the shared modules covers
     them mechanically, but **each must still be individually smoke-tested** after the cutover (they are exactly
     the consumers a literal-only inventory forgets).
  7. **`scripts-ci` (14).** Migration/seed scripts (incl. the cross-project storage scripts on
     `SOURCE_`/`TARGET_SERVICE_ROLE_KEY`) + the CI guards that read the key — repoint or retire, and update this
     guard's registry + doc so they describe the new model.
  8. **Guard green on the new model.** All THREE checks — source registry, SQL/Vault registry, and repo-wide
     escape — show **no consumer still on the legacy key** (registries migrated/emptied): the machine-checked
     proof that nothing was forgotten.
  9. **Deploy all of the above**, then verify (below), then **disable the legacy keys in Settings → API Keys LAST**
     — this disables the `anon` + `service_role` pair together (Supabase cannot disable one alone), which is safe
     *only because* every consumer, incl. the anon/public surface, is now on `sb_secret_`. It is a key
     **disable**, NOT a JWT-secret rotation (that control is unavailable on legacy anyway).
- **BLOCKING PREREQUISITE (do not start the cutover until this exists):** because the auth paths are not shared,
  **every live sender must gain a reviewed side-effect-free auth-only probe** (a mode that authenticates and
  returns 200 **without** sending), OR all workers must be routed through **one genuinely shared, tested auth
  boundary**. One disabled `notification-digest-worker` invocation proves only its own path — it cannot authorize
  resuming `notification-email-worker` or the rebook workers after their auth changes.
- **Verification (never sends):** each worker's **side-effect-free auth-only probe** returns `HTTP 200` with the
  NEW credential; only then **disable the legacy key in Settings → API Keys** and purge its stored copies from
  Vault + Vercel. Verification MUST NOT invoke a live sender or accept "expected send behaviour" — no customer
  message is sent to prove auth.
- **Exit condition:** no consumer in **any** class — function auth, admin-client construction, downstream caller,
  SQL/Vault cron, or Vercel — depends on the legacy key; **all three guard checks** (source + SQL/Vault + escape)
  are clean, and `check-edge-fn-config.mjs` + this doc reflect the new model.
