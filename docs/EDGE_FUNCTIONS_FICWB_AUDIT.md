# Edge functions not on ficwb — audit (30)

**Project:** `ficwbdrzefmblkbkomzw`  
**Audit date:** 2026-05-31  
**Legend:** Frontend = invoked from `src/` via `supabase.functions.invoke`. Cron/webhook = pg_cron, or called from other edge functions / external webhooks (not browser).

---

## P0 — Required for production (deploy now)

| # | Function | Purpose | Frontend | Admin only | Cron/webhook | Risk if missing | Deploy now |
|---|----------|---------|:--------:|:----------:|:------------:|-----------------|:----------:|
| 1 | `create-stripe-checkout` | Stripe Checkout session for trainer/academy/club subscriptions | Yes | No | No | Cannot start or upgrade SaaS subscription | **Yes** |
| 2 | `customer-portal` | Stripe Customer Portal (billing management) | Yes | No | No | Cannot manage payment method / subscription in portal | **Yes** |
| 3 | `cancel-stripe-subscription` | Cancel Stripe subscription (trainer/academy/club) | Yes | No | No | Cancel subscription fails | **Yes** |
| 4 | `get-booking-invoice` | Resolve invoice link/PDF after booking (Booking Success page) | Yes | No | No | Post-payment booking page broken; no invoice link | **Yes** |
| 5 | `forward-invoice` | Email invoice PDF to player; also used after Mollie payment | Yes | No | **Yes** (`mollie-webhook`, `auto-create-invoice`) | Paid booking invoice email fails; manual forward fails | **Yes** |

---

## P1 — Deploy soon (needs approval)

| # | Function | Purpose | Frontend | Admin only | Cron/webhook | Risk if missing | Deploy now |
|---|----------|---------|:--------:|:----------:|:------------:|-----------------|:----------:|
| 6 | `google-calendar-auth` | Start Google Calendar OAuth for trainers | Yes | No | No | Calendar connect broken | No |
| 7 | `sync-calendar-event` | Sync lesson to Google Calendar | Yes | No | No | Calendar events not created/updated | No |
| 8 | `notify-followers` | Email followers when trainer publishes availability | Yes | No | No | No follower notifications for new slots | No |
| 9 | `split-invoice` | Split one invoice across multiple players | Yes | No | No | Split-invoice action fails | No |
| 10 | `toggle-player-role` | Enable/disable player role on trainer account | Yes | No | No | Player-role toggle in settings fails | No |
| 11 | `bulk-update-vat` | Bulk-update VAT on open invoices | Yes | No | No | VAT change on invoice settings fails | No |
| 12 | `slack-notify` | Internal Slack ops alerts | Yes | No | **Yes** (many functions: `mollie-webhook`, `signup-user`, `verify-mollie-payment`, etc.) | Payments/bookings work; ops alerts missing | No |
| 13 | `impersonate-user` | Admin impersonation magic link | Yes | **Yes** | No | Admin support impersonation broken | No |
| 14 | `admin-reset-password` | Admin-set password for user | Yes | **Yes** | No | Admin password reset broken | No |
| 15 | `send-campaign-emails` | Trainer email campaigns to players | Yes | No | No | Marketing campaigns cannot send | No |
| 16 | `generate-proposals` | Academy cycle: generate slot proposals | Yes | No | No | Cycle proposal wizard broken | No |
| 17 | `finalize-proposals` | Academy cycle: finalize proposals → bookings | Yes | No | No | Cannot finalize cycle schedules | No |
| 18 | `send-schedule-notifications` | Notify players after cycle schedule published | Yes | No | No | Cycle publish notifications missing | No |
| 19 | `send-priority-claim-invitation` | Invite players to priority claims (cycles) | Yes | No | No | Priority claim emails fail | No |
| 20 | `submit-guest-intake` | Guest application intake for academy cycles | Yes | No | No | Guest cycle applications fail | No |
| 21 | `enrich-clubs` | AI/metadata enrichment for club locations | No | **Yes** | **Yes** (pg_cron `enrich-locations-background` — **still points at ppkbhd URL**) | Background enrichment stops until cron URL updated | No |
| 22 | `fetch-location-logos` | Fetch missing location logos | No | **Yes** | **Yes** (pg_cron `fetch-location-logos-background` — **ppkbhd URL**) | Background logo fetch stops | No |

---

## P2 — Safe to leave undeployed (until needed)

| # | Function | Purpose | Frontend | Admin only | Cron/webhook | Risk if missing | Deploy now |
|---|----------|---------|:--------:|:----------:|:------------:|-----------------|:----------:|
| 23 | `get-public-rating` | Public rating card page data | Yes | No | No | Public rating widget/page empty/errors | No |
| 24 | `reditus-referral-token` | Reditus referral widget token | Yes | No | No | Referral widget broken | No |
| 25 | `generate-blog-article` | AI generate blog post (admin) | Yes | **Yes** | **Yes** (`process-blog-queue`) | Admin blog AI + queue broken | No |
| 26 | `generate-blog-cover` | AI blog cover image | Yes | **Yes** | No | Blog cover generation fails | No |
| 27 | `translate-blog-article` | Translate blog article locales | Yes | **Yes** | **Yes** (`process-blog-queue`) | Blog translation fails | No |
| 28 | `scrape-academies` | Admin scrape/import academies | Yes | **Yes** | No | Admin scrape tool fails | No |
| 29 | `bulk-cleanup-users` | Admin bulk user cleanup | Yes | **Yes** | No | Admin cleanup tool fails | No |
| 30 | `import-pipeline-data` | Admin data import pipeline | Yes | **Yes** | No | Admin import fails | No |

---

## P0 deploy command

```bash
cd padeltrainer
npx supabase functions deploy \
  create-stripe-checkout \
  customer-portal \
  cancel-stripe-subscription \
  get-booking-invoice \
  forward-invoice \
  --project-ref ficwbdrzefmblkbkomzw
```

**Post-deploy:** Ensure ficwb secrets include `STRIPE_SECRET_KEY`, `RESEND_API_KEY` (forward-invoice), and Stripe webhook endpoint points to ficwb `stripe-subscription-webhook` (separate function — already deployed if subscriptions work).

**Cron note:** `enrich-clubs` / `fetch-location-logos` require updating pg_cron job URLs on ficwb (SQL migration or `schedule_*` RPC), not only function deploy.
