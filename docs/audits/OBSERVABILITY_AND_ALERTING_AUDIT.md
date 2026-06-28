# Observability & Alerting Audit — Edge-Function and Money-Path Coverage

**Scope:** padeltrainer main @ `cee9da68`. Target scale: ~1,000 academies / ~10,000 trainers / 100,000+ bookings.
**Method:** inventoried every proactive alert channel (Slack helper + inline wrappers, cron wrapper, client PostHog), mapped which of the 93 edge functions route into them, then enumerated the **silent gaps** — failures that emit only `console.*` and reach no proactive channel. This section's silent-gaps list **is** the Tier-D worklist.

---

## Verdict

The **payment write-back core is well instrumented.** Every Mollie/Stripe webhook and every invoice-minting edge function alerts to Slack on amount-mismatch, paid-on-cancelled-booking, and top-level failure. The **cron surface is the best-covered area:** a status-based wrapper (`alertCronFailure`) plus per-job internal alerts close the "HTTP 200 with partial failures inside" blind spot. Client-side browser errors flow to PostHog `$exception`.

But coverage is **all-or-nothing per function**, and three classes of failure are still **completely silent** (only `console.error`, reaching the Supabase log drain that nobody watches proactively):

1. **`finalize-proposals`** — a per-player invoice-mint or paid-reconcile failure means a player is **booked-but-unbilled** (or paid-but-unmarked) with zero ops signal. *(risk: high)*
2. **`submit-guest-intake`** — the **non-blocking** registration-invoice mint and confirmation-email failures (mid-flow, return 200) are swallowed; the top-level `registration_error` Slack only fires on a *thrown* failure. A public registrant can be **enrolled-but-uninvoiced** silently. *(risk: high)*
3. **`sync-invoice-to-bookings`** — an invoice price-edit that fails to mirror onto bookings/slot causes **silent price divergence**. *(risk: medium)*

Two **structural** weaknesses sit underneath: (a) **there is no server-side error aggregator** — Slack is the *only* proactive sink for edge errors, and PostHog is browser-only; (b) **the Slack backbone has no dead-man's-switch and no rate-limit** — if `SLACK_WEBHOOK_URL` is unset, *everything* goes silent with no signal (`slack-notify:94`), and a tight failure loop can flood the channel and bury real alerts.

**Numbers verified on this HEAD:** 93 directories under `supabase/functions/`; **22** reference `slack-notify`/`notifySlack` (12 via the `edge-slack` helper + 10 inline wrappers). The remaining ~70 emit only `console.*`. Most of the tail is non-critical (SEO/geocode/scrape), but a handful of **auth/account/Mollie-Connect** functions in it should be promoted.

---

## Coverage map

### Channel A — Slack (the only proactive server-side channel)

| Sub-surface | Where | What it catches |
|---|---|---|
| **Shared helper** | `_shared/edge-slack.ts:4` `notifySlackEdge` / `:22` `notifySlackEdgeError` → `invoke('slack-notify')`; **never throws** (try/catch swallow) | Canonical path. **12 importers** (verified): `invoice-health-check`, `generate-cycle-commitment-invoices`, `send-campaign-emails`, `send-digest-emails`, `process-onboarding-emails`, `generate-invoice`, `auto-create-invoice`, `create-rebook-invoice`, `create-group-rebook-invoice`, `create-registration-invoice`, `send-invoice-email`, `send-rebook-group-confirmation`. |
| **Inline wrappers** (own `notifySlack*`, not the helper) | `mollie-webhook:27` (~10 sites incl. `:610` paid-on-cancelled, `:629` amount-mismatch, `:716` top-level); `verify-mollie-payment:16` (`:303/:324/:388`); `create-mollie-payment:20`; `create-invoice-payment:18`; `stripe-subscription-webhook:9`; `_shared/mollie-booking-paid-side-effects.ts:47/:56`; `send-email:1438/:1480`; `signup-user:352`; `submit-guest-intake:637 new_registration / :669 registration_error` | Money/payment paths well covered. 6 duplicated ad-hoc wrappers = drift risk vs the shared helper. |
| **slack-notify** edge fn | formats Block Kit; `EVENT_CONFIG` = `edge_function_error`, `payment_received`, `new_registration`, `registration_error`. **Auth:** Bearer must equal `SUPABASE_SERVICE_ROLE_KEY` (`slack-notify:86`). | **If `SLACK_WEBHOOK_URL` unset → 500 + `console.error` only, no self-alert (`:94`).** The backbone has no heartbeat. |

### Channel B — Cron wrapper (best-covered surface)

