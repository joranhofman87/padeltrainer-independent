# Migration stabilization checklist

**Status:** Production cutover live on `https://padeltrainer.ai`  
**Target stack:** Cloudflare Worker → Vercel (`padeltrainer-independent`) → Supabase **ficwbdrzefmblkbkomzw**  
**Legacy stack (rollback):** Lovable origin → Supabase **ppkbhdiiqdusdeatgdft**

Use this document in **stabilization mode** only. Do not treat known deferred items as cutover blockers unless a row is marked **P0**.

**How to read each row**

| Field | Meaning |
|-------|---------|
| **Priority** | P0 = production broken / revenue / auth; P1 = major feature degraded; P2 = cleanup / non-blocking |
| **How to test** | Concrete steps (manual or CLI) |
| **Expected** | Pass criteria |
| **Rollback / fix** | What to do if it fails |

---

## 1. Critical checks (product)

### 1.1 Login (email/password)

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Incognito → `https://padeltrainer.ai/app/auth` → sign in as migrated trainer and player. DevTools → Network: filter `ficwb`, `auth`, `functions`. |
| **Expected** | Redirect to role dashboard; no CORS errors; session cookie uses `sb-ficwbdrzefmblkbkomzw-auth-token` (not `sb-ppkbhd...`). `check-stripe-subscription` returns 200 for trainers. |
| **Rollback / fix** | Supabase Auth → URL config includes `https://padeltrainer.ai/**`. Worker `ORIGIN_URL` → Vercel. Edge: deploy `check-stripe-subscription` on ficwb. CORS: `_shared/cors.ts` + redeploy affected functions. |

### 1.2 Signup (trainer or player)

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Incognito → `/app/signup/trainer` or `/app/signup/player` → complete signup with new test email (or staging email). |
| **Expected** | Account created in ficwb `auth.users`; confirmation flow works; lands in onboarding or dashboard. `signup-user` / `send-auth-email` succeed in Network tab. |
| **Rollback / fix** | Deploy `signup-user`, `send-auth-email` on ficwb. Verify Resend + Auth email templates. ficwb secrets: `RESEND_API_KEY`, etc. |

### 1.3 Google OAuth

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Incognito → `/app/auth` → “Continue with Google”. Complete OAuth; return to app. |
| **Expected** | Redirect to `https://padeltrainer.ai/...` (or `/app/auth` with hash); session established; dashboard loads. |
| **Rollback / fix** | Supabase Auth → Google provider: redirect URLs include `https://padeltrainer.ai/**` and `https://www.padeltrainer.ai/**`. Google Cloud Console OAuth client: authorized redirect URI `https://ficwbdrzefmblkbkomzw.supabase.co/auth/v1/callback`. |

### 1.4 Password reset

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | `/app/forgot-password` → submit email for migrated user → open link (if email enabled) → `/app/reset-password` → set new password → login. |
| **Expected** | Email received (if Resend configured); reset link host is `padeltrainer.ai`; new password works. |
| **Rollback / fix** | Auth redirect URLs; `send-auth-email` on ficwb; `PUBLIC_APP_URL` / site URL in Supabase = `https://padeltrainer.ai`. |

### 1.5 Trainer dashboard

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Login as trainer → `/app/trainer` (or role home). Open schedule, bookings, settings. |
| **Expected** | Data loads from ficwb DB; no 401/404 on edge calls; subscription/trial state shown. |
| **Rollback / fix** | Vercel env `VITE_SUPABASE_*` = ficwb. Deploy missing trainer-related functions (see §2). RLS policies on target DB. |

### 1.6 Academy dashboard

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Login as academy manager → academy home, trainers, invoices list. |
| **Expected** | Academy profile and trainers visible; navigation works. |
| **Rollback / fix** | Same as trainer; `get-admin-stats` only for admin—academy uses DB + `check-stripe-subscription` / Mollie functions. |

### 1.7 Create availability

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | Trainer → add slot (single or recurring) in schedule UI → save. Refresh page. |
| **Expected** | Slot persists in `availability_slots`; visible on trainer calendar and public booking page. |
| **Rollback / fix** | DB write permissions / RLS. `notify-followers` optional on publish—deploy if used. `sync-calendar-event` if Google Calendar connected. |

