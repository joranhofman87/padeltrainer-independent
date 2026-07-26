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

**Coverage is all-or-nothing per edge function.** ~22 of ~96 functions alert; the rest emit only `console.*` to the Supabase log drain that nobody watches. The remaining silent gaps are the backlog.

### Channel A — Slack backbone
- **Canonical helper:** `supabase/functions/_shared/edge-slack.ts` — `notifySlackEdge(event, data)` (`:4`) and `notifySlackEdgeError(fn, msg, ctx)` (`:22`). Invokes the `slack-notify` edge fn with the service-role key. **Never throws** (try/catch swallow at `:17`) — alerts must not break primary flows. **Prefer this over new inline wrappers.**
- **`slack-notify` edge fn:** formats Block Kit; `EVENT_CONFIG` = `edge_function_error`, `payment_received`, `new_registration`, `registration_error`. Auth = Bearer must equal `SUPABASE_SERVICE_ROLE_KEY`.
- **Structural risk:** if `SLACK_WEBHOOK_URL` is unset, `slack-notify` 500s with `console.error` only — no self-alert, no dead-man's-switch. A misconfigured webhook silences **everything** silently. See backlog OBS-P0-1.
- **6 legacy inline wrappers** (e.g. `mollie-webhook`, `verify-mollie-payment`, `create-mollie-payment`, `stripe-subscription-webhook`, `send-email`, `signup-user`) predate the helper and duplicate auth-header logic — drift risk. New alerts route through `edge-slack.ts`.

### Channel B — Cron alerting
- `alertCronFailure` (`api/_lib/cron.ts:59`) fires only when a sub-job returns `ok:false`. Wired into `api/cron/daily-emails.ts` and `api/cron/daily-maintenance.ts` (schedules in `vercel.json`: `0 12 * * *` and `0 6 * * *`).
- Many crons also self-alert internally (e.g. `invoice-health-check/index.ts:166`), closing the "HTTP 200 with partial failures inside" blind spot for wired jobs.
- **Single-flight lock (⚠ has a known wedge hazard — see below):** several crons take an advisory lock via `try_lock_cron_job` / `unlock_cron_job` (migration `20260614190000_cron_single_flight_lock.sql`) to reduce concurrent double-runs.
- **Gap:** Vercel does not page on a cron that *never fires* (missed schedule) — no heartbeat. See backlog OBS-P1-2.

### ⚠ Known reliability hazard — session-scoped cron single-flight lock (CRON-SF-WEDGE)
`try_lock_cron_job` is a **session-level** `pg_try_advisory_lock`. The lock and its `unlock_cron_job` run as **separate pooled PostgREST requests with no session affinity**, so the unlock can execute on a *different* backend than the one that acquired the lock — leaving the lock **held on the acquiring session until that pooled connection is recycled**. A healthy run can therefore wedge the job (every subsequent tick sees `try_lock` return false and bails) for an unbounded time, not "one connection lifetime" as the migration comment claims. The auto-release-on-recycle only bounds a *crashed* run, not this cross-session case.
- **Affected v1 workers (still use the lock):** `notification-email-worker`, `notification-whatsapp-worker`, `invoice-health-check`, `process-onboarding-emails`.
- **NOT affected:** `notification-digest-worker` (10c-a3) deliberately does **not** use this lock — the SQL state machine's atomic `claim` (`FOR UPDATE SKIP LOCKED` + ownership stamp) is its concurrency boundary.
- **Acceptance criteria for the fix (must land before 10c-b enables the digest cron):** replace the session advisory lock with either (a) reliance on the underlying atomic/idempotent claim where the job is already safe (drop the lock), or (b) a **durable owner-token + `locked_until` expiry lease** (a table row updated by a `WHERE locked_until < now()` CAS) that is pooling-safe and self-heals via TTL. Add a test simulating unlock-on-a-different-session and asserting the next tick is not wedged. Tracked as a background task in this session; convert to a durable issue/PR before scheduling any new cron.

### Channel C — Client PostHog
`src/lib/logger.ts`: `logger.error` always captures `$exception`; `logger.warn` captures only in prod; `logger.info` is a no-op in prod. **Browser only — never sees an edge-function or server failure.**

---

## 2. Audit trails — the durable record

