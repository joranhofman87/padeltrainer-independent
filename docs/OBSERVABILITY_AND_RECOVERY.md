# Observability & Recovery

One-line purpose: the operational index for padeltrainer — how the app tells you it is broken, how you check its health, and how you recover money/data when it is.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

This is the **operational layer** map. It points to the deep, subsystem-specific docs rather than duplicating them. Payment-path operations live under [`docs/payments/`](payments/) — this file is the index that routes you there. The full gap analysis behind the alerting model is [`docs/audits/OBSERVABILITY_AND_ALERTING_AUDIT.md`](audits/OBSERVABILITY_AND_ALERTING_AUDIT.md); open backlog items live in [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md).

Deploy reality: edge functions + DB migrations do **not** auto-deploy (owner applies manually; CI only validates). Frontend auto-deploys via Vercel on merge to main. So an alert wired in code is not live until the owner redeploys the function.

---

## 1. Alerting — how the app tells you it is broken

There are exactly **three** proactive channels. Slack is the only proactive *server-side* one.

| Channel | Sink | Sees | Where |
|---|---|---|---|
| **A. Slack** | ops Slack channel | edge-function money/auth failures, cron partial failures | `slack-notify` edge fn + `_shared/edge-slack.ts` |
| **B. Cron wrapper** | Slack (via A) | a wired cron sub-job returning non-2xx | `api/_lib/cron.ts:59` `alertCronFailure` |
| **C. Client PostHog** | eng PostHog dashboard | **browser** errors only | `src/lib/logger.ts:68` `sendToMonitoring` → `ph.capture('$exception')` |

**Coverage varies per function AND per branch.** 41 of 108 entrypoints call the canonical Slack helper directly (recounted 2026-08-08), plus 8 legacy inline wrappers — but several alerting functions still have silent branches (see the PARTIAL backlog items); the rest emit only `console.*` to the Supabase log drain that nobody watches. The remaining silent gaps are the backlog.

### Channel A — Slack backbone
- **Canonical helper:** `supabase/functions/_shared/edge-slack.ts` — `notifySlackEdge(event, data)` (`:4`) and `notifySlackEdgeError(fn, msg, ctx)` (`:22`). Invokes the `slack-notify` edge fn with the service-role key. **Never throws** (try/catch swallow at `:17`) — alerts must not break primary flows. **Prefer this over new inline wrappers.**
- **`slack-notify` edge fn:** formats Block Kit; `EVENT_CONFIG` = 14 configured events (recounted 2026-08-08: signups ×3, booking_created, payment_received, profile_published, subscription_purchased, new_review, account_deletion, new_club_claim, edge_function_error, new_registration, registration_error, cron_heartbeat — `slack-notify/index.ts:14-28`; unknown events render with a generic title). Auth = Bearer must equal `SUPABASE_SERVICE_ROLE_KEY`.
- **Structural risk:** if `SLACK_WEBHOOK_URL` is unset, `slack-notify` 500s with `console.error` only — no self-alert, no dead-man's-switch. A misconfigured webhook silences **everything** silently. See backlog OBS-P0-1.
- **8 legacy inline wrappers** (recounted 2026-08-08: `create-guest-cart-payment`, `create-guest-slot-payment`, `create-guest-cyclus-payment`, `create-invoice-payment`, `create-mollie-payment`, `stripe-subscription-webhook`, `mollie-webhook`, `verify-mollie-payment`) predate the helper and duplicate auth-header logic — drift risk. New alerts route through `edge-slack.ts`.

### Channel B — Cron alerting
- `alertCronFailure` (`api/_lib/cron.ts:59`) fires only when a sub-job returns `ok:false`. Wired into `api/cron/daily-emails.ts` and `api/cron/daily-maintenance.ts` (schedules in `vercel.json`: `0 12 * * *` and `0 6 * * *`).
- Many crons also self-alert internally (e.g. `invoice-health-check/index.ts:166`), closing the "HTTP 200 with partial failures inside" blind spot for wired jobs.
- **Single-flight (CRON-SF-WEDGE is CLOSED — see below):** the session-scoped `try_lock_cron_job` / `unlock_cron_job` advisory pair was **retired in 10c-b** (`20261007100000_cron_durable_lease.sql` drops both). Three of the four workers rely on their existing atomic claim; `invoice-health-check` takes a **durable owner-token + `locked_until` lease** (`acquire_cron_lease` / `renew_cron_lease` / `release_cron_lease`).
- ~~Gap: no heartbeat~~ **Resolved (2026-08-08):** `sendCronHeartbeat` pings daily from `daily-maintenance` (`api/cron/daily-maintenance.ts:53`) — a silent morning signals pipeline death (OBS-P1-2). Noticing the ABSENCE externally remains OBS-P0-1.