| Piece | Where | Notes |
|---|---|---|
| `alertCronFailure` | `api/_lib/cron.ts:60` → `slack-notify edge_function_error` | Fires **only** when a sub-job returns `ok:false` (non-2xx). |
| Wired crons | `api/cron/daily-emails.ts:43` (jobs: `process-onboarding-emails`, `send-digest-emails`); `api/cron/daily-maintenance.ts` (jobs: `backup-database`, `invoice-health-check`, `generate-cycle-commitment-invoices`, `send-campaign-emails`) | `vercel.json`: daily-emails `0 12 * * *`, daily-maintenance `0 6 * * *`. |
| Per-job internal alerts | `send-digest-emails:288`, `process-onboarding-emails:324`, `generate-cycle-commitment-invoices:202`, `send-campaign-emails:480`; `backup-database` returns 500 on any failure (`:122-126`); `invoice-health-check:166` self-alerts | Closes the **200-with-partial-failure** blind spot for *wired* jobs. |

**Two cron gaps:** (1) only jobs wired into these two crons get the wrapper — a non-cron, non-self-alerting fn is invisible; (2) Vercel does **not** page on a cron that *never fires* (missed schedule) — no heartbeat.

### Channel C — Client PostHog (browser only)

`src/lib/logger.ts:68` `sendToMonitoring` → `ph.capture('$exception')`. `logger.error` (`:132`) always captures; `logger.warn` (`:121`) captures **only in prod** (`:124`); `logger.info` is a **no-op in prod** (`:115`). Production hostnames only. **Sees client errors only — never an edge-function or server failure.**

### Path → coverage table

| Path | Alerts? | Who / severity | Recovery on failure |
|---|---|---|---|
| Mollie webhook / verify / create-payment | **Yes** (inline) | ops Slack / payment | mismatch + paid-on-cancelled + top-level alerted; investigate from Slack |
| Stripe subscription webhook | **Yes** (inline) | ops Slack / subscription | `new_subscription` + `edge_function_error` |
| `auto-create-invoice`, `generate-invoice`, `create-*-invoice`, `send-invoice-email` | **Yes** (helper) | ops Slack / money | top-level errors alerted |
| `mollie-booking-paid-side-effects` | **Yes** (inline) | ops Slack / money | `auto-create-invoice-failed-after-paid` alerted |
| Crons (`daily-emails`, `daily-maintenance`) | **Yes** (wrapper + per-job) | ops Slack / batch | status + partial-failure alerted; **no missed-schedule heartbeat** |
| Client UI errors | **Yes** (PostHog) | eng dashboard / client | `$exception`; no paging |
| **`finalize-proposals`** | **No** | — / **high** | errors in 200 body to academy UI; **no ops alert** |
| **`submit-guest-intake`** non-blocking steps | **Partial** | — / **high** | invoice-mint + confirm-email failures `console.error` only; top-level Slack only on *throw* |
| **`sync-invoice-to-bookings`** | **No** | — / **medium** | 500 to client / `success:false` in body; **no ops alert** |
| `send-schedule-notifications` | **No** | — / medium | count to UI; no aggregate alert |
| `recalculate-invoices` | **No** | — / medium | 500 to caller; no alert |
| `resend-webhook` | **No** | — / medium | **silent catch (`:59`), not even `console.error`** |
| `send-priority-claim-invitation` / `send-rebook-reminder` | **No** | — / medium | count to UI; no aggregate alert |
| `trigger-welcome-emails` / `send-auth-email` | **No** | — / medium | `console.error` only; **auth-critical** |
| split/backfill/forward-invoice, `bulk-rebook-cycle`, `bulk-update-vat` | **No** | — / medium | result body to operator; no alert |
| ~70 long-tail fns (SEO, geocode, scrape, admin, connect) | **No** | — / low (mostly) | log drain only |

---

## SILENT GAPS — the Tier-D worklist

All items below are **confirmed on current main (`cee9da68`)** — the named functions have **zero** `slack-notify`/`notifySlack` references and emit only `console.*`. The fix in every case is the same shape: **import `notifySlackEdge`/`notifySlackEdgeError` from `_shared/edge-slack.ts`** (it has the service key and never throws) and call it on the swallowed failure, mirroring `generate-cycle-commitment-invoices:202`.

### Tier-D #1 — `finalize-proposals` (risk: HIGH) — booked-but-unbilled
**File:** `supabase/functions/finalize-proposals/index.ts:216` (`Reconcile failed for player …`), `:235` (`Invoice creation failed for player …`) + `errors.push`, `:242` (`Invoice error …`); top-level catch `:265` `console.error` only → generic 500. Errors surface in the 200 body (`:259`) to the academy UI but reach **no** Slack/PostHog. Not in any cron, so `alertCronFailure` never sees it. Invoked via `src/lib/cycles.ts:2145 finalizeProposals`.
**Why it matters:** this is the proposal→booking finalize step. A per-player failure means that player is **booked but uninvoiced** (or paid-but-not-marked) — direct revenue loss with no ops signal.
**Fix:** after the loop, `if (errors.length > 0) notifySlackEdgeError(...)`; also wrap the top-level catch (`:265`).

