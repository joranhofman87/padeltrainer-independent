# U2 canonical-Player identity — production cutover runbook

**Status: PREPARED, NOT EXECUTED.** Every production write in this document is owner-gated. Nothing
here has been run against production.

**Production contact is currently PAUSED at the owner's instruction** — including read-only access.
The figures below came from a read-only preflight taken BEFORE the 2026-08-10 infrastructure upgrade,
so treat every count, version and migration list as *stale until re-verified*. Re-running the
read-only preflight is itself a separate explicit owner gate.

Target project: **`ficwbdrzefmblkbkomzw` — "Padeltrainer-production"** (eu-central-1, **Postgres
17.6.1.155, Small compute, permanent 7-day PITR** — upgraded by the owner 2026-08-10; see §0b). A second project `krnhyizxthxwpdfzguri` ("rallyo-events") exists in the
same organisation and is **not** the target — re-assert the ref before every operation.

---

## 0. The finding that dictates deploy order

`cron.job` in production shows **`notification-email-worker` ACTIVE on `*/2 * * * *`**. The
notification email pipeline is live (42 outbox rows, all `sent`); only `notification-digest-worker`
is `active:false`. That worker claims **every** `channel='email'` pending row with no event-type
filter (`notification-email-worker/index.ts:122`), and the send gate terminally fails any row whose
payload lacks `subject`/`html` (`_shared/instant-send-gate.ts:82-89`).

`identity_challenge_enqueue` writes exactly such a row (payload = `{challenge_id, workflow}`).

> **The invariant, stated precisely: no caller that can ENQUEUE a challenge may be live in
> production before the generic worker skips `identity_verification_requested` and the identity
> sender is deployed.** Otherwise every verification challenge is claimed within two minutes and
> terminally failed: no email, burned row, and a returning anonymous booker stuck forever on
> "check your email".

**UPDATE (slice A part 1, migration `20261201100000`): the hazard is now closed in the schema, not
by ordering.** Event ownership moved into the catalogue as
`notification_event_types.dedicated_worker`, and `claim_notification_outbox_batch` gained
`p_worker_kind text DEFAULT NULL` which must match it — on the claim, the tenant-restriction skip and
the stale reap alike. Because the parameter is **defaulted** and the deployed worker calls the RPC
with three **named** arguments, the already-running production worker resolves to the new function,
receives `p_worker_kind = NULL`, and stops seeing identity rows **the moment the migration applies —
without being redeployed**. The old 4-argument overload is dropped in the same migration, because two
overloads differing only by a defaulted trailing parameter would make that 3-argument call ambiguous.

The residual risk is therefore no longer "challenges get burned" but "challenges sit `pending` until
the dedicated sender is deployed" — a visible stalled queue instead of silent terminal failures.

The constraint binds on the **callers**, not on the schema. `identity_challenge_enqueue` runs only
when a guest entrypoint calls the resolver, so the migration alone enqueues nothing; the four
challenge-producing entrypoints (`create-guest-{slot,cart,cyclus}-payment`, `submit-guest-intake`)
are what must come last. The procedure in §6 therefore applies the routing migration FIRST (which
makes the already-deployed worker safe on its own), then redeploys the generic worker, then the
sender and `verify-identity`, and only then the callers — which satisfies this invariant with margin
even if a step is retried out of order. The migration must precede the worker redeploy, not follow
it: the new worker build passes `p_worker_kind`, which the pre-migration 4-argument function does not
accept, so the reverse order stops all generic email.

This is a hard ordering constraint, not a preference. It is the reason activation slice A is a
blocker rather than a follow-up.

---

## 0b. Postgres 17 compatibility

Production was upgraded (owner-performed, 2026-08-10) to **Postgres 17.6.1.155**, **Small** compute,
with **permanent 7-day PITR** enabled and a valid recovery window. That changes the release target,
and the answer is better than it might have been: **this release has been validated on Postgres 17
from the start.**

| Item | Local / CI | Production | Verdict |
|---|---|---|---|
| Postgres major | **17** (`public.ecr.aws/supabase/postgres:17.6.1.127`) | **17** (17.6.1.155) | **same major** |
| Image build | 17.6.1.127 | 17.6.1.155 | Supabase image-build delta. Same PG major, but extension versions and platform packaging can differ, so this is **not** proof of an identical surface — it is a gap to close, not a reassurance |
| Compute | n/a | Small | PITR prerequisite satisfied |
| PITR | n/a | 7-day, permanent, valid window | rollback story below is upgraded — see §1 |

