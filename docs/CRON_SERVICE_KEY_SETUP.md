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

## The legacy service-role-key dependency class (full inventory)

The cron tables above are only the **inbound-auth** slice. Deactivating the legacy `service_role` JWT (Path B,
or an emergency) breaks a **much larger class**: the ~100 runtime files that use the key *internally* to build a
privileged (RLS-bypassing) supabase-js admin client. A migration that only fixes the cron→function auth would
still 500 every one of those functions the moment the legacy key is turned off. So the inventory below — not just
the drainers — is what Path B must migrate or explicitly prove.

This inventory is **machine-checked and self-enforcing**, not a hand-list that rots: `npm run check:legacy-key`
(`scripts/check-legacy-service-role-consumers.mjs`, a CI gate) walks `supabase/functions`, `api`, and `scripts`
and fails if any file references `SUPABASE_SERVICE_ROLE_KEY` without being in its categorized registry, or if a
registry entry no longer does. A NEW admin-client / caller / worker therefore cannot silently slip past the
deactivation plan — CI forces it into a category first.

| Category | Count* | What it is | Legacy-off impact |
|---|---|---|---|
| `inbound-auth` | 6 | Verifies the incoming request's `Bearer`/`apikey` against the key (the drainers + shared `service-role-auth.ts`). | 401s the cron caller. |
| `admin-client` | ~81 | Builds a privileged supabase-js client with the key (`createClient(url, SERVICE_ROLE_KEY)`). **The class the old doc missed.** | Every one 500s / loses its RLS-bypass. |
| `downstream-caller` | 5 | Forwards the key to invoke another function / shared email helper that does. | The invoked call 401s. |
| `vercel-caller` | 1 | `api/_lib/cron.ts` — reads the key from the **Vercel env** (not Vault), sends it as `apikey` + `Bearer`. | Both Vercel crons 401. |
| `scripts-ci` | 9 | One-off migration scripts, local seed, and the CI guards themselves. | Dev/CI tooling only (no prod runtime). |
| `tests` | 4 | Fixtures exercising the auth — no production credential. | None. |
| **pg_net / Vault (SQL)** | see cron table | Cron commands sending the Vault-stored key as `Bearer` — a **separate class in `supabase/migrations`**, NOT scanned by the code guard; enumerated in *Which crons depend on this key*. | The cron's `net.http_post` sends a dead token. |
| **Third parties** | **0** | The service-role key **never leaves for an external provider** — provider functions authenticate to Resend/Twilio/Mollie/Stripe with those providers' *own* keys. | — |

\* Live counts come from the guard's success line (`npm run check:legacy-key`); the registry is the source of
truth. The categories are a *primary* classification — many functions both self-authenticate **and** build an
admin client; `admin-client` wins because that is the failure mode a legacy-off migration must not miss.

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
isn't the key *this* function's `requireServiceRole` expects.

> ⚠️ **A disabled-worker probe proves only that ONE worker's path — never generalise it to the senders.** It
> does NOT prove `notification-email-worker`, `notify-rebook-member-open`, or `auto-rebook-reminder` will
> authenticate: those verify the key with **their own separate checks** (the rebook crons use inline `Bearer`
> comparisons, not the shared `requireServiceRole`; see *Path B → Function auth*). Each sender needs its **own**
> reviewed side-effect-free auth-only probe before its auth can be considered verified. **The senders have NO
> safe probe today** — one must be added to each before it can be smoke-tested.

## Credential procedures — two DISTINCT paths, never conflated

