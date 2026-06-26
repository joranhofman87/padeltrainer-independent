# Owner Deploy Checklist — pre-scale hardening

Things that **do NOT auto-deploy** (only the Vercel frontend does). Apply these to the
live project `ficwbdrzefmblkbkomzw` after the matching PR merges.

> ✅ **All items below were deployed by the owner on 2026-06-24.** Kept for the audit trail.

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

## Migrations to apply
- [ ] **Phase 4 · C + E** — see `docs/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`. Two additive, idempotent, non-destructive migrations:
  - **`20260630120000_phase4_C_cyclus_id_fk.sql`** — adds FK `availability_slots.cyclus_id → cycles.id` **NOT VALID** + `ON DELETE SET NULL`. Stops any NEW orphan slot group at the DB. Existing orphans untouched; clean them up + `VALIDATE` later via the runbook's STEP 2 (pre-flight count → run the prepared backfill `20260612230000` → validate). After applying, **regenerate `types.ts`** (the PR hand-adds the matching FK relationship so the drift gate stays green; regen confirms).
  - **`20260630120100_phase4_E_invoices_booking_ids_gin.sql`** — GIN index on `invoices.booking_ids` so the invoice-sync `.overlaps()` lookups stop sequential-scanning. Plain `CREATE INDEX` (txn-safe); use the runbook's `CONCURRENTLY` form first only if invoices is large.
- [x] **`20260624130000_email_campaign_recipient_attempt_count.sql`** (#82) — adds `email_campaign_recipients.attempt_count`. Additive + backward-compatible; applied before redeploying send-campaign-emails.
- [ ] **`20260625120000_academy_invoice_email_message.sql`** — adds nullable `academy_profiles.invoice_email_message` (the "Save as default" invoice-email template). Additive + backward-compatible; the frontend reads/writes it tolerantly (degrades to blank if absent), so deploy order doesn't matter — apply whenever. Frontend auto-deploys via Vercel.

## Config / dashboard
- [x] `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` set in Vercel **Production** (verified).
- [x] Production error monitoring — **resolved**: PostHog `$exception` (client) + Slack alerts (cron + critical edge fns) cover it; no Sentry needed (#83, see `audit/MONITORING.md`).

## Pending — not yet deployed (invoice PDF)
`supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw`

- [ ] **send-invoice-email** — now **attaches the invoice PDF** to the payment email (best-effort: it calls `generate-invoice` for a fresh signed `pdfUrl`, fetches it, and attaches base64; if generation fails it still sends the pay-link email). Previously the payment email was link-only with no PDF. *No deploy = recipients keep getting link-only emails.*

## Pending — replace the Lovable AI gateway (P1 #9, post-2026-06-24)

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
## Pending — not yet deployed (P1 #11 batch-job correctness)
`supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw`

- [ ] **recalculate-invoices** — bound the unscoped "recalc everything" path at `MAX_UNSCOPED = 2000` so a no-`invoice_ids` admin run can't SELECT + process every draft/sent/pending invoice platform-wide (timeout / OOM at scale). Recalc is idempotent so capping is safe; the response returns `limited: true` + a hint when truncated so the admin can re-run or pass `invoice_ids`. *No behaviour change for scoped (invoice_ids) calls.*
- [ ] **generate-cycle-commitment-invoices**, **send-digest-emails**, **process-onboarding-emails** — per-failure Slack alerting on the batch jobs. These return HTTP 200 even when individual items fail (a committer not billed / a digest or onboarding email not sent), so the daily-maintenance / daily-emails cron wrappers' `alertCronFailure` (non-2xx only) never surfaced them. Each fn now raises **one** `notifySlackEdgeError` per run when its partial-failure count is > 0. Needs the `slack-notify` webhook already configured (it is). *Observability only — no behaviour change to the happy path.*

## Notes
- The CI changes (rehearsal runner, edge-fn config guard, cron Slack alerts, stale-ref purge) took effect on merge — no manual deploy.
- Dependency-vuln upgrade: the production-runtime fixes shipped (#84, react-router + protobufjs); the dev/build + Vercel-runtime remainder is documented as deferred in `audit/DEPENDENCIES.md`.
- Remaining scoped follow-up (no deploy): the code-level frontend↔Deno pricing dedup — `audit/PRICING_DEDUP.md`.