### 1.8 Create booking

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Public book flow: trainer booking link → select slot → complete booking (free or paid path). Trainer sees booking in dashboard. |
| **Expected** | Row in `bookings`; confirmation emails if configured; no failed `create-mollie-payment` / `send-email` in Network. |
| **Rollback / fix** | Deploy `create-mollie-payment`, `send-email`, `auto-create-invoice`, `slack-notify` on ficwb as needed. Mollie webhook URL must point to ficwb `mollie-webhook`. |

### 1.9 Mollie payment

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Book paid lesson OR pay public invoice → Mollie checkout → complete test payment → return URL. |
| **Expected** | `verify-mollie-payment` or invoice payment flow succeeds; booking/invoice status updated. |
| **Rollback / fix** | ficwb secrets: Mollie keys. Deploy `create-mollie-payment`, `create-invoice-payment`, `verify-mollie-payment`, `mollie-webhook`, `mollie-callback`. Mollie dashboard webhook URL: `https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/mollie-webhook`. |

### 1.10 Invoice creation

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | Trainer → create invoice (manual or from booking) → generate PDF → download/view. |
| **Expected** | Invoice row created; `generate-invoice` returns `pdfUrl`; PDF on ficwb storage (or regenerates). New invoices use ficwb URLs. |
| **Rollback / fix** | Deploy `generate-invoice`, `auto-create-invoice`, `sync-invoice-to-bookings`. Storage bucket `invoices` on ficwb. Migration secret `MIGRATION_INVOICE_SECRET` if batch regen. **Historical PDFs** still old host (known issue). |

### 1.11 Email sending

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | Trigger one transactional email: booking confirmation, invoice email, or campaign (low volume). Check inbox / Resend dashboard. |
| **Expected** | `send-email` / `send-invoice-email` 200; email delivered; links use `padeltrainer.ai`. |
| **Rollback / fix** | Deploy `send-email`, `send-invoice-email`, `send-campaign-emails`, `trigger-welcome-emails`. ficwb `RESEND_API_KEY`; domain `app.padeltrainer.ai` verified. |

### 1.12 Admin dashboard

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | Login as admin → admin home / users list. Open stats if shown. |
| **Expected** | `get-admin-stats` 200; user list loads; no CORS. |
| **Rollback / fix** | Deploy `get-admin-stats`, `impersonate-user`, `admin-reset-password`, `update-user`, `delete-user` on ficwb. Admin role in `user_roles`. |

---

## 2. Technical audits

### 2.1 Edge Functions used by frontend — deployed on ficwb

**Audit method (re-run anytime):**

```bash
# From padeltrainer/
npx supabase functions list --project-ref ficwbdrzefmblkbkomzw
```

Compare against frontend `functions.invoke(...)` names under `src/` (54 unique invocations as of stabilization doc).

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Grep `functions.invoke` in `src/`; diff slugs vs `supabase functions list`. Hit critical paths in browser Network tab—all requests to `ficwbdrzefmblkbkomzw.supabase.co`. |
| **Expected** | Every function invoked in production flows exists on ficwb with ACTIVE status. |
| **Rollback / fix** | `npx supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw` for each missing slug. |

**Currently deployed on ficwb (24 slugs matching frontend):**  
`auto-create-invoice`, `check-mollie-connect-status`, `check-stripe-subscription`, `create-academy-trainer`, `create-admin-trainer`, `create-club-trainer`, `create-invoice-payment`, `create-mollie-payment`, `delete-user`, `generate-invoice`, `get-admin-stats`, `get-public-invoice`, `mollie-connect-academy`, `mollie-connect-trainer`, `request-account-deletion`, `send-auth-email`, `send-email`, `send-invoice-email`, `signup-user`, `sync-invoice-to-bookings`, `trigger-welcome-emails`, `update-public-invoice-details`, `update-user`, `verify-mollie-payment`

**Frontend invokes NOT on ficwb yet (30 — deploy before relying on feature):**