### ✅ CLOSED — session-scoped cron single-flight lock (CRON-SF-WEDGE)
**The hazard.** `try_lock_cron_job` was a **session-level** `pg_try_advisory_lock`. It and its `unlock_cron_job` ran as **separate pooled PostgREST requests with no session affinity**, so the unlock could execute on a *different* backend than the one that acquired the lock — leaving the lock **held on the acquiring session until that pooled connection was recycled**. A healthy run could therefore wedge the job (every later tick saw `try_lock` return false and bailed) for an unbounded time.

**The fix (10c-b, migration `20261007100000_cron_durable_lease.sql`).** Resolved per worker against its real concurrency boundary, rather than by substituting another lock. Both advisory RPCs are **dropped**, so the class cannot be reintroduced by habit.

| Worker | Decision | Why that is sufficient |
|---|---|---|
| `notification-email-worker` | lock **removed** | `claim_notification_outbox_batch` claims `FOR UPDATE SKIP LOCKED` and stamps a per-run worker token, so concurrent invocations take **disjoint** rows; `record_notification_send_result` is token-guarded, so a superseded run's late write no-ops. |
| `notification-whatsapp-worker` | lock **removed** | Same atomic claim, same token guard. |
| `process-onboarding-emails` | lock **removed** | Every item passes `claim_onboarding_email_queue_item`, a per-row atomic CAS (`pending → sent`). Its missing-template path is separately CAS-guarded (`WHERE status='pending'`) so overlapping runs cannot both own — or both alert on — one failure. |
| `invoice-health-check` | **durable lease** | The only one with **no** atomic claim: a read-only sweep whose output is operator Slack alerts, so two overlapping runs double-post. Whole-run exclusion is genuine here. |

**Why the lease cannot wedge or be stolen.** Expiry is **data** (`locked_until`), so a crashed holder frees the job at TTL with no connection recycling and no operator action. Acquisition is a single atomic `INSERT … ON CONFLICT DO UPDATE … WHERE locked_until <= now()`, evaluated under the row lock `ON CONFLICT` already holds, so two racing acquirers cannot both win. `release_cron_lease` and `renew_cron_lease` are **owner-token CAS**: a wrong or stale token changes nothing. Release is **idempotent** — the first live-owner release returns true and increments `release_count` once; any repeat returns false and leaves telemetry untouched. TTL is bounded 30–3600 s (zero would hand out an already-expired lease so every caller "wins"; unbounded would recreate the wedge).

**NOT affected:** `notification-digest-worker` (10c-a3) never used this lock — the SQL state machine's atomic `claim` is its boundary.

**Evidence.** `src/test/cronDurableLease.realpg.test.ts` (real multi-connection Postgres; backend distinctness asserted via `pg_backend_pid()`) covers acquire-on-A/release-from-B, a backend that disconnects mid-run, 2- and 8-way acquisition races, stale-token renew/release, and release idempotency. `src/test/onboardingMissingTemplateCas.realpg.test.ts` covers the missing-template ownership CAS. `scripts/db/rehearse-phase45-integrity.mjs` rehearses the lease end to end (25 checks). All are mutation-pinned: deleting the acquisition CAS predicate fails 4 of 8 lease assertions, and dropping the release liveness guard fails the idempotency assertions.

### Channel C — Client PostHog
`src/lib/logger.ts`: `logger.error` always captures `$exception`; `logger.warn` captures only in prod; `logger.info` is a no-op in prod. **Browser only — never sees an edge-function or server failure.**

---

## 2. Audit trails — the durable record

