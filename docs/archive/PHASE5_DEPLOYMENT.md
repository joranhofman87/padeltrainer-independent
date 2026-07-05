# Phase 5 — Vercel Preview deployment

**Status:** In progress  
**Stop before:** Cloudflare DNS changes, Lovable deletion

---

## Local development port

| Item | Value |
|------|-------|
| Vite dev server | **http://localhost:8080** (`vite.config.ts`) |
| Playwright default | `http://localhost:8080` |
| CORS allowlist | `http://localhost:8080` (`supabase/functions/_shared/cors.ts`) |

Copy `.env.example` → `.env` with **ficwb** keys (not legacy `ppkbhd`).

---

## Supabase Auth redirect URLs (ficwb dashboard)

**Project:** `ficwbdrzefmblkbkomzw`  
**Dashboard:** Authentication → URL Configuration

| Setting | Value |
|---------|-------|
| Site URL | `https://padeltrainer.ai` |
| Redirect URLs | `https://padeltrainer.ai/**` |
| | `https://www.padeltrainer.ai/**` |
| | `http://localhost:8080/**` |
| | `https://*-joranhofman87s-projects.vercel.app/**` |

**Google OAuth** (Google Cloud Console → OAuth client):

- Authorized redirect URI: `https://ficwbdrzefmblkbkomzw.supabase.co/auth/v1/callback`

**Local callback path:** `http://localhost:8080/app/auth` (via `getAuthRedirectUrl`)

---

## Vercel project

| Setting | Value |
|---------|-------|
| Team | `joranhofman87s-projects` |
| Project | `padeltrainer-independent` |
| Production URL | `https://padeltrainer-independent.vercel.app` |
| Preview pattern | `https://<branch>-padeltrainer-independent.vercel.app` |

### Environment variables

**Preview + Production (public — `VITE_` prefix OK):**

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://ficwbdrzefmblkbkomzw.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ficwb anon key |
| `VITE_SUPABASE_PROJECT_ID` | `ficwbdrzefmblkbkomzw` |

**Preview + Production (server-only — never `VITE_`):**

| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Vercel Cron `Authorization: Bearer` |
| `SUPABASE_SERVICE_ROLE_KEY` | `/api/cron/*` → edge functions |

---

## Resend (`app.padeltrainer.ai`)

Configure domain in [Resend Dashboard](https://resend.com/domains).  
**Stop before Cloudflare DNS** — add records below in Cloudflare when approved.

Resend generates exact values per domain. Typical records for `app.padeltrainer.ai`:

| Type | Name | Value | Notes |
|------|------|-------|-------|
| TXT | `app` or `@` | `v=spf1 include:amazonses.com ~all` | SPF (exact string from Resend) |
| TXT | `resend._domainkey.app` | `p=MIGfMA0GCSq...` | DKIM (exact from Resend) |
| TXT | `_dmarc.app` | `v=DMARC1; p=none;` | Optional; Resend may suggest |

**Do not add MX** unless enabling custom return-path or inbound mail.

From address: `PadelTrainer.ai <noreply@app.padeltrainer.ai>`

---

## Cron architecture (Lovable → Vercel)

| Schedule | Vercel path | Edge functions invoked |
|----------|-------------|------------------------|
| `0 12 * * *` | `/api/cron/daily-emails` | `process-onboarding-emails`, `send-digest-emails` |
| `0 6 * * *` | `/api/cron/daily-maintenance` | `backup-database`, `invoice-health-check`, `enrich-clubs`, `fetch-location-logos` |

After Vercel cron is verified, unschedule pg_cron on ficwb:

```sql
SELECT public.unschedule_all_background_pg_cron_jobs();
```

(pg_cron `schedule_*` RPCs now target ficwb URLs as admin fallback.)

---

## Email reliability

- **Retries:** `_shared/resend-send.ts` — max 3 attempts, ~400ms linear backoff (~3s total).
- **Non-blocking:** email failures return errors; callers update queue/logs without aborting unrelated work.
- **Idempotency:** `claim_onboarding_email_queue_item` RPC + unique index on `onboarding_email_logs(queue_id) WHERE status='sent'`.

---

## CI

| Workflow | Check |
|----------|-------|
| `.github/workflows/migrations.yml` | `supabase db reset` + types drift |
| `.github/workflows/test.yml` | unit tests |

Local:

```bash
npm run db:reset
npm run db:types:check
```

---

## Preview deployment checklist

- [ ] SSR/prerender: marketing pages, `render-page` bot HTML
- [ ] API: `/api/cron/*` returns 401 without `CRON_SECRET`
- [ ] Auth: email/password, Google OAuth, verify, reset
- [ ] Authenticated routes: trainer, academy, admin
- [ ] Resend: transactional email delivers
- [ ] Unsubscribe/suppression (if campaign enabled)
- [ ] Cron: Vercel dashboard shows successful invocations
- [ ] Storage: avatar/invoice upload
- [ ] OG: static + dynamic `og-image` / `rating-og-image`
- [ ] PostHog: events on preview (currently production-only in code)
- [ ] Sentry: not configured (blocker for full observability)
- [ ] Security headers: `curl -sI <preview-url>`

---

## Production cutover blockers (unchanged)

1. Cloudflare DNS / Worker `ORIGIN_URL` → Vercel (not done in Phase 5)
2. Resend DNS in Cloudflare
3. Remaining edge function deploys (see `MIGRATION_STABILIZATION.md` §2.1)
4. Google OAuth production client verification
5. Delete Lovable deployment (explicit approval)