| Function | Typical feature |
|----------|-----------------|
| `admin-reset-password` | Admin user tools |
| `bulk-cleanup-users` | Admin |
| `bulk-update-vat` | Invoice settings |
| `cancel-stripe-subscription` | Subscriptions |
| `create-stripe-checkout` | Stripe checkout |
| `customer-portal` | Stripe portal |
| `enrich-clubs` | Admin pipeline |
| `fetch-location-logos` | Admin |
| `finalize-proposals` | Cycles |
| `forward-invoice` | Invoice email forward |
| `generate-blog-article` | Admin blog AI |
| `generate-blog-cover` | Admin blog |
| `generate-proposals` | Cycles |
| `get-booking-invoice` | Booking success |
| `get-public-rating` | Public rating card |
| `google-calendar-auth` | Calendar connect |
| `impersonate-user` | Admin impersonation |
| `import-pipeline-data` | Admin import |
| `notify-followers` | Slot notifications |
| `reditus-referral-token` | Referral widget |
| `scrape-academies` | Admin |
| `send-campaign-emails` | Player campaigns |
| `send-priority-claim-invitation` | Cycles |
| `send-schedule-notifications` | Cycles |
| `slack-notify` | Internal alerts |
| `split-invoice` | Invoices |
| `submit-guest-intake` | Cycle applications |
| `sync-calendar-event` | Google Calendar |
| `toggle-player-role` | Trainer settings |
| `translate-blog-article` | Admin blog |

**Worker-only (not via frontend invoke):** `render-page`, `sitemap`, `llms-full-txt` — deployed on ficwb.

---

### 2.2 No runtime calls to `ppkbhdiiqdusdeatgdft`

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Production: DevTools → Network → filter `ppkbhd`. Repeat on `/nl`, `/app/auth`, trainer dashboard, one booking. CLI: load main JS bundle from `https://padeltrainer.ai` and grep `ppkbhd`. |
| **Expected** | **No** API, auth, storage, or function requests to `ppkbhdiiqdusdeatgdft.supabase.co`. |
| **Rollback / fix** | Vercel Production env: `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PROJECT_ID` = ficwb. Worker: all `*_FUNCTION_URL` + `SUPABASE_ANON_KEY` = ficwb. Code hotspots still referencing ppkbhd (fix in follow-up): `index.html` preconnect, `CityLanding.tsx` og-image URL, `useAuth.tsx` legacy `localStorage.removeItem('sb-ppkbhd...')`, `generate-blog-cover` default logo URL. |

---

### 2.3 No runtime calls to `padeltrainer.lovable.app`

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Network tab filter `lovable` on `padeltrainer.ai`. Confirm HTML/JS not loaded from Lovable origin. `curl -sI https://padeltrainer.ai/` → should not show `Set-Cookie: Domain=lovable.app`. |
| **Expected** | SPA served via Worker → Vercel; no document requests to `padeltrainer.lovable.app`. |
| **Rollback / fix** | Cloudflare Worker Production `ORIGIN_URL` = `https://padeltrainer-independent.vercel.app` (or custom Vercel domain). Purge Cloudflare cache. |

---

### 2.4 Cloudflare Worker uses ficwb + Vercel

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | Dashboard: Worker → Production variables. Live: compare `index-*.js` hash on `padeltrainer.ai` vs Vercel; footer badge **MIGRATION TEST - FICWB** on marketing pages. `curl -sI https://padeltrainer.ai/sitemap.xml` → `X-Sitemap-Source: edge-function`. |
| **Expected** | `ORIGIN_URL` = Vercel app URL. `SITEMAP_FUNCTION_URL` / `LLMS_FUNCTION_URL` / `RENDER_FUNCTION_URL` = ficwb `/functions/v1/...`. `SUPABASE_ANON_KEY` = ficwb publishable key. |
| **Rollback / fix** | Restore saved Worker env (Lovable + ppkbhd URLs + ppkbhd anon). Purge cache. |

**Reference (Production targets):**

| Variable | Value |
|----------|--------|
| `ORIGIN_URL` | `https://padeltrainer-independent.vercel.app` |
| `RENDER_FUNCTION_URL` | `https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/render-page` |
| `SITEMAP_FUNCTION_URL` | `https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/sitemap` |
| `LLMS_FUNCTION_URL` | `https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/llms-full-txt` |
| `SUPABASE_ANON_KEY` | ficwb anon/publishable key (same as Vercel `VITE_SUPABASE_PUBLISHABLE_KEY`) |