### Tier-D #2 — `sync-invoice-to-bookings` (risk: MEDIUM) — silent price divergence
**File:** `supabase/functions/sync-invoice-to-bookings/index.ts:78` (`booking update failed` → 500), `:108` (top-level catch → 500). Partial success returns `success:false` in the 200 body (`:103`) when `updated !== expected`. No Slack/PostHog anywhere. Invoked from `EditInvoiceDialog.tsx` / `AcademyEditInvoice.tsx`.
**Why it matters:** when an academy edits a session price, this mirrors it onto every booking's `payment_amount` + the slot's `price_per_session`. A failed/partial write leaves bookings/slot **stale vs the invoice** — silent money divergence.
**Fix:** `notifySlackEdge` on `updErr` (`:78`), on partial (`updated !== expected`, `:103`), and in the catch (`:108`).

### Tier-D #3 — `submit-guest-intake` non-blocking steps (risk: HIGH) — enrolled-but-uninvoiced
**File:** `supabase/functions/submit-guest-intake/index.ts:506` (`Registration invoice not minted …`, `result.ok===false`, e.g. `no_price_set`), `:511` (`Registration invoice minting failed (non-blocking)`), `:529` (`Confirmation email failed (non-blocking)`), `:616` (admin-notify failed). The function **has** Slack — `:637 new_registration` (success) and `:669 registration_error` (**only** in the top-level catch at `:656`). The mid-flow non-blocking failures never reach Slack because they're caught locally and the request still returns 200.
**Why it matters:** a public registrant submits → row created → `new_registration` Slack fires → **but** if the invoice mint fails (`:506/:511`) the registrant is **enrolled-but-uninvoiced** with no ops alert (only `paymentInfo.error` returned to the form). Same for a failed confirmation email (`:529` → registrant gets nothing).
**Fix:** promote these specific catches to `notifySlackEdge` — the function already imports the helper and has the service key.

### Tier-D #4 — `send-schedule-notifications` (risk: MEDIUM)
**File:** `supabase/functions/send-schedule-notifications/index.ts` — 2× `console.error`, 0 Slack. Returns `{sent, errors}` to the academy UI; not cron-wrapped. Invoked via `src/lib/cycles.ts:2159`.
**Why it matters:** post-finalize, this emails every booked player their schedule. A systemic failure (Resend down) hits many players across academies but only shows as a count in the UI.
**Fix:** aggregate `notifySlackEdgeError` when `errors.length > 0`.

### Tier-D #5 — `recalculate-invoices` (risk: MEDIUM)
**File:** `supabase/functions/recalculate-invoices/index.ts:316` `console.error` → 500. No Slack/PostHog. SELECT is bounded (prior P1 work) but the failure is un-alerted.
**Why it matters:** recomputes invoice line items/totals (money). A top-level failure returns 500 to the caller but raises nothing.
**Fix:** wrap the catch (`:316`) with `notifySlackEdgeError`.

### Tier-D #6 — `resend-webhook` (risk: MEDIUM) — silent deliverability blackout
**File:** `supabase/functions/resend-webhook/index.ts:14` step logger, `:59` **silent catch** (not even `console.error`). This is the ingestion point for Resend bounce/delivery events feeding the email-health tables.
**Why it matters:** if this webhook starts failing (signature drift, schema change), bounce/complaint signals stop flowing and the whole deliverability surface **silently goes stale** — with nothing logged.
**Fix:** add `console.error` **and** `notifySlackEdge` in the catch (`:59`).

### Tier-D #7 — `send-priority-claim-invitation` + `send-rebook-reminder` (risk: MEDIUM)
**Files:** each 2× `console.error`, 0 Slack. These are the high-volume rebooking blasts (80+ recipients per the M6 work) at the 10k-trainer target. Invoked by `rebookManage`, not cron.
**Why it matters:** a systemic send failure (Resend 429/down) only shows as a count discrepancy in the UI.
**Fix:** `notifySlackEdgeError` when failures exceed a threshold (covers both).

