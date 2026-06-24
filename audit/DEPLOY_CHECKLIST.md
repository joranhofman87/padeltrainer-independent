# Owner Deploy Checklist — pre-scale hardening

Things that **do NOT auto-deploy** (only the Vercel frontend does). Apply these to the
live project `ficwbdrzefmblkbkomzw` after the matching PR merges. Tick as you go.

## Edge functions to (re)deploy
`supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw`

- [ ] **update-user** — IDOR fix (#77). *Security — do this one first.*
- [ ] **stripe-subscription-webhook**, **og-image**, **rating-og-image**, **get-public-rating**, **health-check** — redeploy so prod matches the new `config.toml` `verify_jwt=false` (#78). Prevents a future deploy from 401-ing them.
- [ ] **send-email** — HTML-injection escaping for registrant text (#80). *Security — closes the public submit-guest-intake → cross-tenant admin email injection vector.*
- [ ] **send-campaign-emails** — resumable + accurate sent counts (#80). Stops silently dropping the unprocessed tail on timeout / marking failures as sent.
- [ ] **send-campaign-emails** — autonomous resume: service-role chain + daily sweep (#81). Ships `config.toml verify_jwt=false` for this fn (so the sweep cron isn't 401'd) — redeploy required. The `daily-maintenance` cron change auto-deploys via Vercel.
- [ ] **send-campaign-emails** — bounded failed-recipient retry (#82). **Apply the migration below FIRST**, then redeploy — the fn writes `attempt_count`, which 404s if the column isn't there yet.

_(rows below are appended as later PRs land)_

## Migrations to apply
- [ ] **`20260624130000_email_campaign_recipient_attempt_count.sql`** (#82) — adds `email_campaign_recipients.attempt_count`. Additive + backward-compatible (the old fn ignores it), so safe to apply before the redeploy. **Apply before redeploying send-campaign-emails for #82.**

## Config / dashboard
- [ ] Confirm `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` set in Vercel **Production** (already done earlier in the session — re-verify).
- [ ] Decide production error monitoring (Sentry vs PostHog $exception) — P0-5 observability, still open.

## Notes
- The CI changes (rehearsal runner, edge-fn config guard, cron Slack alerts, stale-ref purge) take effect on merge — no manual deploy.
- Dependency-vuln upgrade is **deferred** (blanket `npm audit fix` breaks the build); needs a dedicated surgical pass.