There is **no routine "rotate the service-role key" operation**. Legacy `service_role`/`anon` JWTs cannot be
issued/rotated individually
([guidance](https://supabase.com/docs/guides/troubleshooting/rotating-anon-service-and-jwt-secrets-1Jq6yd)).
Only two real scenarios exist, and they are **implemented differently** — do not run one as the other:

- **A — Emergency (a credential is compromised):** there is **no operation that mints a replacement legacy
  key** — you cannot "rotate" the legacy `service_role` JWT to a new legacy value and re-distribute it. Emergency
  = immediate containment (pause every caller) + the remediation that **matches which secret leaked** — a leaked
  API key → replace with a new `sb_secret_` key (**Path B on an emergency timeline**); a compromised **signing
  secret** → **urgent signing-key revocation on its own timeline**. Two independent incidents; see below.
- **B — Planned migration off the legacy JWT (before end-2026):** move to a supported new-key mechanism. This is
  **not a key swap** — it requires CODE changes (different env source + `apikey` transport) and a blocking
  per-worker probe prerequisite. See `## ⏳ Deprecation` below.

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

- **Track A1 — leaked legacy `service_role` API key** (the *signing secret is safe*): the attacker holds one
  static token but **cannot mint new ones**. An **API-authorization** problem → migrate every caller to a new
  `sb_secret_` key (**Path B on an emergency timeline**), then revoke the leaked legacy key LAST.
- **Track A2 — compromised JWT *signing* secret** (the secret that signs/validates **every** Supabase JWT): the
  attacker can **mint arbitrary tokens for any role** — categorically more severe. An **Auth-trust** problem →
  Supabase's **signing-key rotation / revocation**, done **immediately and on its own timeline**.

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

Then follow **only** the matching track. They differ in *when* the credential is killed: Track A1 revokes the
legacy key **last** (after a verified cutover); Track A2 revokes the signing key **first** (immediately).

**Track A1 — leaked legacy `service_role` API key: migrate, then revoke LAST.** Remediate via **Path B on an
emergency timeline** — stand up the new `sb_secret_` / supported-auth path and cut **every category in *The legacy
service-role-key dependency class*** over, not just the drainers (the ~81 `admin-client` functions 500 the moment
the legacy key dies). Verify with side-effect-free probes, then **revoke the leaked legacy key at the END of the
cutover** (there is no "new legacy JWT" to fetch or re-sync). Until every caller is verified on the new key,
**FAIL CLOSED** — all drainer crons, pg_cron AND both Vercel crons, **stay disabled**. Do **NOT** re-enable on
"out-of-band confirmation" or by "watching the first scheduled run": the first run of a live sender sends real
customer email, exactly the unsafe check forbidden in `## Verify`. Resume ONLY after BOTH side-effect-free auth
probes pass with **zero writes**:
- **Vault → function:** the switched-off-worker probe from `## Verify` → `HTTP 200`, zero writes (proves only the
  `Vault → worker` path — not the senders, which self-authenticate separately).
- **Vercel → function:** a **reviewed Vercel-origin auth-only probe is deployed and returns 200 with zero
  writes.** ⚠️ **BLOCKING RUNTIME PREREQUISITE — none exists today:** both Vercel crons SEND on invocation, so
  there is no side-effect-free way to prove the Vercel path yet. Until such a probe is deployed and passes, the
  two Vercel crons **remain disabled** and recovery is **not** complete. Never invoke `/api/cron/daily-emails`
  or `/api/cron/daily-maintenance` to "test the key". Never print any credential value.

**Track A2 — compromised JWT *signing* secret: revoke NOW, do not wait for the migration.** This follows
Supabase's **signing-key rotation / revocation** procedure
([signing keys](https://supabase.com/docs/guides/auth/signing-keys)) and is **URGENT and INDEPENDENT of Track
A1** — because the attacker can forge tokens for any role, it **must NOT be deferred to the end of a
potentially-lengthy API migration**. Sequence it on its own:
1. **Rotate/revoke the exposed signing key immediately** per Supabase's signing-key procedure — this *is* the
   containment for a forged-token attack, and it cannot wait for any code change.
2. **Accept the session impact up front:** revoking the signing key **invalidates all active user sessions** —
   every user must re-authenticate. That is the cost of containment; do not delay revocation to avoid it.
3. **It also invalidates the legacy API JWTs.** The legacy `service_role`/`anon` keys are signed by this same
   secret, so rotating it makes the byte-exact `SUPABASE_SERVICE_ROLE_KEY` check fail **everywhere** at once.
   Track A1 / Path B therefore **still follows** to restore cron + function auth on a supported key — but as
   *recovery after* the urgent revocation, **never as a precondition for it**. While that new-key cutover runs,
   the drainer crons stay **FAIL CLOSED** exactly as in Track A1.

Do **not** conflate the two: signing-key rotation (Auth-token trust) and API-key replacement (Path B) are
different operations, and neither substitutes for the other.

## ⏳ B. Planned migration off the legacy JWT (before end of 2026)

Supabase is **deprecating legacy `service_role` / `anon` JWT keys by the end of 2026**
([migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)). This migration
spans the **entire *legacy service-role-key dependency class*** above — **not only** the cron→function auth, but
every `admin-client` function that builds a privileged supabase-js client with the key. `npm run check:legacy-key`
(`scripts/check-legacy-service-role-consumers.mjs`) is the **authoritative, CI-enforced checklist**: the legacy
key cannot be disabled while it still lists any un-migrated consumer. **This is NOT a key swap** — the new keys
are a different mechanism, so it needs CODE changes, not just a Vault/Vercel value update.
`SUPABASE_SERVICE_ROLE_KEY` stays the legacy JWT; the new `sb_secret_` key is exposed as `SUPABASE_SECRET_KEYS`
and must be sent via the **`apikey`** header, not `Authorization: Bearer`
([pg_net requirement](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys#database-webhooks-and-pg_net)).

- **Owner:** platform owner (info@racketsportsoftware.com) — a reviewed migration in 2026 (not piecemeal; a
  wrong cutover 401s every drainer at once).
- **Required implementation changes — migrate or explicitly PROVE every category (all before disabling the legacy
  key).** Work the categories from *The legacy service-role-key dependency class*; the guard is the checklist:
  1. **`admin-client` (~81 functions) — the largest class, and the one an auth-only migration silently misses.**
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
  4. **pg_net / Vault cron commands.** Send the new key via the **`apikey`** header (not `Authorization: Bearer`);
     update `20260722100000_rebook_crons_use_vault.sql`, the two worker-cron migrations, and any digest cron.
  5. **`vercel-caller` (1) + env contract.** The Vercel cron helper (`api/_lib/cron.ts`) sends the legacy
     service-role key; move it (and the `SUPABASE_SERVICE_ROLE_KEY` env it reads) to the new mechanism and
     redeploy production.
  6. **`scripts-ci` (9).** Migration/seed scripts + the CI guards that read the key — repoint or retire, and
     update this guard's registry + doc so they describe the new model.
  7. **Guard green on the new model.** `npm run check:legacy-key` shows **no category still referencing the legacy
     key** (registry migrated/emptied) — the machine-checked proof that no consumer was forgotten.
  8. **Deploy all of the above**, then verify (below), then **disable/remove the legacy JWT LAST**.
- **BLOCKING PREREQUISITE (do not start the cutover until this exists):** because the auth paths are not shared,
  **every live sender must gain a reviewed side-effect-free auth-only probe** (a mode that authenticates and
  returns 200 **without** sending), OR all workers must be routed through **one genuinely shared, tested auth
  boundary**. One disabled `notification-digest-worker` invocation proves only its own path — it cannot authorize
  resuming `notification-email-worker` or the rebook workers after their auth changes.
- **Verification (never sends):** each worker's **side-effect-free auth-only probe** returns `HTTP 200` with the
  NEW credential; the legacy JWT is then removed from Vault + Vercel. Verification MUST NOT invoke a live sender
  or accept "expected send behaviour" — no customer message is sent to prove auth.
- **Exit condition:** no consumer in **any** category — function auth, admin-client construction, downstream
  caller, pg_net/Vault cron, or Vercel — depends on a legacy `service_role` JWT; `npm run check:legacy-key` shows
  the registry cleared of legacy consumers, and `check-edge-fn-config.mjs` + this doc reflect the new model.
