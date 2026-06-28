# Owner Deploy Checklist — pre-scale hardening

Things that **do NOT auto-deploy** (only the Vercel frontend does). Apply these to the
live project `ficwbdrzefmblkbkomzw` after the matching PR merges.

> **Current state (verified 2026-06-28):** all migrations are LIVE and all edge functions are
> CURRENT **except the 6 deferred AI-gateway functions** — see the two reconciliation sections
> below. The dated `[x]`/`[ ]` markers in the lower sections are the historical audit trail; the
> two "verified 2026-06-28" sections are authoritative.
>
> **Foundation Tier A (PRs #187 · #188 · #189, merged 2026-06-28):** see the dedicated section
> immediately below — A1 capacity migration LIVE; `mollie-webhook` + `verify-mollie-payment`
> redeployed from `main` (post-merge); #187 is frontend-only.

## ✅ Foundation Tier A — booking correctness (PRs #187 · #188 · #189) — 2026-06-28

The grounded Codex roadmap Tier A (booking-domain hardening). All three merged to `main`
2026-06-28, each characterization/rehearsal-tested **and** adversarially reviewed before merge.

1. [x] **#187 — online-cycle payment exact-ids + orphan rollback** (`src/lib/cyclePayment.ts`).
  **Frontend-only — auto-deploys via Vercel.** No migration, no edge-fn redeploy
  (`create-mollie-payment` already accepts `bookingIds`).
2. [x] **#189 — staff/guest slot-capacity guard.** Migration
  **`20260702120000_enforce_capacity_for_staff_bookings.sql`** — LIVE (applied via
  `db push --linked` 2026-06-28; the same push also finally *recorded*
  `20260701130000` in remote history, fixing the earlier dashboard-apply drift). Additive —
  replaces the `enforce_booking_slot_tier` function body so capacity is enforced for all
  authenticated inserts; trigger DDL unchanged; no data change. `friendlyError` change is
  frontend (auto-deploys).
3. [x] **#188 — webhook can't resurrect a cancelled booking.** **DEPLOYED 2026-06-28 from `main`**
  (`mollie-webhook` + `verify-mollie-payment`). Adds the `status != 'cancelled'` write-back guard
  + a Slack alert when a paid payment lands on a cancelled booking.
  - *Deploy gotcha that bit us:* the FIRST redeploy ran from the A1 feature branch (`main` + A1
    only, NOT #188) and a `git pull` on stale `main` said "Already up to date", so the guard did
    NOT ship until the PRs were merged. **Always merge to `main` first, `git pull`, then deploy.**
    Proof the re-deploy shipped it: `verify-mollie-payment`'s upload manifest now includes
    `_shared/mollie-webhook-payment.ts` (only imported once #188 added `findCancelledPaidBookings`).
  - Commands: `supabase functions deploy {mollie-webhook,verify-mollie-payment} --project-ref ficwbdrzefmblkbkomzw`

**Open follow-up (not blocking):** align the DB capacity occupancy count to the
`CAPACITY_OCCUPYING_STATUSES` allowlist (the four count sites currently use a denylist that
counts `rejected`/`completed`) — see the foundation worklog / memory. Pre-existing, fail-closed.

## ✅ P0 — single-slot online booking double-insert (PR #183) — DEPLOYED 2026-06-28

Codex foundation-verification Finding 1. The frontend half (the page no longer inserts
the booking) auto-deployed via Vercel; the two backend items restored the player's `notes`.

1. [x] Migration **`20260701130000_book_slot_for_payment_notes.sql`** — applied (verified:
  `book_slot_for_payment` now has the 4-arg `_notes text DEFAULT NULL` signature).
2. [x] Redeployed **create-mollie-payment** — forwards `notes`; deploy-gap-resilient
  (retries the 3-arg RPC on `PGRST202`/`42883`).

## ✅ Live-vs-pending reconciliation (verified 2026-06-28) — Codex Finding 4

`supabase db push --dry-run --linked` (owner-run, 2026-06-28) reported **only one migration
pending: `20260701130000…`** — now applied. **Every other migration in this file — including
Phase 4 · C + E and `academy_invoice_email_message` — is already LIVE.** The migration side is
fully reconciled: for migrations, "merged in repo" == "live in production". (The `[ ]`
markers below predate this dry-run; trust this section.)

The dry-run does **not** cover edge functions (no pending-tracker). Confirm edge-fn deploy
state with `supabase functions list` (below). Owner-deferred: the AI-gateway functions.

### Verification commands (owner; `--linked` after `supabase link --project-ref ficwbdrzefmblkbkomzw`)

    supabase migration list --linked       # Local vs Remote → a Local-only row is unapplied
    supabase db push --dry-run --linked     # previews pending migrations; applies nothing
    supabase functions list --linked        # compare each UPDATED_AT to its PR merge date

**Stop and investigate** if `migration list` / `db push --dry-run` ever shows an *unexpected*
migration (one you did not just merge) — that signals drift between repo and prod.

### Edge functions — CONFIRMED via `supabase functions list` (2026-06-28)

Every edge function whose code changed this cycle is deployed **after** its change landed —
prod matches repo:

| Function(s) | Live version | Deployed (UTC) |
|---|---|---|
| `create-mollie-payment` | v15 | 2026-06-27 14:41 |
| `mollie-webhook` · `verify-mollie-payment` · `create-invoice-payment` · `finalize-proposals` · `send-campaign-emails` | — | 2026-06-27 11:23 |
| `submit-guest-intake` · `create-registration-invoice` | — | 2026-06-27 09:26 |
| `create-group-rebook-invoice` · `send-rebook-group-confirmation` | v1 | 2026-06-25 14:38 |
| `bulk-rebook-cycle` · `send-rebook-reminder` · `send-priority-claim-invitation` | — | 2026-06-25 09:57 |
| `send-invoice-email` (PDF attach) | v20 | 2026-06-25 08:18 |
| `recalculate-invoices` · `generate-cycle-commitment-invoices` · `send-digest-emails` · `process-onboarding-emails` | — | 2026-06-25 08:18–19 |

**The only stale functions are the 6 AI-gateway ones — still v6 (2026-06-02), deferred by
owner decision** (see the AI-gateway section). Not a gap. ✅ Nothing left to deploy except if
you ever turn the AI features on.

## Edge functions to (re)deploy
`supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw`

- [x] **update-user** — IDOR fix (#77). *Security — do this one first.*
- [x] **stripe-subscription-webhook**, **og-image**, **rating-og-image**, **get-public-rating**, **health-check** — redeploy so prod matches the new `config.toml` `verify_jwt=false` (#78). Prevents a future deploy from 401-ing them.
- [x] **send-email** — HTML-injection escaping for registrant text (#80). *Security — closes the public submit-guest-intake → cross-tenant admin email injection vector.*
- [x] **send-campaign-emails** — resumable + accurate sent counts (#80). Stops silently dropping the unprocessed tail on timeout / marking failures as sent.
- [x] **send-campaign-emails** — autonomous resume: service-role chain + daily sweep (#81). Ships `config.toml verify_jwt=false` for this fn (so the sweep cron isn't 401'd) — redeploy required. The `daily-maintenance` cron change auto-deploys via Vercel.
- [x] **send-campaign-emails** — bounded failed-recipient retry (#82). **Migration below applied FIRST**, then redeployed.
- [x] **auto-create-invoice**, **create-registration-invoice**, **create-rebook-invoice** — Slack alert on the money-path catch (#83). Closes silent server-side invoice-mint failures. Needs the `slack-notify` webhook already configured (it is — other fns use it).
- [x] **submit-guest-intake**, **create-registration-invoice** — registration date-span lesson count now FLOORED, not rounded (#86). *Money change — fixes a one-lesson over-charge on non-exact-week date-span cycles.* These bundle the fixed `_shared/registration-pricing.ts`.

## Migrations to apply  *(all LIVE as of 2026-06-28 — `db push --dry-run` shows nothing pending)*
- [x] **Phase 4 · C + E** — LIVE. see `docs/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`. Two additive, idempotent, non-destructive migrations:
  - **`20260630120000_phase4_C_cyclus_id_fk.sql`** — adds FK `availability_slots.cyclus_id → cycles.id` **NOT VALID** + `ON DELETE SET NULL`. Stops any NEW orphan slot group at the DB. Existing orphans untouched; clean them up + `VALIDATE` later via the runbook's STEP 2 (pre-flight count → run the prepared backfill `20260612230000` → validate). After applying, **regenerate `types.ts`** (the PR hand-adds the matching FK relationship so the drift gate stays green; regen confirms).
  - **`20260630120100_phase4_E_invoices_booking_ids_gin.sql`** — GIN index on `invoices.booking_ids` so the invoice-sync `.overlaps()` lookups stop sequential-scanning. Plain `CREATE INDEX` (txn-safe); use the runbook's `CONCURRENTLY` form first only if invoices is large.
- [x] **`20260624130000_email_campaign_recipient_attempt_count.sql`** (#82) — adds `email_campaign_recipients.attempt_count`. Additive + backward-compatible; applied before redeploying send-campaign-emails.
- [x] **`20260625120000_academy_invoice_email_message.sql`** — LIVE. adds nullable `academy_profiles.invoice_email_message` (the "Save as default" invoice-email template). Additive + backward-compatible.

## Config / dashboard
- [x] `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` set in Vercel **Production** (verified).
- [x] Production error monitoring — **resolved**: PostHog `$exception` (client) + Slack alerts (cron + critical edge fns) cover it; no Sentry needed (#83, see `audit/MONITORING.md`).

## ✅ Invoice PDF — DEPLOYED (send-invoice-email v20, 2026-06-25)

- [x] **send-invoice-email** — **attaches the invoice PDF** to the payment email (best-effort: it calls `generate-invoice` for a fresh signed `pdfUrl`, fetches it, and attaches base64; if generation fails it still sends the pay-link email). Live at v20 (2026-06-25). *(If unsure the attach works, send yourself a test invoice email and check for the PDF.)*

## 🟡 DEFERRED by owner — replace the Lovable AI gateway (P1 #9)

> **Status 2026-06-28:** all 6 still at **v6 (2026-06-02)** — intentionally NOT redeployed (the AI
> admin features aren't needed now and they require the secrets below). This is the only group not
> current with the repo, and it's by choice. `generate-proposals` is AI-gated and no-ops without the
> gateway, so the `.eq` fix bundled in it has no live effect until you enable the gateway anyway.

The 6 AI edge fns no longer hardcode `ai.gateway.lovable.dev` / `LOVABLE_API_KEY`. They now use the
shared `_shared/ai-gateway.ts`, driven by env (any OpenAI-compatible `/chat/completions` gateway).
**Set the secrets BEFORE redeploying** — otherwise the AI features throw (content tools) or skip
(the gated ones):

`supabase secrets set AI_GATEWAY_BASE_URL=<gateway, e.g. https://openrouter.ai/api/v1> AI_GATEWAY_API_KEY=<server-only key> --project-ref ficwbdrzefmblkbkomzw`

Optional overrides: `AI_GATEWAY_TEXT_MODEL` (default `google/gemini-2.5-flash`), `AI_GATEWAY_IMAGE_MODEL` (default `google/gemini-3-pro-image-preview`).

Then `supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw` for:
- [ ] **enrich-clubs**, **scrape-academies**, **generate-proposals** — gated on `isAiGatewayConfigured()`; skip gracefully if unset.
- [ ] **generate-blog-article**, **translate-blog-article**, **generate-blog-cover** — admin content tools; throw if unset (same as the old `LOVABLE_API_KEY` behaviour).

The `_shared/cors.ts` lovable-origin removal bundles into every fn deploy; the `daily-maintenance`
comment-only change auto-deploys via Vercel. Delete `LOVABLE_API_KEY` from the project secrets once
all 6 are redeployed.
## ✅ Batch-job correctness (P1 #11) — DEPLOYED 2026-06-25

- [x] **recalculate-invoices** (v8, 2026-06-25) — bounds the unscoped "recalc everything" path at `MAX_UNSCOPED = 2000`. *No behaviour change for scoped (invoice_ids) calls.*
- [x] **generate-cycle-commitment-invoices**, **send-digest-emails**, **process-onboarding-emails** (2026-06-25) — per-failure Slack alerting on the batch jobs. These return HTTP 200 even when individual items fail (a committer not billed / a digest or onboarding email not sent), so the daily-maintenance / daily-emails cron wrappers' `alertCronFailure` (non-2xx only) never surfaced them. Each fn now raises **one** `notifySlackEdgeError` per run when its partial-failure count is > 0. Needs the `slack-notify` webhook already configured (it is). *Observability only — no behaviour change to the happy path.*

## Notes
- The CI changes (rehearsal runner, edge-fn config guard, cron Slack alerts, stale-ref purge) took effect on merge — no manual deploy.
- Dependency-vuln upgrade: the production-runtime fixes shipped (#84, react-router + protobufjs); the dev/build + Vercel-runtime remainder is documented as deferred in `audit/DEPENDENCIES.md`.
- Remaining scoped follow-up (no deploy): the code-level frontend↔Deno pricing dedup — `audit/PRICING_DEDUP.md`.