### Payment audit log (`payment_audit_log`)
- **Table:** migration `20260324103326_*.sql`. Service-role only — RLS **enabled** with a deny-all client policy (`FOR ALL USING (false)`); service_role reaches it via its RLS bypass (claim corrected 2026-08-08).
- **Writer:** `supabase/functions/_shared/payment-audit.ts` — `writePaymentAuditLog(supabase, event)`. **Best-effort, never throws** (a failed audit insert must never break a money write).
- **Vocabulary:** `PaymentAuditStatus` in the same file — the shared status enum producers + reconciliation agree on (`webhook_received`, `invoice_marked_paid`, `booking_marked_paid`, `duplicate_webhook_ignored`, `amount_mismatch_blocked`, `payment_for_cancelled_invoice`, `payment_for_cancelled_booking`, `payment_for_unknown_invoice`, `no_connected_mollie_account`, …).
- **Why it exists:** money-path outcomes leave a queryable trail that **survives a Slack outage** (paid-path terminal outcomes covered; unroutable-metadata and failed/canceled/expired deliveries write no terminal row yet — see `PAYMENT_INVARIANTS.md` #13, corrected 2026-08-08). This is the primary forensic surface when reconciling a payment dispute.
- Full design: [`docs/payments/PAYMENT_OBSERVABILITY_AUDIT.md`](payments/PAYMENT_OBSERVABILITY_AUDIT.md).

### Email delivery tracking
- **Tables:** migration `20260615110000_email_delivery_tables.sql`; write RPC `record_email_event` (`20260615110010_*.sql`); invoice-facing status RPCs (`20260615110030_invoice_delivery_status_rpcs.sql`).
- **Ingestion point:** `supabase/functions/resend-webhook/` consumes Resend bounce/delivery events. Its formerly-silent catch is fixed (verified 2026-08-08: per-event alert callback + a top-level catch that logs and Slack-alerts — OBS-P1-4 resolved); a webhook failure now surfaces instead of silently going stale.
- Data-integrity gate: `db:rehearse:email` / `db:rehearse:invoices-delivery`.

---

## 3. Health & reconciliation checks

### `reconcile_payments(_since interval)` RPC
- **Migration:** `20260705140000_reconcile_payments.sql`. **Read-only** — RETURNS findings, never writes or fixes. Admin-only (`SECURITY DEFINER` + `has_role(auth.uid(),'admin')` gate; execute revoked from PUBLIC, granted to `authenticated`).
- **Returns** one row per finding: `(check_name, severity, entity_kind, entity_id, detail jsonb)`.
- **Checks it runs:** `stranded_invoice` (P1, has a Mollie payment id but not paid/cancelled), `invoice_paid_bookings_unpaid` (P1), `cancelled_booking_on_paid_invoice` (P1), `overlapping_active_invoices` (P0, same booking on two active invoices), `duplicate_rebook_group_invoice` (P0), `stale_hold` (P1, expired holds still occupying capacity), and more.
- **Use:** intended as a daily operator check. **Owner deploy pending** for prod (apply `20260705140000`).
- Full plan: [`docs/payments/PAYMENT_RECONCILIATION_PLAN.md`](payments/PAYMENT_RECONCILIATION_PLAN.md).

### `invoice-health-check` edge fn
- `supabase/functions/invoice-health-check/index.ts` — cron-run (daily-maintenance), single-flight via the durable `cron_job_leases` lease. Scans for invoice anomalies via `_shared/invoice-health-checks.ts`; self-alerts to Slack (`:166`) with `status: anomalies_found | healthy`.

### `invoice-storage-gc` edge fn (Theme B / storage lifecycle)
- `supabase/functions/invoice-storage-gc/index.ts` — cron-run (daily-maintenance), service-role/admin only. Reaps orphaned objects from the private `invoices` bucket: an object is LIVE iff its key prefix matches some invoice's `render_path` (stamped by `generate-invoice`, B1); unmatched objects are deleted only after a **90-day grace** on `updated_at`, **capped at 200/run**. Report-vs-apply gate + the cap are the pure `planInvoiceGcDeletion` helper (`_shared/invoice-storage-gc.ts`).
- **Report-only by DEFAULT** — the cron ships without `apply`, so it lists orphans to Slack but deletes nothing. After one clean report, flip the `daily-maintenance` entry to `body: { apply: true }` to enable deletion. Self-alerts whenever orphans are found or deleted; quiet when there's nothing to do.
- Walks `storage.objects` via the service-role-only `invoice_gc_list_objects` RPC (the `storage` schema is not PostgREST-exposed). Keyset-paginated both sides with a 110s budget. Any classification doubt (unknown suffix, missing/invalid timestamp, fresh upload) → KEEP.
- Related: account deletion (`_shared/delete-user-data.ts`) also removes the deleted user's avatar/banner objects from the public `avatars` bucket (R06); org logos under `clubs/…` are a separate follow-up sweep.

### `notif_digest_worker_liveness()` — the ONLY signal that covers "never invoked"
- **Migration:** `20261012100000_notif_10cb_digest_cron_inert.sql`. `SECURITY DEFINER`, service_role
  only, PII-free, one cheap row. Returns `job_present`, `job_active`, `last_success_at`,
  `seconds_since_success`, `last_finished_at`, `last_status`.
- **Why it exists.** The digest worker's own Slack alert needs the worker to run. An unscheduled
  job, a disabled job, a missing Vault secret or a paused project produce **silence**, and silence
  is indistinguishable from health. This is what an EXTERNAL cron/uptime monitor reads instead.
- `last_success_at` is about a run that **succeeded**, not one that started: a worker invoked on
  schedule that fails every time is exactly as undelivered as one never invoked.
- **Wiring the external monitor is an owner action and a precondition for arming the cron — and it
  is ENFORCED, not merely written down.** `activate` refuses without `--monitor-confirmed`, exactly
  as `rollback` refuses without `--switch-off-confirmed`. Neither can be checked from SQL, so the
  operator asserts each explicitly rather than the script pretending it verified one.

### Enabling / rolling back the digest (10c-b Release Units 2 and 3)
- `scripts/rollout/notif-10cb/` — individually gated operator subcommands (`status`, `preflight`,
  `smoke-disabled`, `enable-engine`, `canary-invoke`, `canary`, `activate`, `rollback`). No auto-run,
  no "do it all" mode; every mutating step needs `--yes` and re-asserts the project ref. See its
  README for the sequence and for what the activation gate refuses.
- **No step in the sequence is hand-written any more — including both invocations.** Three steps
  used to be: a raw `UPDATE` for the engine (now `enable-engine --yes`), the canary send (now
  `canary-invoke`), and the *disabled smoke* (now `smoke-disabled`). The smoke mattered as much as
  the send, and not because it is guaranteed harmless — it is not. Its statement carries a
  Vault-decrypted `service_role` bearer whatever the switch says, so a hand-substituted project ref
  sends that credential to the wrong project and an unqualified `jsonb_build_object` hands it to
  whoever can create one. All three now run the
  cron job's *own* stored command, hash-pinned under a row lock, so what is invoked is what was
  reviewed. `canary-invoke` additionally bounds how many recipients it may reach; `smoke-disabled`
  additionally requires the reply to be exactly `{"status":"disabled","reason":"disabled"}` and every
  counter to be unmoved, both checked rather than printed at the operator. What makes the smoke safe
  is `DIGEST_SEND_ENABLED` being off — the worker claims existing groups regardless of the engine
  flags, so its zero-backlog assertions are a snapshot bound on the damage a wrong switch assertion
  could do, not a proof that sending is impossible.
- **The row lock is a guarded no-op `cron.alter_job`, not `FOR UPDATE`** (N0 correction,
  2026-08-05). The first production `smoke-disabled` was refused before invocation: hosted
  `postgres` can SELECT but not row-lock the `supabase_admin`-owned `cron.job`. The shared
  `sql/_gate_job_lock.sql` locks through the one write API the role holds on its own jobs, gates it
  on inactivity in the same snapshot, and proves the tuple write happened (`xmin` = this
  transaction). Full rationale, residuals, and the real-pg_cron CI rehearsal are in the 10c-b
  README.
- **Rollback is three switches, and only two are in the database:** `DIGEST_SEND_ENABLED` is an edge
  env var that no SQL can read (Supabase's own secret tooling sets it; this bundle has no view of
  it), so the operator turns it off FIRST and says so (`--switch-off-confirmed`); then the tooling
  clears the event flag, deactivates the cron, and proves both plus quiescence.
- **Three preconditions live outside the database and are asserted, not assumed:** the edge kill
  switch (`--switch-off-confirmed`), the external monitor (`--monitor-confirmed`, on `canary-invoke`
  as well as `activate` — the canary is the first send, so requiring it only at the arm would start
  the watch one step too late), and the **Admin Notification Operations** release unit
  (`--admin-ops-confirmed` on `canary-invoke`, `canary` and `activate`, acceptance criteria in
  [`FOUNDATION_ROADMAP.md`](FOUNDATION_ROADMAP.md)) — mandatory before any canary or activation,
  because without it there is no in-product global view of the pipeline and no safe controls. Since
  `canary-invoke` is the subcommand that performs the send, that flag is now a mechanical
  precondition on mail going out, not only on reconciling and arming afterwards.
- **Never `cron.unschedule` to pause — deactivate.** Unscheduling destroys the reviewed Vault-backed
  command, and re-creating it by hand under time pressure is how a wrong endpoint gets introduced.

### CI data-integrity gates (PGlite)
`npm run db:rehearse:all` runs the real money-path libs against real Postgres and asserts invariants (players, coaching, email, trainer-invoices, invoices-delivery, invoice-status, registration-write, list-partition). This is the **pre-merge** counterpart to the runtime reconciliation checks.

---

## 4. Backup & restore

- **`backup-database` edge fn** (`supabase/functions/backup-database/index.ts`): cron-run (daily-maintenance). Dumps tables to the `backups` Supabase storage bucket; enforces `RETENTION_DAYS` cleanup. **Fails loud:** returns non-2xx if any table fails to query/upload (e.g. a missing `backups` bucket) so the cron surfaces it instead of reporting a green "backup complete" while saving nothing (`:118-126`).
- **Restore:** point-in-time recovery is via the Supabase project dashboard (managed Postgres backups) — the `backups` bucket is a secondary logical export, not the primary DR path. There is no automated restore runbook in-repo yet.

---

## 5. Recovery runbooks

- **Payments (primary):** [`docs/payments/PAYMENT_RECOVERY_RUNBOOK.md`](payments/PAYMENT_RECOVERY_RUNBOOK.md) — step-by-step for booked-but-unbilled, paid-but-unconfirmed, amount-mismatch, duplicate-invoice, and manual-refund situations. Start here for any money incident.
- **Reconciliation-first triage:** run `reconcile_payments()` (§3) → each finding maps to a runbook section.
- **Operator tooling gaps** (what you *cannot* yet self-serve): [`docs/payments/PAYMENT_OPERATOR_TOOL_GAPS.md`](payments/PAYMENT_OPERATOR_TOOL_GAPS.md).
- **Invariants** the recovery must preserve: [`docs/payments/PAYMENT_INVARIANTS.md`](payments/PAYMENT_INVARIANTS.md); flow context: [`docs/payments/PAYMENT_FLOW_MAP.md`](payments/PAYMENT_FLOW_MAP.md).

---

## 6. Admin / operator tools

| Need | Tool | Notes |
|---|---|---|
| Find money anomalies | `reconcile_payments()` RPC (§3) | read-only, admin-only |
| Trace one payment | query `payment_audit_log` by `invoice_id` / `mollie_payment_id` | forensic trail |
| Invoice delivery status | `invoice_delivery_status` RPCs | per-invoice email state |
| Manual invoice ops | `split-invoice`, `backfill-invoices`, `forward-invoice`, `bulk-update-vat` edge fns | **operator sees immediate result; no Slack on partial failure** (backlog) |
| Account admin | `delete-user`, `update-user`, `impersonate-user`, `admin-reset-password` | security-sensitive; now Slack-alerted (OBS-P2-1 resolved 2026-08-08) |
| Mollie Connect state | `check-mollie-connect-status`, `mollie-connect-*` | a broken connect token silently breaks an academy's payouts (backlog) |

There is **no** in-app operator dashboard for these — they are invoked from admin UI actions or directly. Building a consolidated operator console is a known gap (`PAYMENT_OPERATOR_TOOL_GAPS.md`).

---

## 7. Structural gaps (strategic — see backlog)

1. **No server-side error aggregator.** Edge errors have two sinks: explicit `slack-notify` calls (41 of 108 entrypoints call the canonical helper directly, plus 8 inline wrappers — 2026-08-08 recount) and the passive log drain. PostHog is browser-only. No Sentry/Logflare backstop for edge functions.
2. **Slack backbone has no dead-man's-switch** — an unset webhook silences all alerts with no signal.
3. **No Slack rate-limit / dedup** — a hot failing path can flood and bury real alerts.
4. ~~No missed-cron heartbeat~~ **Resolved (2026-08-08):** the daily `sendCronHeartbeat` ships; the remaining half is an external observer of its absence (OBS-P0-1).
5. ~~Refund/chargeback reversals not recorded or alerted~~ **Resolved (noted 2026-08-07):** `detectPaymentReversal` (`_shared/mollie-webhook-reversal*`) + the webhook's reversal branch log/alert for manual reconciliation (alert-only by design — no state resurrection).

These are ranked with file refs in [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md).

---

## How to keep this current

- **Adding/changing an edge function:** money/auth/payment-connect → must call `notifySlackEdge`/`notifySlackEdgeError` from `_shared/edge-slack.ts` before merge; cosmetic/SEO → log-drain is fine.
- **Re-run the inventory** after edge-fn changes: count dirs under `supabase/functions/` vs count of `slack-notify`/`notifySlack` references. A growing gap = a new fn shipped without alerting.
- **A new durable audit table or health check** → add a row here and (if a gap) to the backlog. Keep the payment-specific detail in `docs/payments/`.
