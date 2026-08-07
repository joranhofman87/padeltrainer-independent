# Observability & Recovery Backlog

One-line purpose: ranked, actionable list of missing alerting / audit / recovery capabilities — the burn-down for making padeltrainer's operational layer survive its own failures.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Companion to [`../OBSERVABILITY_AND_RECOVERY.md`](../OBSERVABILITY_AND_RECOVERY.md). Silent-gap detail (the per-function "Tier-D" worklist) lives in [`../audits/OBSERVABILITY_AND_ALERTING_AUDIT.md`](../audits/OBSERVABILITY_AND_ALERTING_AUDIT.md); payment-reversal detail in [`../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) (P2-5).

Deploy note: fixes to edge functions / migrations do **not** auto-deploy — owner applies manually after merge. "Done in code" ≠ "live in prod".

Ranking = operational blast radius: P0 = a failure of the observability layer itself hides *all* signal, or money is lost with no record; P1 = a real failure class reaches no proactive channel; P2 = important but bounded or operator-visible.

---

## P0 — the alerting layer can fail silently

### OBS-P0-1 — Slack backbone has no dead-man's-switch
If `SLACK_WEBHOOK_URL` is unset/misconfigured, `slack-notify` 500s with `console.error` only and **every** proactive alert goes silent with zero signal.
- **Refs:** `supabase/functions/slack-notify/index.ts` (self-500 path); `supabase/functions/_shared/edge-slack.ts:17` (swallows the invoke error).
- **Fix:** a periodic heartbeat ping (cron) whose *absence* pages via an independent channel (e.g. an external uptime monitor hitting a "last Slack OK" freshness endpoint). The webhook health must be observable from outside the webhook.

### OBS-P0-2 — Refund / chargeback reversals not recorded or alerted (FULL_AUDIT P2-5)

> **RESOLVED (noted 2026-08-07):** shipped — `detectPaymentReversal` (`_shared/mollie-webhook-reversal*`,
> tested) + the webhook's reversal branch logs and Slack-alerts for manual reconciliation without
> resurrecting or downgrading state. Original gap text retained below for history.
`mollie-webhook` has no case for `charged_back` / `refunded` / non-zero `amountRefunded`. A chargeback maps to default→pending, the `.neq('payment_status','paid')` no-downgrade guard blocks any change, and it returns 200 with **no `payment_audit_log` row and no Slack alert**. Money is gone; seat stays confirmed/paid forever; a full refund is logged as `duplicate_webhook_ignored`.
- **Refs:** `supabase/functions/mollie-webhook/index.ts:616` (status switch); FULL_AUDIT P2-5 §270-279, Slice H §467.
- **Fix:** explicit `charged_back` / `amountRefunded`/`amountChargedBack` handling — do **not** resurrect state; write a `payment_audit_log` row (`writePaymentAuditLog`) and fire `notifySlackEdge` for manual reconciliation, mirroring the existing cancelled-invoice/cancelled-booking alerts. Add a `reconcile_payments` check for reversed-but-still-paid.
- Ranked P0 here (not P2 as in the code audit) because it is *silent money loss with no durable record* — the observability layer's core promise.

---

## P1 — a real failure class reaches no proactive channel

### OBS-P1-1 — `finalize-proposals` booked-but-unbilled is silent (Tier-D #1, HIGH)

> **RESOLVED (noted 2026-08-07):** shipped — `finalize-proposals/index.ts` now Slack-alerts per-player
> reconcile failures, the aggregate booked-but-unbilled count, and the top-level catch
> (`notifySlackEdgeError` at :218/:259/:282). Original gap text retained below for history.
Per-player invoice-mint / paid-reconcile failures surface only in the 200 body to the academy UI; top-level catch is `console.error` only. Not cron-wrapped → no `alertCronFailure`. A player ends up booked-but-uninvoiced with zero ops signal.
- **Refs:** `supabase/functions/finalize-proposals/index.ts:216/:235/:242/:265`.
- **Fix:** `if (errors.length) notifySlackEdgeError(...)` after the loop + wrap the top-level catch.

### OBS-P1-2 — No missed-cron heartbeat
Vercel does not page on a cron that never fires. A silently-unscheduled daily-maintenance / daily-emails job (backup, invoice-health-check, commitment invoices) goes unnoticed.
- **Refs:** `api/_lib/cron.ts:59` `alertCronFailure` (only fires on non-2xx *of a run that happened*); `vercel.json` schedules.
- **Fix:** freshness check on each cron's last-success timestamp (a lightweight "last ran at" row + a daily check that pages if stale). The single-flight lock infra (`20260614190000_cron_single_flight_lock.sql`) already tracks job rows — extend it with a last-success column.

### OBS-P1-3 — `submit-guest-intake` enrolled-but-uninvoiced is silent (Tier-D #3, HIGH)
Mid-flow non-blocking failures (registration-invoice mint `no_price_set`, confirmation-email send) are caught locally; the request still returns 200 and fires the *success* `new_registration` Slack. The `registration_error` alert only fires on a top-level throw. A public registrant is enrolled-but-uninvoiced with no ops alert.
- **Refs:** `supabase/functions/submit-guest-intake/index.ts:506/:511/:529/:616` (silent); `:637/:669` (existing Slack). Function already imports the helper + has the service key.
- **Fix:** promote the specific mid-flow catches to `notifySlackEdge`.

