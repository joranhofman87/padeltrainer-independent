# ADR-001 — the extension-table fence is withdrawn; rehearsals move to an empty project with synthetic data

**Status:** accepted · **Date:** 2026-08-02 · **Supersedes:** the sealed-window design merged in #626

---

## 1. Context

Step 8 of the 10c-a3 rollout needs rehearsals A–D of three migrations
(`20261006100000`, `20261006110000`, `20261006120000`) against something that
behaves like production, so the `ACCESS EXCLUSIVE` window can be measured before
it is taken for real.

The design merged in #626 obtained that by **restoring a production snapshot**.
Because a Supabase restore copies pg_cron jobs, the pg_net queue, Vault secrets
and database webhooks, a restored project boots with real credentials and
resumes cron within minutes — so the design added a *sealed window*: pause every
job, install deliberately-failing statement triggers on `cron.job` and
`net.http_request_queue`, commit a provenance marker, and require every clone to
carry that marker with the fences still in force.

That design is withdrawn. This ADR records why, what the threat model actually
is, and what replaces it.

## 2. Why the fence cannot be supported

### 2.1 Triggers on `net.http_request_queue` are advised against

Supabase's webhook debugging guide identifies triggers on
`net.http_request_queue` as a cause of pg_net malfunction, and a *deliberately
failing* trigger is the worst case of that class:

<https://supabase.com/docs/guides/troubleshooting/webhook-debugging-guide-M8sk47>

The fence's whole mechanism was to raise `42501` on every insert. Applying it to
the extension's own work queue puts the extension into exactly the state the
vendor documents as broken.

### 2.2 The create/drop lifecycle cannot be granted

PostgreSQL splits these privileges:

| operation | requirement |
| --- | --- |
| `CREATE TRIGGER` | the `TRIGGER` privilege on the table |
| `DROP TRIGGER` | **ownership** of the table |

`cron.job` and `net.http_request_queue` are extension-managed objects. A
`GRANT TRIGGER` therefore produces a fence that the rollout role can **install
and never remove** — strictly worse than no fence, because production would be
left frozen with no supported way out.

### 2.3 The measured result

The read-only production inventory of 2026-08-02 returned:

```
FENCEABLE no      LOGRUN on        PRIORWINDOW 0
INFLIGHT 0        NETQUEUE 0       HOOKTRIG 0    OUTTRIG 0    FDWSRV 0
7 reviewed cron jobs (4 outbound, 3 internal); reviewed outbound functions and extensions only
```

`FENCEABLE no` is the guard from #626 working exactly as designed: it refused in
the read-only step rather than sealing a window it could not protect.

### 2.4 Remedies that are explicitly out of scope

Taking ownership of extension tables, joining the extension-owner role,
dropping and recreating `pg_cron`/`pg_net`, or installing the trigger through a
privileged `SECURITY DEFINER` wrapper would each make the fence work. All are
rejected: every one permanently changes how production's scheduler and outbound
queue are owned, in order to buy a rehearsal convenience. **A rehearsal
mechanism must not be the reason production's ownership model changes.**

## 3. Threat model — what a restore actually copies

The fence existed because a restore copies far more than schema. That remains
true and is the reason the replacement avoids restores entirely.

### 3.1 Copied by a database restore — dangerous

| state | why it matters | earliest external send |
| --- | --- | --- |
| `cron.job` | jobs resume on boot; `notification-email-worker` and `notification-whatsapp-worker` run `*/2` | **~2 minutes** after the project accepts connections |
| `cron.job_run_details` | history only; but a `starting`/`connecting`/`sending` row proves a run was mid-flight at snapshot time | — |
| `net.http_request_queue` | queued requests are dispatched by the clone's own pg_net worker | seconds after boot |
| `net._http_response` | prior response bodies — provider metadata, not sends | — |
| Vault secrets | the clone holds **production's provider API keys**, so its sends are indistinguishable from production's | enables all of the above |
| database webhooks (`supabase_functions.http_request` triggers) | fire on ordinary DML in the clone | first write |
| ordinary triggers reaching `net.http_*`/`dblink`, directly or transitively | same, but invisible to a name-based check — needs a recursive closure over `pg_proc` | first write |
| FDW servers | outbound connections to other databases | first query |
| `auth.users` and sessions | real identities and live refresh tokens | — |
| every application table | **all customer PII**: names, email addresses, phone numbers, billing addresses, invoices, attendance | — |

