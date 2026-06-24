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
- [x] **`20260624130000_email_campaign_recipient_attempt_count.sql`** (#82) — adds `email_campaign_recipients.attempt_count`. Additive + backward-compatible; applied before redeploying send-campaign-emails.

## Config / dashboard
- [x] `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` set in Vercel **Production** (verified).
- [x] Production error monitoring — **resolved**: PostHog `$exception` (client) + Slack alerts (cron + critical edge fns) cover it; no Sentry needed (#83, see `audit/MONITORING.md`).

## Notes
- The CI changes (rehearsal runner, edge-fn config guard, cron Slack alerts, stale-ref purge) took effect on merge — no manual deploy.
- Dependency-vuln upgrade: the production-runtime fixes shipped (#84, react-router + protobufjs); the dev/build + Vercel-runtime remainder is documented as deferred in `audit/DEPENDENCIES.md`.
- Remaining scoped follow-up (no deploy): the code-level frontend↔Deno pricing dedup — `audit/PRICING_DEDUP.md`.