### Tier-D #8 — `send-auth-email` + `trigger-welcome-emails` (risk: MEDIUM) — auth-critical
**Files:** `send-auth-email/index.ts` 4× `console.error` (link-gen `:231/:246`, send `:266`, top-level `:277`), 0 Slack; `trigger-welcome-emails/index.ts` 5× `console.error`, 0 Slack. `send-auth-email` backs Supabase Auth email hooks (signup / password reset).
**Why it matters:** a `send-auth-email` failure means **users can't sign up or reset passwords** — high user impact — yet it's console-only. `trigger-welcome-emails` is lower stakes.
**Fix:** **prioritize `send-auth-email`** — `notifySlackEdge` on send failure (`:266`) and top-level (`:277`).

### Tier-D #9 — bulk admin money fns (risk: MEDIUM)
**Files:** `split-invoice`, `backfill-invoices`, `forward-invoice`, `bulk-rebook-cycle`, `bulk-update-vat` — all 0 Slack / 0 (or only step-) console.error. `bulk-rebook-cycle` is the cohort rebooking engine (draft-commit/resumable) returning per-batch status to the wizard.
**Why it matters:** admin-triggered, so the operator usually sees the immediate result — but at 1k-academy scale a partial failure the operator misses = unbilled bookings.
**Fix:** at minimum, aggregate `notifySlackEdge` on partial failure in `bulk-rebook-cycle`.

### Tier-D #10 — long tail triage (~70 fns, mixed risk)
**Evidence:** 93 dirs, only 22 instrumented. The rest (`delete-user`, `update-user`, `impersonate-user`, `admin-reset-password`, `mollie-connect-*`/`disconnect`, `check-mollie-connect-status`, `customer-portal`, `cancel-stripe-subscription`, `sync-calendar-event`, `google-calendar-*`, `notify-followers`, `scrape-academies`, `geocode-locations`, `enrich-clubs`, `render-page`, `sitemap`, `public-api`, …) emit only `console.*` → log drain.
**Triage:** **(a) promote to Slack** the security-sensitive account fns (`delete-user`, `admin-reset-password`, `impersonate-user`) and the Mollie-Connect status/refresh fns (`mollie-connect-*`, `check-mollie-connect-status` — a broken connect token **silently breaks an academy's payouts**); **(b) leave on log-drain** the cosmetic/SEO tail (`render-page`, `sitemap`, `geocode`, `scrape`). This is a triage bucket, not a single patch.

---

## Cross-cutting / structural gaps (strategic, beyond discrete code fixes)

1. **No server-side error aggregator.** Edge errors have exactly two sinks: explicit `slack-notify` calls in the ~22 instrumented fns, and the passive Supabase log drain. PostHog `$exception` is **browser-only**. There is no Sentry/Logflare-style durable backstop for edge functions. **Recommendation:** add a server-side error sink as the durable backstop, with Slack as the *curated high-signal* channel on top — so an un-instrumented fn's failure is still captured somewhere.
2. **The Slack backbone has no dead-man's-switch.** If `SLACK_WEBHOOK_URL` is unset, `slack-notify` 500s with `console.error` only (`:94`) — a misconfigured webhook silences **every** alert with zero signal. **Recommendation:** a periodic heartbeat ping (cron) whose *absence* pages, so a dead webhook is itself an alert.
3. **No Slack rate-limit / dedup.** A tight failure loop (e.g. a hot money path failing every request) can flood the channel and bury real signal. **Recommendation:** add per-event-type throttling/dedup on the `slack-notify` path before scaling to 1k academies.
4. **No missed-cron heartbeat.** Vercel doesn't page on a cron that never fires (see Channel B). **Recommendation:** a freshness check on each cron's last-success timestamp.

---

## How to keep this current

- **When you add or change an edge function,** decide its tier before merge: *money/auth/payment-connect* → must call `notifySlackEdge`/`notifySlackEdgeError` from `_shared/edge-slack.ts` (the canonical helper; never throws); *cosmetic/SEO* → log-drain is fine. Add the function to the path→coverage table.
- **Prefer the shared helper over a new inline wrapper** — the 6 existing inline wrappers are drift risk in auth-header handling. New alerts route through `edge-slack.ts`.
- **Re-run the inventory after edge-function changes** with: count dirs under `supabase/functions/`, then count `slack-notify`/`notifySlack` references — if the gap between the two grows, a new function was added without alerting; triage it.
- **Treat the Tier-D list as a burn-down.** As each gap is fixed, move its row from the silent-gaps section into the coverage table with the alert wired. Re-confirm "still silent" claims against current `HEAD` before acting — they were verified at `cee9da68`.
- **Close the structural gaps before 1k-academy scale:** server-side aggregator (#1), webhook heartbeat (#2), Slack rate-limit (#3), and missed-cron heartbeat (#4) are the difference between "alerts work" and "alerts work *and survive their own failure*."
