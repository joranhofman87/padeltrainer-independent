# Error monitoring posture (pre-scale)

How errors surface today. The verdict from the pre-scale audit's P0-5 (observability) is:
**no Sentry is needed** — the app already routes errors to PostHog `$exception` and Slack.
This doc is the map so the next person knows what's watched and what isn't.

## Client (browser)
- `logger.error` / `logger.warn` → PostHog **`$exception`** with message, type, raw stack,
  level and context (`src/lib/logger.ts`). Dev also mirrors to `sessionStorage` (`app_errors`).
- Global `window` **`error`** + **`unhandledrejection`** handlers → `logger.error`
  (`src/main.tsx`), with cross-origin and stale-chunk (Vite preload / 524) noise filtered out.
- React **`ErrorBoundary`** wraps the app root.
- ⇒ Any uncaught client error or rejected promise lands in PostHog. **Covered.**

## Scheduled jobs (Vercel cron)
- `api/_lib/cron.ts` `alertCronFailure()` posts to the `slack-notify` edge fn on any non-2xx
  sub-job. Wired into `daily-maintenance` + `daily-emails`. **Covered.**

## Edge functions (server-side)
`console.error` in an edge fn only reaches Supabase's function logs (short retention, nobody
paged). The pattern for "this must not fail silently" is to also call
`notifySlackEdgeError(fnName, message, ctx?)` (`_shared/edge-slack.ts`) in the top-level catch.

Alerting today (money / delivery critical paths):
- Payments: `mollie-webhook`, `stripe-subscription-webhook`, `create-invoice-payment`,
  `create-mollie-payment`, `verify-mollie-payment`.
- Invoicing: `generate-invoice`, `invoice-health-check`, **`auto-create-invoice`**,
  **`create-registration-invoice`**, **`create-rebook-invoice`** (bold = added this pass —
  they mint money and can be reached server-side / publicly with no client to surface the error).
- Email/identity: `send-email`, `send-invoice-email`, `send-campaign-emails`, `signup-user`,
  `submit-guest-intake`.

Intentionally **not** alerted (console-only is fine): read-only / public-render / image /
SEO / status functions, and client-triggered actions whose failure the client already reports
to PostHog (the `supabase.functions.invoke` error path → `logger.error`). When adding a new
function that mutates money or runs without a client (cron / webhook / fn-to-fn), add
`notifySlackEdgeError` to its catch.

## Gaps / future
- No aggregated server-side error *rate* dashboard (Slack is per-event). PostHog can chart
  `$exception` for the client; edge fns aren't in PostHog. Acceptable at current scale.
- `mollie-callback` + `resend-webhook` remain console-only (a redirect handler and bounce
  capture — low blast radius). Revisit if they prove noisy.
