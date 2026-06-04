# ficwb Edge Function secrets audit

**Project:** `ficwbdrzefmblkbkomzw`  
**Deployed functions:** 63 (as of 2026-06-02)  
**Method:** Code scan of deployed slugs + remote secret **names** via Management API (no values).

## How to refresh live exist/missing status

```bash
export SUPABASE_ACCESS_TOKEN="sbp_..."   # Dashboard → Account → Access Tokens
cd padeltrainer
python3 scripts/migration/ficwb_secrets_audit.py
```

Or:

```bash
npx supabase login   # must yield sbp_ token, not service role
npx supabase secrets list --project-ref ficwbdrzefmblkbkomzw
```

Optional smoke (only checks 3 secrets):

```bash
curl -s "https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/health-check" \
  -H "Authorization: Bearer <FICWB_ANON_KEY>" | jq '.checks.secrets'
```

---

## Auto-injected (always present on Edge Functions)

| Secret | Status |
|--------|--------|
| `SUPABASE_URL` | **exists** (platform) |
| `SUPABASE_ANON_KEY` | **exists** (platform) |
| `SUPABASE_SERVICE_ROLE_KEY` | **exists** (platform) |

---

## Custom secrets by category (deployed-function scope)

Legend: **exists** / **missing** = on ficwb Edge secrets store. Run script above to populate.

### Resend

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `RESEND_API_KEY` | `signup-user`, `send-auth-email`, `send-email`, `send-invoice-email`, `forward-invoice`, `send-campaign-emails`, `send-priority-claim-invitation`, `submit-guest-intake`, `trigger-welcome-emails` (+ indirect: `notify-followers`, `send-schedule-notifications` via `send-email`) | **Critical** — auth emails, bookings, invoices, campaigns fail |

### Mollie

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `MOLLIE_API_KEY` | `create-mollie-payment`, `create-invoice-payment`, `verify-mollie-payment`, `mollie-webhook` | **Critical** — payments / webhooks fail |
| `MOLLIE_CLIENT_ID` | `check-mollie-connect-status`, `create-mollie-payment`, `create-invoice-payment`, `mollie-callback`, `mollie-connect-academy`, `mollie-connect-trainer`, `mollie-webhook`, `verify-mollie-payment` | **Critical** — Connect OAuth broken |
| `MOLLIE_CLIENT_SECRET` | Same as above (except connect init-only paths) | **Critical** — token refresh / callback fail |

### Stripe

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `STRIPE_SECRET_KEY` | `signup-user`, `create-stripe-checkout`, `customer-portal`, `check-stripe-subscription`, `cancel-stripe-subscription` | **High** — SaaS subscription flows fail |
| `STRIPE_WEBHOOK_SECRET` | *(none — `stripe-subscription-webhook` not deployed on ficwb)* | **Low** until webhook function deployed |

### Google Calendar

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `GOOGLE_CLIENT_ID` | `google-calendar-auth`, `sync-calendar-event` | **High** — cannot start OAuth |
| `GOOGLE_CLIENT_SECRET` | `sync-calendar-event` | **High** — token refresh / sync fail |

**Deploy gap:** `google-calendar-callback` is **not** on ficwb — calendar OAuth redirect will 404 even if secrets exist. Deploy from repo when enabling calendar.

### Reditus

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `REDITUS_PRODUCT_ID` | `reditus-referral-token` | **Low** — referral widget JWT fails |
| `REDITUS_PRODUCT_SECRET` | `reditus-referral-token` | **Low** |
| `REDITUS_WEBHOOK_SECRET` | *(none — `reditus-referral-webhook` not deployed)* | **Low** |

### Lovable AI

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `LOVABLE_API_KEY` | `enrich-clubs`, `generate-blog-article`, `generate-blog-cover`, `generate-proposals`, `scrape-academies`, `translate-blog-article` | **Medium** — admin AI / enrichment fail |

### Firecrawl

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `FIRECRAWL_API_KEY` | `enrich-clubs`, `fetch-location-logos`, `scrape-academies` | **Medium** — scraping / logo jobs fail |

### Slack

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `SLACK_WEBHOOK_URL` | `slack-notify` | **Low** — ops alerts only; payments still work |

### Public app URLs

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `PUBLIC_APP_URL` | `send-priority-claim-invitation` (fallback: `https://padeltrainer.lovable.app`) | **High** — wrong links in claim emails |
| `APP_URL` | `create-invoice-payment` (fallback: `https://padeltrainer.ai`) | **High** if fallback wrong for your environment |

### Migration invoice secret

| Secret | Required by deployed functions | Impact if missing |
|--------|-------------------------------|-------------------|
| `MIGRATION_INVOICE_SECRET` | `generate-invoice` (migration header path only) | **Medium** — batch PDF regen via `X-Migration-Secret` fails; normal user invoice auth unchanged |

---

## Copy immediately (from ppkbhd → ficwb)

If live verification shows **missing**, copy these first:

### Critical
- `RESEND_API_KEY`
- `MOLLIE_API_KEY`
- `MOLLIE_CLIENT_ID`
- `MOLLIE_CLIENT_SECRET`

### High
- `STRIPE_SECRET_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PUBLIC_APP_URL` → set to `https://padeltrainer.ai`
- `APP_URL` → set to `https://padeltrainer.ai`

### Medium (before using feature)
- `LOVABLE_API_KEY`
- `FIRECRAWL_API_KEY`
- `MIGRATION_INVOICE_SECRET` (only if running invoice PDF migration)

### Low (when needed)
- `SLACK_WEBHOOK_URL`
- `REDITUS_PRODUCT_ID`, `REDITUS_PRODUCT_SECRET`
- `STRIPE_WEBHOOK_SECRET` (after deploying `stripe-subscription-webhook`)

---

## Not in scope of deployed functions (skip unless you deploy more)

- `REDITUS_WEBHOOK_SECRET` — needs `reditus-referral-webhook`
- `STRIPE_WEBHOOK_SECRET` — needs `stripe-subscription-webhook`
- `PUBLIC_API_KEY` — needs `public-api`