### 3.2 Created at runtime, so not a static list

`public.schedule_enrichment_job`, `public.schedule_logo_fetch_job` and
`public.schedule_invoice_health_check_job` call `cron.schedule` at runtime and
are **`SECURITY DEFINER`** — they execute as their owner, so role-level
`REVOKE`s on `cron.schedule` do not stop them. The live job set is therefore not
static, which is what made a lock-based approach insufficient and drove the
fence design in the first place.

### 3.3 NOT copied by a database restore

A restore is a *database* operation. These are not part of it, and assuming
otherwise is its own hazard — a rehearsal that "looks like production" may be
missing the very component that sends:

- **Edge Functions** (the email and WhatsApp workers themselves) — deployed per
  project; a restored database's cron jobs call an endpoint that may not exist,
  or worse, may still point at **production's** function URL.
- **Vercel** deployments, cron jobs and environment variables.
- Supabase **project settings**: API keys, JWT secret, SMTP, auth providers,
  network restrictions.
- Storage objects and their access policies.
- The Cloudflare Worker (short links) and any DNS-level routing.

The practical consequence: a restored clone is dangerous because of the
*database* state it carries, and simultaneously not a faithful production
replica because of the *infrastructure* it lacks. Neither half argues for
restoring production.

### 3.4 PII exposure per candidate method

| method | customer PII copied |
| --- | --- |
| production snapshot restore (withdrawn) | **all of it**, into up to four disposable projects, each billed and each a full copy |
| empty project + synthetic data (adopted) | **none** |

## 4. Decision

1. **Withdraw the fence.** `clone-source-quiesce` refuses before opening a
   connection, before requiring `psql`, and before reading or changing anything.
   The seal/arm artifacts move to `sql/withdrawn/` for review and are not part of
   the executable set.
2. **Keep recovery.** `clone-source-resume` and `clone-source-abandon` remain,
   unchanged, gated on explicit prior-window evidence (the recorded nonce, or an
   operator-supplied `--nonce`). Production currently reports `PRIORWINDOW 0`, so
   there is no window to recover; the path is retained rather than weakened.
3. **Rehearse on an empty, disposable project loaded with synthetic data.**

## 5. The replacement

```
clone-verify-empty    <url>          # prove EMPTY and outbound-inert before anything is loaded
clone-build-baseline  --yes <url>    # schema from main → schedules off → synthetic scale rows
clone-baseline-verify <url>          # target == recorded pristine baseline
clone-reset-baseline  --yes <url>    # between rehearsals A–D; no snapshot restore
```

Inertness is **proven, not manufactured**. `sql/empty_project_check.sql` asserts
zero cron jobs, an empty pg_net queue *and* response table, zero Vault secrets,
zero webhooks, zero outbound-capable triggers (including nested paths), zero FDW
servers and zero auth users — *before* a single object is created. There is no
provenance question to answer because the target never held production state, so
there is no marker and no fence.

After the schema build, `sql/clone_deactivate_schedules.sql` deactivates every
job the migrations created (`cron.alter_job` only, never `cron.unschedule`) and
`sql/rehearsal_inert_check.sql` re-proves inertness for the loaded target. That
pause needs no fence: there is no live workload to protect against.

**The build is inert while it runs — by construction.** Migrations call
`cron.schedule`, several baking a hard-coded endpoint into the job command, and
the chain also runs `CREATE EXTENSION pg_cron` / `pg_net` (20260117134212,
20260330204208). Two consequences the first attempt got wrong:

* deactivating *after* `supabase db push` leaves live jobs for the whole build;
* pre-creating stand-in `cron`/`net` objects **collides** with those
  `CREATE EXTENSION` statements — and if they succeed, the target has a real
  scheduler and a real network primitive again.

So the migration **source is sanitized**, fail-closed two ways, because `main`
moves and a pattern list can only reject the constructs someone already thought of:

1. **A reviewed-chain digest.** `synth/sanitize-migrations.mjs` hashes every
   migration and requires the result to equal the pinned value in
   `clone-safety/reviewed-migration-chain.json`. *Any* change — one new
   migration, one edited line — refuses the build until a human re-reviews the
   diff and re-pins. This is the guard that survives an unknown construct.
2. **A pattern sweep over comment-stripped text**, so `CREATE /* x */ EXTENSION`
   cannot hide anything. Extensions are an **allow-list** (`pgcrypto`, `pg_trgm`,
   … reviewed as inert); anything else is refused rather than ignored.
   `pg_cron`/`pg_net` are the two that are *neutralised* instead. The sweep also
   refuses `supabase_functions.http_request`, `extensions.http_*`, bare `http_*`,
   `dblink`, FDW plumbing, `cron.schedule_in_database`, `pg_read_file` and
   `COPY … PROGRAM`.

`sql/platform_stub.sql` supplies inert `cron`/`net` objects beforehand. Every
`cron.schedule` in the chain then records intent and schedules nothing; every
`net.http_post` is counted and never made. The stub fails closed if the real
extensions are already installed, since they cannot be shadowed.

This is executed, not asserted: `verify/clone-safety-pg.mjs` sanitizes the real
chain, applies **all 552 migrations** to a bare database, confirms `pg_cron`/
`pg_net` are absent and zero cron jobs are active, applies #615, wipes, and
replays all 552 again.

**Reset is a rebuild, not a row reload.** After A or D the target carries all
three #615 migrations — columns, functions, tables, constraints and three ledger
rows; after C it carries a prefix; a failed migration can leave a mixture.
Truncating two tables reverses none of that. `clone-reset-baseline` therefore
runs `sql/clone_wipe.sql`, re-proves the target is bare, and rebuilds through the
**same code path** as the original build so a reset cannot drift from what it
claims to restore.

The wipe has to reach further than `DROP SCHEMA public`. Migrations insert
`storage.buckets` rows with **no** `ON CONFLICT` and create policies on
`storage.objects`; both live in a platform-owned schema and survive. So does the
migration ledger — leaving it makes the next push apply a *suffix*. The wipe
therefore also clears storage buckets and objects, drops every policy on
`storage.objects`, clears Vault secrets, drops database-webhook triggers, and
empties `supabase_migrations.schema_migrations`, then **asserts** each of those is
zero. The real-Postgres suite proves it by replaying the full chain after a wipe:
no duplicate bucket, no duplicate policy.

**Reusable baseline.** `sql/baseline_fingerprint.sql` records the shape (columns,
types, nullability, index set), the size (row counts and total relation bytes),
the distribution (state and event-type mix) and a bloat reading for the two
affected tables. Rehearsals B and C deliberately leave the target broken, so each
rehearsal re-asserts the fingerprint first and `clone-reset-baseline` restores it
by reloading synthetic data. **Four production snapshot restores become one
empty project.** A migration that failed part-way changes the shape fingerprint,
so it cannot leave a reusable false-green baseline.

## 6. Does this give an honest #615 rehearsal?

**Yes, for the property that matters — with two caveats stated plainly.**

### 6.1 What #615 actually does