**Which gates actually run on that image, precisely** — an earlier draft of this section claimed "the
whole gate", and that was wrong:

| Gate | Engine | On production's engine? |
|---|---|---|
| `supabase db reset` — the complete migration chain from empty | Supabase PG **17.6.1.127** | **yes**, same major |
| the five real-Postgres suites (academy-deletion, backup-coverage, u2-no-email-alone-merge, u2-identity-verification, u2-identity-worker-routing) | same local PG 17 | **yes** |
| generated types drift | same local PG 17 | **yes** |
| **PGlite rehearsals** (`db:rehearse:all`) | **PGlite 0.5.1 → PostgreSQL 18.3 (wasm)** | **NO** |

The PGlite rehearsals do not run on Postgres 17 at all — they run an embedded wasm build that reports
**18.3**. That is not a defect (they are behavioural rehearsals of application logic, not a
compatibility harness, and running *ahead* of production catches removals rather than hiding them),
but the claim that every gate validates on PG17 was false and is corrected here. The
migration-chain and real-Postgres evidence — which is what a version claim rests on — does run on
Postgres 17.

**The one residual:** local is 127, production is 155. Same major, patch apart. To close it exactly,
bump the Supabase CLI (2.107 → 2.113 is available) so it pulls the newer image, then re-run the full
gate. This is worth doing once before the window, and is a local change with no production contact.

### Extension inventory (static, whole repo)

| Extension | Used by | PG17 status |
|---|---|---|
| `pg_cron` | `cron.schedule` / `cron.job` / `cron.alter_job` — the worker crons, incl. the inert identity sender | supported |
| `pg_net` | `net.http_post` in every cron command | supported |
| Vault / pgsodium | `vault.decrypted_secrets` — the cron bearer, read at tick time | supported |
| `pgcrypto` | `extensions.digest` — fingerprints in the U2 identity SQL | supported |
| GraphQL (`pg_graphql`) | not referenced by any migration or edge function in this repo | n/a |

**Removed/deprecated extensions — none present.** A repo-wide grep over `supabase/migrations/` and
`supabase/functions/` for `pgjwt`, `plv8`, `timescaledb`, `plcoffee` and `plls` returns **zero
matches**, so no U2 SQL (and no pre-existing SQL) depends on anything PG17 dropped.

**The repo DOES issue `CREATE EXTENSION`** — a earlier draft of this section said it did not, which
was wrong (the grep behind that claim was malformed and returned an empty result). All are
`IF NOT EXISTS` and all are extensions PG17 supports, so they are no-ops against the upgraded
database, but they are migration steps that run and they belong in the inventory:

| Migration | Statement |
|---|---|
| `20260117134212_aa05bda0…` | `CREATE EXTENSION IF NOT EXISTS pg_cron` |
| `20260117134212_aa05bda0…` | `CREATE EXTENSION IF NOT EXISTS pg_net` |
| `20260330204208_90a40c27…` | `CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions` |
| `20260506080500_repair_enable_pgcrypto` | `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions` |

These are already applied in production (they long predate this release), so the pending set does not
re-run them. `extensions.digest` is U2's only direct pgcrypto call.

**Still owed before release-ready:** re-run the complete gate on an image matching production's patch
level, and re-confirm the extension list against the live database during the read-only preflight —
which remains a **separate explicit owner gate** and has not been run since the upgrade.

---

## 1. Restore point and rollback capability

**SUPERSEDED 2026-08-10 — PITR is now enabled.** The table below records the pre-upgrade state and
the reasoning it forced, because the change materially improves the rollback story and the contrast
is the point.

| Item | Before the upgrade | **Now** |
|---|---|---|
| `walg_enabled` | `true` (daily physical backups) | `true` |
| `pitr_enabled` | **`false`** | **`true`, permanent, 7-day window** |
| Best restore granularity | the 03:15 UTC daily backup | **any second within 7 days** |
| Data lost by restoring to the pre-migration point | everything since the 03:15 backup — up to ~24h | **everything since the window opened** |