### OBS-P1-4 — `resend-webhook` silent deliverability blackout (Tier-D #6)
The ingestion point for Resend bounce/delivery events has a **silent catch** (not even `console.error`). If it starts failing (signature drift, schema change), bounce/complaint signals stop flowing into the email-delivery tables and the whole deliverability surface silently goes stale.
- **Refs:** `supabase/functions/resend-webhook/index.ts:59`; email tables `20260615110000_email_delivery_tables.sql`.
- **Fix:** add `console.error` **and** `notifySlackEdge` in the catch.

### OBS-P1-5 — `send-auth-email` failures are console-only, auth-critical (Tier-D #8)
Backs Supabase Auth email hooks (signup / password reset). A send failure means users can't sign up or reset passwords — high user impact — yet it's `console.error` only, 0 Slack.
- **Refs:** `supabase/functions/send-auth-email/index.ts:231/:246/:266/:277`.
- **Fix:** `notifySlackEdge` on send failure (`:266`) and top-level (`:277`). (Prioritize over the lower-stakes `trigger-welcome-emails`.)

### OBS-P1-6 — `sync-invoice-to-bookings` silent price divergence (Tier-D #2)
When an academy edits a session price, this mirrors it onto every booking's `payment_amount` + the slot price. A failed/partial write leaves bookings/slot stale vs the invoice — silent money divergence returning `success:false` in a 200 body. No Slack/PostHog.
- **Refs:** `supabase/functions/sync-invoice-to-bookings/index.ts:78/:103/:108`.
- **Fix:** `notifySlackEdge` on `updErr`, on partial (`updated !== expected`), and in the catch.

---

## P2 — important but bounded or operator-visible

### OBS-P2-1 — Security-sensitive account + Mollie-Connect fns on log-drain only (Tier-D #10)
`delete-user`, `admin-reset-password`, `impersonate-user`, and the Mollie-Connect status/refresh fns (`mollie-connect-*`, `check-mollie-connect-status`) emit only `console.*`. A broken connect token **silently breaks an academy's payouts**; account-admin actions leave no proactive audit.
- **Fix:** promote just these to `notifySlackEdge`. Leave the cosmetic/SEO tail (`render-page`, `sitemap`, `geocode`, `scrape`) on the log drain.

### OBS-P2-2 — No Slack rate-limit / dedup
A hot money path failing every request can flood the channel and bury real signal.
- **Refs:** the `slack-notify` invoke path (`_shared/edge-slack.ts`).
- **Fix:** per-event-type throttling/dedup on the `slack-notify` path before 1k-academy scale.

### OBS-P2-3 — No server-side error aggregator (structural)
Edge errors have only two sinks: explicit `slack-notify` (~22 of ~96 fns) and the passive Supabase log drain. PostHog `$exception` is browser-only. An un-instrumented fn's failure is captured **nowhere** durable.
- **Fix:** add a server-side error sink (Sentry/Logflare-style) as the durable backstop, with Slack as the curated high-signal layer on top.

### OBS-P2-4 — Bulk / batch money fns don't alert on partial failure (Tier-D #4/#5/#7/#9)
`send-schedule-notifications`, `recalculate-invoices`, `send-priority-claim-invitation`, `send-rebook-reminder`, `bulk-rebook-cycle`, `split-invoice`, `backfill-invoices`, `forward-invoice`, `bulk-update-vat` — operator-triggered, so the immediate result is visible, but at scale a partial failure the operator misses = unbilled bookings / undelivered emails.
- **Fix:** aggregate `notifySlackEdgeError` when `errors.length` / partial-failure exceeds a threshold. Prioritize `bulk-rebook-cycle` (cohort engine) and `send-schedule-notifications` (post-finalize mass email).

### OBS-P2-5 — No automated restore runbook
Primary DR is Supabase managed PITR (dashboard); the `backup-database` logical export to the `backups` bucket has no documented, tested restore path in-repo.
- **Refs:** `supabase/functions/backup-database/index.ts`.
- **Fix:** write + rehearse a restore runbook; verify the logical export is actually reloadable.

---

## Already fixed — do not re-open

Per the 2026-07-02 fresh-eyes audit, these are FIXED + DEPLOYED and must **not** be re-listed as open: forged-JWT service-role bypass (P0), swap_slots guard, merge_guest_players data-loss, M-17 webhook collision, extras charge/invoice, `create_invoice_deduped` dedup RPC, `invoiceSync` paging (now via `src/lib/supabasePaging.ts`), academy-Mollie routing. Payment reliability foundation (audit log + `reconcile_payments` + best-effort audit writer) is built; `reconcile_payments` + `mollie-webhook` audit writes still need the **owner prod deploy** of migration `20260705140000` + the `mollie-webhook` redeploy.