| migration | operation | lock | cost driver |
| --- | --- | --- | --- |
| `20261006100000` | `ALTER TABLE public.email_address_state ADD COLUMN is_suppressed … GENERATED ALWAYS AS … STORED` | `ACCESS EXCLUSIVE` | **full table rewrite** — row count × tuple width |
| `20261006100000` | `ALTER TABLE public.email_delivery_events DROP/ADD CONSTRAINT … CHECK` | `ACCESS EXCLUSIVE` | **full validation scan** — row count |
| `20261006100000` | backfill deriving `state_changed_at` from state-producing event history | row locks | rows × **event-type distribution** |
| `20261006110000` | `CREATE TABLE IF NOT EXISTS` + indexes + RLS + grants | new objects only | negligible; touches no existing data |
| `20261006120000` | `CREATE OR REPLACE FUNCTION` ×2 | catalog only | negligible |

Only **two existing tables** are locked, and every cost driver is *volume,
width, index set or distribution*. **None of them reads the meaning of a value.**
A rewrite does not care whether an address belongs to a real customer; a CHECK
validation does not care what a `reason` string says.

That is precisely why synthetic data is honest here, and it is why the scale file
carries widths and distributions rather than just row counts.

### 6.2 What is reproduced

Row counts; average widths for **every** width-driving column of the pre-#615
shape; the complete index set (created by the same migrations); the `state` and
`event_type` distributions; and the **per-address event history**
(`events_per_address` p50/p90/max) measured over **exactly the backfill's own
predicate** — `event_type IN ('sent','delivered','bounced','complained',
'operator_reset')`. Counting every event type would inflate the history with rows
the backfill never touches (`failed`, `send_failed`, `delivery_delayed`), and the
generator would then distribute those through a budget sized for the others. The
generator uses the same set, and `verify/repo-guard-test.sh` pins both against the
predicate in the pinned migration itself.

**Row counts alone are not scale.** An `ACCESS EXCLUSIVE` rewrite walks *pages*,
so the scale file also carries measured `heap_bytes`, `index_bytes` and
`total_bytes`, and the generator **fails** if the relation it produced falls
outside `byte_tolerance_pct` of the measured size. Without that check a derived
`CAP_STMT` would not bound anything.

### 6.3 Caveats — stated, not hidden

- **Physical bloat and page layout.** A freshly loaded table is perfectly packed;
  a table that has absorbed years of updates is not, and a rewrite must walk its
  pages. The baseline injects a configured `dead_tuple_ratio` of dead tuples
  without vacuuming to approximate this. It is an **approximation**, not physical
  equivalence, and a measured window should be treated as a *lower bound*.
- **Hardware and concurrency.** The disposable project must be the same instance
  size as production, and the measurement is taken with no concurrent workload —
  production has one. The derived `CAP_STMT` already carries 50 % headroom for
  this (rehearsal A).

### 6.4 The honest conclusion

The synthetic baseline gives a **sound lower bound on the rewrite/validation
window and an exact reproduction of the locking behaviour** (which statements
take `ACCESS EXCLUSIVE`, in what order, and whether a `lock_timeout` abort leaves
a partial delta — rehearsals B and C). It does not reproduce production's exact
physical layout. That is a materially better trade than copying every customer's
email address into four projects to shave uncertainty off a number that already
carries 50 % headroom.

## 7. Remaining prerequisite — a read-only sizing query

`clone-safety/rehearsal-scale.json` ships with `source: "placeholder"` and the
tooling **refuses to build a baseline** until it says `"measured"`. Filling it
needs one read-only query against production, which is a separate authorization:

```sql
-- Produces EVERY field rehearsal-scale.json requires. Counts, lengths, byte
-- sizes and category names only — no address, no reason text, no identifier.

-- sizes (heap and index separately: a rewrite walks the heap, a constraint
-- validation walks indexes, and the right total with the wrong split is not
-- the same relation)
SELECT 'email_address_state' AS t,
       count(*)                                        AS rows,
       avg(length(email))::int                         AS avg_email_len,
       avg(length(coalesce(reason, '')))::int          AS avg_reason_len,
       pg_relation_size('public.email_address_state')  AS heap_bytes,
       pg_indexes_size('public.email_address_state')   AS index_bytes,
       pg_total_relation_size('public.email_address_state') AS total_bytes
FROM public.email_address_state
UNION ALL
SELECT 'email_delivery_events',
       count(*),
       NULL,
       avg(length(coalesce(reason, '')))::int,
       pg_relation_size('public.email_delivery_events'),
       pg_indexes_size('public.email_delivery_events'),
       pg_total_relation_size('public.email_delivery_events')
FROM public.email_delivery_events;

-- distributions
SELECT state, count(*) FROM public.email_address_state GROUP BY state;
SELECT event_type, count(*) FROM public.email_delivery_events GROUP BY event_type;

-- the two percentages the event rows depend on
SELECT round(100.0 * count(*) FILTER (WHERE resend_event_id IS NOT NULL) / greatest(count(*), 1))::int
         AS resend_event_id_pct,
       round(100.0 * count(*) FILTER (WHERE invoice_id      IS NOT NULL) / greatest(count(*), 1))::int
         AS with_invoice_pct
FROM public.email_delivery_events;

-- events_per_address: the histogram the backfill's cost follows.
-- FILTERED TO THE BACKFILL'S OWN PREDICATE. 20261006100000 derives
-- state_changed_at from STATE-PRODUCING events only:
--   event_type IN ('sent','delivered','bounced','complained','operator_reset')
-- Counting every event type would inflate the history with rows the backfill
-- never touches (failed / send_failed / delivery_delayed), and the generator
-- would then distribute those through a budget sized for the others.
SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::int AS p50,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY n)::int AS p90,
       max(n)::int                                        AS max
FROM (SELECT count(*) AS n FROM public.email_delivery_events
       WHERE event_type IN ('sent', 'delivered', 'bounced', 'complained', 'operator_reset')
       GROUP BY recipient_email) x;

-- bloat: dead_tuple_ratio = n_dead_tup / greatest(n_live_tup, 1)
SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables
WHERE schemaname = 'public' AND relname IN ('email_address_state', 'email_delivery_events');
```

It returns counts, lengths, byte sizes and category names only — **no address, no
reason text, no identifier, no row**.

## 8. Question for Supabase Support

> On a Supabase Postgres project, is there a platform-supported way to obtain an
> **isolated restore** of a project's database that boots *without* resuming
> pg_cron jobs, without dispatching queued `net.http_request_queue` entries, and
> without carrying Vault secrets — or, alternatively, a supported way to freeze
> `cron.job` and the pg_net queue for the duration of a snapshot window?
>
> Context: we need to rehearse a migration against production-scale data. A
> restored project resumes cron within ~2 minutes and holds production's provider
> API keys, so it can send real email/WhatsApp to real customers before any
> operator check runs. We considered statement triggers on `cron.job` and
> `net.http_request_queue`, but (a) your webhook debugging guide advises against
> triggers on `net.http_request_queue`, and (b) `DROP TRIGGER` requires ownership
> of these extension-managed tables, so a `GRANT TRIGGER` would let us install a
> fence we could never remove. We are not willing to take ownership of extension
> objects or join the extension-owner role on production.
>
> Specifically:
> 1. Does PITR/branching offer a "restore without background workers" or
>    maintenance-mode boot?
> 2. Is there a supported way to restore a project **without** Vault contents?
> 3. Is there a supported mechanism to pause pg_cron and pg_net at the platform
>    level for a defined window, rather than at the SQL level?
>
> Until one of these exists we rehearse on an empty project with synthetic data,
> which is safe but cannot reproduce production's physical page layout.

## 9. Consequences

- **Step 8 remains blocked** on the read-only sizing query (§7). It is no longer
  blocked on an unsupported ownership change.
- No production mutation is required by the rehearsal path at all — the only
  production access it ever needs is read-only.
- No customer PII leaves production for a rehearsal.
- Four disposable projects become one, at a fraction of the cost.
- The measured window is a lower bound; §6.3 is the caveat the runbook must carry
  into the go/no-go decision.