**Consequence, restated — and note what PITR does NOT buy.** PITR gives second-level choice of
*restore point*; it does not cap elapsed data loss. Rolling back to the instant before the first
migration still discards everything committed between that instant and the decision — if the call is
made 30 minutes in, that is 30 minutes of webhooks, bookings and payments. What changed is the floor:
before, the best available point was up to 24h stale, so a restore threw away a day of revenue no
matter how fast the decision. Now the loss is bounded by *how long you take to decide*, which is
under the operator's control. That is why step 3 records a rollback-decision deadline.

**It is still not the preferred path.** Forward-only rollback (compensating migration + redeploy of
the recorded previous edge-function versions, §3) stays first choice, because a PITR restore also
discards every legitimate booking and payment taken during the window, and the window is when
traffic is paused rather than absent — Mollie webhooks keep processing per §6 step 2. PITR is the
answer to "the migration corrupted something we cannot compensate", not to "a function misbehaved".

**Record the exact recovery-window start immediately before step 6**, and write the rollback-decision
deadline next to it. Verifying the window is live is the first step of the window (§6 step 1), not an
assumption — "enabled" is not the same as "recoverable".

---

## 2. Exact pending migration set

Verified two independent ways (`supabase migration list --linked` and `db push --dry-run --linked`):
**607 applied, `remote-only = 0`** — production carries no history the repo does not know about, so
there is nothing to repair and no `migration repair` step in this runbook.

Pending on the integrated #647 head (**19**, in apply order). The first 17 were confirmed against a
literal `supabase db push --dry-run --linked`; entries 18–19 were added by slice A and are listed
from the repository, because production access is paused. **Re-run the dry run and reconcile it with
this table before applying anything** — if it disagrees, stop.