---

### 2.5 Vercel bundle uses ficwb

| | |
|--|--|
| **Priority** | P0 |
| **How to test** | `curl -sL https://padeltrainer.ai/ | grep -o 'index-[^"]*\.js'` → fetch bundle → grep `ficwbdrzefmblkbkomzw`. Vercel dashboard → Production env vars. |
| **Expected** | Main client bundle contains `https://ficwbdrzefmblkbkomzw.supabase.co`. |
| **Rollback / fix** | Redeploy Vercel with correct `VITE_*`; purge CF cache after Worker points to new deployment. |

---

### 2.6 Sanity CMS works

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | Open `/nl/blog`, one blog post, `/nl/learn` or topic hub if used. Check for 404/blank content. |
| **Expected** | Posts and marketing content render; images load. (Sanity project `ru3aqhjn` — independent of Supabase project.) |
| **Rollback / fix** | Sanity API keys in Vercel env if any; CDN/cors on Sanity dataset; not fixed by Supabase migration. |

---

### 2.7 Sitemap and llms-full.txt

| | |
|--|--|
| **Priority** | P1 |
| **How to test** | `curl -sI https://padeltrainer.ai/sitemap.xml`  
  `curl -sI https://padeltrainer.ai/sitemaps/sitemap-static.xml`  
  `curl -sI https://padeltrainer.ai/llms-full.txt` |
| **Expected** | HTTP 200; `X-Sitemap-Source: edge-function` / `X-LLMs-Source: edge-function` when proxied by worker; XML/text body valid. |
| **Rollback / fix** | Worker env URLs + anon key; deploy `sitemap` / `llms-full-txt` on ficwb; route `padeltrainer.ai/*` attached to worker. |

---

## 3. Known issues (accepted / deferred)

| Issue | Priority | Notes |
|-------|----------|--------|
| Historical invoice PDFs not regenerated | P2 | 57 `invoices.pdf_url` may still reference old signed ppkbhd URLs. App invoice **data** is fine; PDF download may fail until regen/copy. |
| 67 malformed `locations.logo_url` paths | P2 | Invalid extensions / embedded data URLs—not fixable by host replace. |
| Migration badge visible (`MIGRATION TEST - FICWB`) | P2 | `src/components/marketing/MarketingLayout.tsx` — remove after stabilization sign-off. |
| DB password should be rotated | P1 | Rotate ficwb DB password in Supabase; update `DATABASE_URL` / pooler secrets; never commit. |
| `MIGRATION_INVOICE_SECRET` on `generate-invoice` | P2 | Remove env + bypass code after batch PDF migration complete. |
| 30 edge functions not deployed to ficwb | P1 | See §2.1 — deploy on first use or bulk deploy. |
| Hardcoded ppkbhd in static/edge code | P2 | `index.html`, `CityLanding.tsx`, blog AI assets — cleanup pass. |

---

## 4. Stabilization workflow (recommended order)

1. **P0 smoke** (30 min): login, OAuth, trainer dashboard, one booking, Network tab clean for `ppkbhd` / `lovable`.
2. **P0 technical** (15 min): bundle ficwb, Worker env, sitemap/llms curl.
3. **Deploy missing functions** as failures appear (or batch deploy §2.1 list).
4. **P1 flows**: Mollie, invoices (new only), email, admin.
5. **P2 cleanup**: badge removal, secret rotation, invoice PDF batch, malformed logos.

---

## 5. Quick reference

| Resource | URL |
|----------|-----|
| Production site | https://padeltrainer.ai |
| Vercel origin | https://padeltrainer-independent.vercel.app |
| Supabase ficwb | https://ficwbdrzefmblkbkomzw.supabase.co |
| Legacy Supabase | https://ppkbhdiiqdusdeatgdft.supabase.co |
| Worker script (repo) | `docs/cloudflare-worker.js` |
| SEO functions | `sitemap`, `llms-full-txt`, `render-page` |

**Rollback (full production):** Cloudflare Worker Production env → Lovable `ORIGIN_URL` + ppkbhd function URLs + ppkbhd anon → purge cache. Vercel can stay on ficwb for preview; production traffic is controlled by Worker.

---

*Document created for post-cutover stabilization. No application code changed in this step.*