### Payment audit log (`payment_audit_log`)
- **Table:** migration `20260324103326_*.sql`. Service-role only, `RLS = false`.
- **Writer:** `supabase/functions/_shared/payment-audit.ts` — `writePaymentAuditLog(supabase, event)`. **Best-effort, never throws** (a failed audit insert must never break a money write).
- **Vocabulary:** `PaymentAuditStatus` in the same file — the shared status enum producers + reconciliation agree on (`webhook_received`, `invoice_marked_paid`, `booking_marked_paid`, `duplicate_webhook_ignored`, `amount_mismatch_blocked`, `payment_for_cancelled_invoice`, `payment_for_cancelled_booking`, `payment_for_unknown_invoice`, `no_connected_mollie_account`, …).
- **Why it exists:** every money-path outcome leaves a queryable trail that **survives a Slack outage**. This is the primary forensic surface when reconciling a payment dispute.
- Full design: [`docs/payments/PAYMENT_OBSERVABILITY_AUDIT.md`](payments/PAYMENT_OBSERVABILITY_AUDIT.md).

### Email delivery tracking
- **Tables:** migration `20260615110000_email_delivery_tables.sql`; write RPC `record_email_event` (`20260615110010_*.sql`); invoice-facing status RPCs (`20260615110030_invoice_delivery_status_rpcs.sql`).
- **Ingestion point:** `supabase/functions/resend-webhook/` consumes Resend bounce/delivery events. **Warning:** its catch is silent (see backlog OBS-P1-3) — if this webhook fails, deliverability data goes stale with no signal.
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
- `supabase/functions/invoice-health-check/index.ts` — cron-run (daily-maintenance), single-flight locked. Scans for invoice anomalies via `_shared/invoice-health-checks.ts`; self-alerts to Slack (`:166`) with `status: anomalies_found | healthy`.

### `invoice-storage-gc` edge fn (Theme B / storage lifecycle)
- `supabase/functions/invoice-storage-gc/index.ts` — cron-run (daily-maintenance), service-role/admin only. Reaps orphaned objects from the private `invoices` bucket: an object is LIVE iff its key prefix matches some invoice's `render_path` (stamped by `generate-invoice`, B1); unmatched objects are deleted only after a **90-day grace** on `updated_at`, **capped at 200/run**. Report-vs-apply gate + the cap are the pure `planInvoiceGcDeletion` helper (`_shared/invoice-storage-gc.ts`).
- **Report-only by DEFAULT** — the cron ships without `apply`, so it lists orphans to Slack but deletes nothing. After one clean report, flip the `daily-maintenance` entry to `body: { apply: true }` to enable deletion. Self-alerts whenever orphans are found or deleted; quiet when there's nothing to do.
- Walks `storage.objects` via the service-role-only `invoice_gc_list_objects` RPC (the `storage` schema is not PostgREST-exposed). Keyset-paginated both sides with a 110s budget. Any classification doubt (unknown suffix, missing/invalid timestamp, fresh upload) → KEEP.
- Related: account deletion (`_shared/delete-user-data.ts`) also removes the deleted user's avatar/banner objects from the public `avatars` bucket (R06); org logos under `clubs/…` are a separate follow-up sweep.

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
| Account admin | `delete-user`, `update-user`, `impersonate-user`, `admin-reset-password` | security-sensitive; **currently log-drain only** (backlog OBS-P2-1) |
| Mollie Connect state | `check-mollie-connect-status`, `mollie-connect-*` | a broken connect token silently breaks an academy's payouts (backlog) |

There is **no** in-app operator dashboard for these — they are invoked from admin UI actions or directly. Building a consolidated operator console is a known gap (`PAYMENT_OPERATOR_TOOL_GAPS.md`).

---

## 7. Structural gaps (strategic — see backlog)

1. **No server-side error aggregator.** Edge errors have two sinks: explicit `slack-notify` calls (~22 fns) and the passive log drain. PostHog is browser-only. No Sentry/Logflare backstop for edge functions.
2. **Slack backbone has no dead-man's-switch** — an unset webhook silences all alerts with no signal.
3. **No Slack rate-limit / dedup** — a hot failing path can flood and bury real alerts.
4. **No missed-cron heartbeat** — a cron that never fires is invisible.
5. **Refund/chargeback reversals not recorded or alerted** (FULL_AUDIT P2-5, still open).

These are ranked with file refs in [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md).

---

## How to keep this current

- **Adding/changing an edge function:** money/auth/payment-connect → must call `notifySlackEdge`/`notifySlackEdgeError` from `_shared/edge-slack.ts` before merge; cosmetic/SEO → log-drain is fine.
- **Re-run the inventory** after edge-fn changes: count dirs under `supabase/functions/` vs count of `slack-notify`/`notifySlack` references. A growing gap = a new fn shipped without alerting.
- **A new durable audit table or health check** → add a row here and (if a gap) to the backlog. Keep the payment-specific detail in `docs/payments/`.