| # | Migration | Origin |
|---|---|---|
| 1 | `20261113100000_u1a_academy_player_memberships` | U1a (#641) |
| 2 | `20261114100000_u1b_membership_backfill_manifest` | U1b (#642) |
| 3 | `20261115100000_u1c_prereq_membership_repoint` | U1c-p1 (#643) |
| 4 | `20261116100000_u1c_prereq_deletion_preflight` | U1c-p2 (#644) |
| 5 | `20261117100000_u1c_prereq_academy_deletion` | U1c-p3 (#645) |
| 6 | `20261118100000_u1c_prereq_backup_export` | U1c-p4 (#646) |
| 7 | `20261119100000_u2_no_email_alone_merge` | U2 (#647) |
| 8 | `20261120100000_u2_explicit_claim` | U2 (#647) |
| 9 | `20261121100000_u2_uuid_idempotent_create` | U2 (#647) |
| 10 | `20261122100000_u2_merge_keeps_create_commands` | U2 (#647) |
| 11 | `20261123100000_u2_intake_email_optional` | U2 (#647) |
| 12 | `20261124100000_u2_rebook_group_guest_uuid_create` | U2 (#647) |
| 13 | `20261125100000_u2_the_command_is_the_only_door` | U2 (#647) |
| 14 | `20261127100000_u2_person_keyed_writes` | U2 (#647) |
| 15 | `20261128100000_u2_rebook_person_keyed_members` | U2 (#647) |
| 16 | `20261129100000_u2_identity_verification` | U2 (#647) |
| 17 | `20261130100000_u2_integration_catalog_and_backup` | U2×U1c integration (#647) |
| 18 | `20261201100000_u2_identity_worker_routing` | U2 slice A (#647) |
| 19 | `20261202100000_u2_identity_worker_cron_inert` | U2 slice A (#647), installs the sender cron INACTIVE |

This table has been wrong twice, both times caught by review, and both times it would have HALTED a
correct deployment because step 6 refuses to proceed unless the dry run matches exactly. First it
said 15 and claimed #645 shipped no dated migration (it is `20261117100000`). Then it said 17 after
slice A added two more. Treat the number as a live fact to re-derive, not a constant. Numbers 1–6 are
already merged to `main`; 7–19 arrive with #647.

**Never** use `supabase db reset --linked`, `--include-seed`, a blind `db push`, or hand-edited
production SQL. No contraction, no legacy-column drop: `guest_player_id` stays private and intact.

---

## 3. Edge-function deployment manifest

Computed from the import graph (`origin/main...HEAD`) and independently cross-checked with grep.
**Zero additional `_shared` importers** — the five changed shared modules
(`guest-players`, `guest-whatsapp-optin`, `identity-continuity`, `identity-intent`,
`identity-verify-token`) are imported only by entrypoints already in the list.

| Function | Current prod version | Note |
|---|---|---|
| `create-guest-slot-payment` | v31 (2026-08-07) | changed |
| `create-guest-cart-payment` | v25 (2026-08-07) | changed |
| `create-guest-cyclus-payment` | v29 (2026-08-07) | changed |
| `submit-guest-intake` | v47 (2026-08-07) | changed |
| `create-manual-player` | v33 (2026-08-07) | changed |
| `mollie-webhook` | v66 (2026-08-07) | changed |
| `verify-identity` | **not deployed** | new (#647) |
| `admin-academy-deletion` | **not deployed** | new (#645) |
| `notification-email-worker` | v22 (2026-08-07) | **changed in slice A** — passes `p_worker_kind`; safe only AFTER migration 18 |
| `notification-identity-worker` | **not deployed** | **new (slice A)** — the dedicated sender; its cron ships INACTIVE (migration 19) |

The "current prod version" column is the rollback table: redeploy that version to revert.
108 functions are deployed in total.

---

## 4. Non-PII production baseline

Captured read-only inside `BEGIN READ ONLY`. Counts and aggregates only — no names, emails, phones
or addresses were selected or stored. **Re-run immediately before and after the window and diff.**

Baseline SQL: `scripts/db/prod-baseline.sql`. It reports: persons total/with-login/without-login, profiles, guest_players,
person_links coverage by source, unlinked sources, integrity counters
(multi-profile persons, orphaned links, persons with no link), bookings and invoices by key
(person/guest/player), invoice totals and paid totals, and the largest-academy slice.

**Figures are deliberately not reproduced in this file.** An earlier draft pinned a named academy's
exact booking counts and invoice revenue into git history for good; that is customer-identifiable
commercial data and it does not need to live here. Run the script to get current numbers — what the
cutover needs is the BEFORE/AFTER diff, not a committed snapshot. The structural findings below carry
no figures and are the part worth writing down.

### What the 2026-08-10 baseline established (structure, not figures)

Run `scripts/db/prod-baseline.sql` for the numbers. What matters and does not change run to run:

| Invariant | Result |
|---|---|
| orphaned `person_links` | **0** |
| persons with no link | **0** |
| persons with more than one profile source | **0** |
| profiles without a link / guests without a link | **0 / 0** |
| bookings carrying `person_id` | **100%** |
| invoices carrying `person_id` | all but **one** |
| largest academy's guests linked to a person | **100%** |
| invoices with NULL status | **0** |

**Read this before the window:** the canonical identity foundation is already fully populated and
internally consistent — every legacy source resolves to a person, there are no orphans, and every
booking already carries a `person_id`. The U2 migrations are additive on top of a healthy base,
which is the single biggest de-risking fact in this packet.

**Known pre-existing datum, not cutover drift:** exactly **one invoice of 443 has no `person_id`**
(442/443). Record it now so the after-diff does not misread it as damage. Everything else is 100%.

Also known-true at preflight time: `academy_player_memberships`, `membership_backfill_*`,
`player_create_commands`, `identity_verification_challenges` and `identity_verify_key_state` do
**not** exist in production (their migrations are pending); `persons`, `person_links` and
`account_deletion_audit` do. `email_address_state` holds **18 suppressed addresses**;
`is_email_suppressed(text)` exists.

---

## 5. The U1 membership backfill — why it is a window step, not a preflight step

`scripts/db/u1a-membership-inventory.mjs:749` reads `academy_player_memberships`, which does not
exist in production until migration #1 applies. It also requires a direct pg session
(`sessionSource.connect()`). So the inventory **cannot** be computed against production beforehand.

Order is therefore fixed:

1. apply migrations (creates the table, empty by design);
2. run the inventory **read-only** and record eligible / unresolved-by-class / conflicting counts;
3. **stop.** The backfill itself stays owner-gated and must not run until retain-and-scrub (slice B)
   is review-clear and deployed.

The inventory is read-only by construction (REPEATABLE READ + READ ONLY, caller-supplied `asOf`,
source fingerprints before and after proving zero mutation) and resolves every subject **exclusively
through `person_links`** — never by email or phone, matching the owner's identity rule.

---

## 6. Maintenance-window procedure

**Do not begin until slices A and B are review-clear and #647 is merged.**

1. **Announce + enable maintenance mode** for human-facing traffic only.
2. **Keep payment/webhook processing available** — `mollie-webhook`, `mollie-callback`,
   `verify-mollie-payment`, `resend-webhook`, `stripe-subscription-webhook` must keep accepting
   provider callbacks. Dropping a Mollie callback loses a payment result. Do not pause those.
3. **Verify the PITR recovery window is live and record its start**, then take a fresh backup and
   record its id + timestamp. "Enabled" is not "recoverable" — confirm the window covers now before
   trusting it. Write down the rollback-decision deadline
   (recommend: decide within 30 minutes of the first smoke failure).
4. **Capture the "before" baseline** (§4) and store it.
5. **Apply the routing migration FIRST — before the worker redeploy.**
   `20261201100000_u2_identity_worker_routing.sql` is what makes the ALREADY-DEPLOYED generic worker
   safe, via the `p_worker_kind DEFAULT NULL`. It must go first, and the order matters in the
   opposite direction to an earlier draft of this runbook: the new `notification-email-worker` build
   passes `p_worker_kind` explicitly, so deploying it BEFORE the migration would have it call a
   4-argument function with a 5th argument — PostgREST rejects the call and **all generic email
   stops**. Codex round 1 of slice A caught that inversion.

   *(§0 states the real invariant precisely: nothing that can ENQUEUE a challenge may be live before
   the sender and the worker skip are. The schema alone enqueues nothing — `identity_challenge_enqueue`
   only runs when a guest entrypoint calls the resolver — so the binding constraint is on the CALLERS
   in step 7c, not on the migration itself. Deploying the worker fix first removes the race entirely
   and makes the ordering robust even if a step is retried out of sequence.)*
6. **Apply the remaining migrations** — `supabase db push --linked` after a final `--dry-run` whose
   list matches §2 exactly (the routing migration is entry 18 and the inert sender cron is
   entry 19, so in practice steps 5 and 6 are a single `db push` that ends with both). If the list differs in any way: **stop**, do not repair,
   escalate.
7. **Deploy the edge functions** from clean updated `main`, in this order:
   a. **`notification-email-worker`** — the redeploy §0 promises. It is safe only AFTER step 6,
      because this build passes `p_worker_kind`, which the pre-migration function does not accept;
   b. the identity sender (`notification-identity-worker`);
   c. `verify-identity` (the link target must exist before any link can be sent);
   c2. **Run the non-side-effecting sender verification now** (§10, slice A): invoke
      `notification-identity-worker` once and require
      `{"claimed":0,"sent":0,"refused":0,"failed":0}`. It proves the function deployed,
      authenticated as service_role, resolved the new RPC signature, and that the worker-kind
      partition is live — before anything can enqueue a challenge. Do not continue on any other
      result;
   d. **only then** the challenge-producing callers — the three guest payment entrypoints and
      `submit-guest-intake` — plus `create-manual-player` and `mollie-webhook`;
   e. `admin-academy-deletion`.
8. **Confirm the frontend** (Vercel) is serving the build that matches the deployed backend.
9. **Set secrets / config** (§8) — owner-performed.
10. **Activate the sender** — owner-performed, last.
11. **Run the U1 inventory read-only** (§5) and record counts. Do **not** back-fill yet.
12. **Capture the "after" baseline** and diff against step 4. Every count must be explained: totals
    must not drop; the large academy's guest_players / bookings / invoices must be unchanged
    (these migrations are additive).
13. **Read-only payment/invoice reconciliation** — invoice count, paid count, total and paid sums
    identical before/after; no invoice orphaned from its person/guest key.
14. **Smoke flows** (§7).
15. **Reopen traffic**, then monitor 30–60 minutes (§7.4).

---

## 7. Smoke flows

1. Create one **test Player** through the canonical UUID command and assert the response carries a
   `person_id` and no `guest_player_id`.
2. **Returning anonymous verification**: book as an anonymous contact that already has candidates →
   expect `verification_required`, exactly one email to `contact_normalized`, and no booking hold,
   invoice, Mollie call or Player creation before verification.
3. **Explicit selection**: open the link, choose an existing Player; then repeat with "someone new".
   Neither may auto-merge.
4. **Resumed booking** completes against the selected canonical person.
5. **Normal first-time booking** (no candidates) still creates a new Player unchanged.
6. **Account-deletion preview/refusal** on a synthetic account — never on a real customer.

### 7.4 Monitoring window
Watch Supabase function logs, the Slack `edge_function_error` channel, and PostHog for the identity
funnel. Alert thresholds are proposed in the observability slice (§10).

---

## 8. Required secrets / configuration — names only

Never printed, read back, copied or committed. Owner sets these.

| Name | Purpose | Status |
|---|---|---|
| `IDENTITY_VERIFY_TOKEN_KEY_V1` | HMAC signing key for the verification capability (64 hex chars = 32 random bytes) | **not yet provisioned** |
| `RESEND_API_KEY` | already used by the notification email worker | present |
| `SUPABASE_SERVICE_ROLE_KEY` | already present | present |
| `RESEND_WEBHOOK_SECRET` | bounce/complaint ingestion | present |

The DB stores only `key_version`, never the HMAC and never the secret, so a database read cannot
reconstruct a live link.

---

## 9. Rollback and fix-forward

Triggers to roll back rather than fix forward: any evidence of data loss or misassignment; the
large academy's counts changing unexpectedly; identity resolution assigning an existing person
without verification.

| Layer | Action |
|---|---|
| Frontend | revert the Vercel deployment to the previous build |
| Edge functions | redeploy the previous version from the table in §3 |
| Schema | **forward-only compensating migration** — never a destructive down-migration |
| Membership backfill | manifest-owned rollback (`membership_backfill_runs` / `_items` record every row written) |
| Catastrophic, when nothing can be compensated | **PITR restore to the pre-migration timestamp recorded in step 3** — second-level choice of point, discards everything committed since it (see §1). Requires explicit owner instruction. |
| Last resort, only if PITR is verified unavailable | restore the latest physical backup — coarser and much lossier; the id/timestamp must be re-read at the time, **not** taken from this document (the `1333259935` / 2026-08-10 03:15:16Z figure recorded here predates the infrastructure upgrade and is stale) |

Because the migrations are additive (new tables, new functions, new nullable columns), a
compensating migration can drop the new surface without touching existing rows. That is the intended
path.

---

## 10. Remaining work before this runbook can be executed

| Slice | What it must deliver | Status |
|---|---|---|
| **A — identity sender** | production-capable sender for `identity_verification_requested`; generic worker must skip identity rows; target `contact_normalized`; required-transactional (no marketing suppression); honour `is_email_suppressed`; token derived at send only; NL+EN copy; idempotent; per-address cap preserved; link → `/verify-identity` | **BUILT — full gate green, Codex rounds 1–3 applied.** Migrations 18–19, `notification-identity-worker`, `_shared/identity-send-gate.ts`, 13 handler + 12 gate + 10 wiring tests, 22 real-pg routing assertions. Deployment/verification/rollback below. **Not deployed, cron INACTIVE.** |
| **B — retain-and-scrub (OD-08)** | replace the interim membership refusal; detach auth transactionally, preserve `persons.id` + memberships + financial/audit evidence, pseudonymize the rest, idempotent, auditable, single safe server command | **not started** |
| **C — observability** | non-blocking non-PII identity-funnel telemetry + funnel/dashboard + alert thresholds | **not started** |

### Slice A — deployment, verification and rollback (non-side-effecting)

**Secrets required (names only — never print or commit a value).** All are already-existing
conventions except the first, which is new for this slice:

| Name | Purpose | New? |
|---|---|---|
| `IDENTITY_VERIFY_TOKEN_KEY_V1` | 32 random bytes, hex (64 chars). Signs the capability. Must exist on `notification-identity-worker` **and** `verify-identity`, identical value. | **new** |
| `RESEND_API_KEY` | provider send | existing |
| `SITE_URL` | link base, must be the public origin so the link resolves to `/verify-identity` | existing |
| `NOTIFICATION_FROM_EMAIL` | envelope From | existing |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | drainer identity | existing |

Generate with `openssl rand -hex 32`. The **same** value must be set on both functions or every link
will fail verification; the worker refuses to mint (non-terminally) when the key is absent, so a
missing key stalls the queue rather than burning it.

**Verification without sending anything real.** The sender only ever acts on rows it claims, so the
safe check is that it claims nothing and exits cleanly:

1. Invoke the function once. With no `identity_verification_requested` rows pending it must return
   `{"claimed":0,"sent":0,"refused":0,"failed":0}`. That alone proves: it deployed, it authenticated
   as service_role, the RPC signature resolved, and the worker-kind partition is live.
2. Confirm the generic worker is unaffected — its next scheduled run should log its usual counts.
3. Only then deploy the challenge-producing entrypoints.

**Rollback.** The sender is additive and claims a partition nothing else touches, so rolling it back
cannot strand another worker's rows:

| To undo | Do |
|---|---|
| the sender | Disable its schedule. Rows it already holds are `processing`, and **nothing releases them once the worker is gone** — they become claimable again only after the stale window (15 min) via a later run of the *same* worker kind. So before removing it, either let the in-flight batch finish, or accept that those rows wait. Rows never claimed stay `pending`; nothing is lost either way. |
| the routing migration | `UPDATE notification_event_types SET dedicated_worker = NULL WHERE key = 'identity_verification_requested';` — the generic worker resumes claiming them, **and will terminally fail every one**, because the payload has no subject/html. Only do this when there are **zero** identity rows in `pending` OR `processing`: `SELECT count(*) FROM notification_outbox WHERE event_type='identity_verification_requested' AND status IN ('pending','processing');` must return 0 first. |
| a bad key | Rotation is two steps, not one: `identity_verify_key_state` carries `CHECK (current_version >= min_mintable_version)`, so raising the floor to 2 while `current_version` is still 1 **fails the constraint**. Set `current_version = 2` (and provision `IDENTITY_VERIFY_TOKEN_KEY_V2` on both functions) *first*, then raise `min_mintable_version` to 2. In-flight V1 links stop verifying at that point, and the worker refuses to mint below the floor. |

### Open: challenge rows outlive their owner (retention gap, both halves)

A challenge belongs to its owner through `owner_type`/`owner_id`, a polymorphic pair with **no
foreign key**, so nothing cascades from it. A challenge whose `selected_person_id` is NULL — every
unconsumed one, and every consumed "someone new" — survives the deletion of the academy or trainer
that collected it, still carrying `contact_normalized`, an email address.

Both halves are the same problem and should be fixed once:

- **academy:** `academy_delete_confirmed` executes a fixed statement list (two overlays, this
  academy's memberships, the academy root). Nothing deletes an owner-scoped challenge.
- **trainer:** `delete-user-data.ts` removes a trainer's guests and anonymises the trainer shell
  without touching trainer-owned challenges.

An interim attempt to close the academy half by adding an `owner_scoped` predicate to
`academy_deletion_deleted_scope()` was **withdrawn**: that predicate feeds the preview and the audit,
which is stamped from `v_preview->'deleted'`, so it would have made the flow report rows as deleted
while they were still present. A count that lies is worse than a count that is merely incomplete.
Preview, execution and audit now agree, which is the honest state. Closing it properly is surgery on
the execution path plus the trainer flow, and belongs in its own reviewed slice — a natural companion
to slice B (OD-08), which is already about scrubbing identity data on deletion.

### Open backup findings, recorded rather than half-fixed

Both came out of the Codex integration review and are real. Neither is a reason to hold the cutover
by itself, but both should land before the backup is ever relied on for a restore:

1. **`player_create_commands` is not snapshot-atomic with `persons`.** Export groups are written
   sequentially and each is its own snapshot, so a create committed between the `persons` snapshot
   and the `player_create_commands` snapshot yields a backup whose receipt references a person the
   backup does not contain — on restore, either an FK failure or the loss of the very mapping that
   prevents duplicate Players. Note this is a **property of the existing group design**, not
   something this change introduced: `persons` and `person_links` already have the same split. The
   fix is a declared identity export group (`persons` + `person_links` + `player_create_commands`),
   which must be weighed against the group byte bound, so it belongs in its own reviewed slice
   rather than in an integration checkpoint.
2. **`rebook_member_attempts` is not backed up.** It is the first-writer-wins binding that stops a
   known create receipt being replayed into a different rebook group. After a restore the receipt
   survives but the binding does not, so a replay through another same-owner group would insert a
   fresh binding and be trusted. The coverage derivation misses it because it has no `person_id`
   column, and it cannot simply be added: its primary key is `creation_request_id`, not the single
   `id` the exporter orders on, and the exporter hardcodes `ORDER BY t.id`, so it needs exporter or schema work.

Slice A additionally requires a **new SECURITY DEFINER RPC** exposing `contact_normalized`,
`owner_type`, `owner_id` and `key_version` for a challenge: the challenge table is `REVOKE`d even
from `service_role`, and BYPASSRLS does not bypass a table ACL, so no direct read is possible.
