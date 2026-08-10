# U2 canonical-Player identity — production cutover runbook

**Status: PREPARED, NOT EXECUTED.** Every production write in this document is owner-gated. Nothing
here has been run against production. The preflight that produced these numbers was read-only.

Target project: **`ficwbdrzefmblkbkomzw` — "Padeltrainer-production"** (eu-central-1, Postgres
17.6.1.127, ACTIVE_HEALTHY). A second project `krnhyizxthxwpdfzguri` ("rallyo-events") exists in the
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
are what must come last. The procedure in §6 therefore deploys the worker fix first, applies
migrations, deploys the sender and `verify-identity`, and only then the callers — which satisfies
this invariant with margin even if a step is retried out of order.

This is a hard ordering constraint, not a preference. It is the reason activation slice A is a
blocker rather than a follow-up.

---

## 1. Restore point and rollback capability

| Item | Value |
|---|---|
| `walg_enabled` | `true` (daily physical backups) |
| **`pitr_enabled`** | **`false`** |
| Latest usable restore point | **2026-08-10 03:15:16 UTC**, `COMPLETED`, id `1333259935` |
| Retained backups | 7 (2026-08-03 → 2026-08-10) |

**Consequence:** there is no arbitrary-timestamp restore. A restore-based rollback discards every
booking, payment and invoice written since the daily backup. Rollback must therefore be
**forward-only** (compensating migration + previous edge-function versions), with restore reserved
as a true last resort. Enabling PITR before the window is an owner decision (see §9).

---

## 2. Exact pending migration set

Verified two independent ways (`supabase migration list --linked` and `db push --dry-run --linked`):
**607 applied, `remote-only = 0`** — production carries no history the repo does not know about, so
there is nothing to repair and no `migration repair` step in this runbook.

Pending on the integrated #647 head (**17**, in apply order — this is the literal
`supabase db push --dry-run --linked` output, re-verify it immediately before applying):

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

An earlier draft of this table said 15 and claimed #645 shipped no dated migration. That was wrong —
`20261117100000` is #645's, and `20261130100000` is the integration fix — and because step 5 of §6
refuses to proceed unless the dry run matches this list exactly, the error would have stopped a
correct deployment. Codex round 1 caught it. Numbers 1–6 are already merged to `main`; 7–17 arrive
with #647.

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
| `notification-email-worker` | v22 (2026-08-07) | **will change in slice A** |

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
3. **Take a fresh backup and record its id + timestamp.** Write down the rollback-decision deadline
   (recommend: decide within 30 minutes of the first smoke failure).
4. **Capture the "before" baseline** (§4) and store it.
5. **Deploy the worker fix FIRST, before any migration.** `notification-email-worker` must already
   be the version that skips `identity_verification_requested` (slice A) before the schema that can
   enqueue such a row exists. Deploying it first is safe and idempotent: the skip is inert until the
   event type exists.

   *(§0 states the real invariant precisely: nothing that can ENQUEUE a challenge may be live before
   the sender and the worker skip are. The schema alone enqueues nothing — `identity_challenge_enqueue`
   only runs when a guest entrypoint calls the resolver — so the binding constraint is on the CALLERS
   in step 7c, not on the migration itself. Deploying the worker fix first removes the race entirely
   and makes the ordering robust even if a step is retried out of sequence.)*
6. **Apply migrations** — `supabase db push --linked` after a final `--dry-run` whose list matches
   §2 exactly. If the list differs in any way: **stop**, do not repair, escalate.
7. **Deploy the remaining edge functions** from clean updated `main`, in this order:
   a. the identity sender;
   b. `verify-identity` (the link target must exist before any link can be sent);
   c. **only then** the challenge-producing callers — the three guest payment entrypoints and
      `submit-guest-intake` — plus `create-manual-player` and `mollie-webhook`;
   d. `admin-academy-deletion`.
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
| Last resort | restore backup `1333259935` (2026-08-10 03:15:16Z) — **loses everything since**; requires explicit owner instruction |

Because the migrations are additive (new tables, new functions, new nullable columns), a
compensating migration can drop the new surface without touching existing rows. That is the intended
path.

---

## 10. Remaining work before this runbook can be executed

| Slice | What it must deliver | Status |
|---|---|---|
| **A — identity sender** | production-capable sender for `identity_verification_requested`; generic worker must skip identity rows; target `contact_normalized`; required-transactional (no marketing suppression); honour `is_email_suppressed`; token derived at send only; NL+EN copy; idempotent; per-address cap preserved; link → `/verify-identity` | **not started** |
| **B — retain-and-scrub (OD-08)** | replace the interim membership refusal; detach auth transactionally, preserve `persons.id` + memberships + financial/audit evidence, pseudonymize the rest, idempotent, auditable, single safe server command | **not started** |
| **C — observability** | non-blocking non-PII identity-funnel telemetry + funnel/dashboard + alert thresholds | **not started** |

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
