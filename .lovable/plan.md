

# Production Readiness Assessment

## Verdict: NOT production-ready — 3 critical security vulnerabilities must be fixed before launch

---

## CRITICAL (Must fix before any real user touches this)

### 1. Privilege Escalation: Any user can make themselves admin
The `user_roles` table has an INSERT policy `Users can insert their own roles` that only checks `auth.uid() = user_id`. Any authenticated user can insert `role = 'admin'` and gain full admin access to the entire system — all data, all users, all payments.

**Fix:** Remove the `Users can insert their own roles` policy entirely. Role assignment must happen exclusively via server-side edge functions using the service role key (which already exists for signup flows).

### 2. Mollie OAuth tokens exposed to all authenticated users
The `trainer_mollie_accounts` and `academy_mollie_accounts` tables have SELECT policies that use `USING (true)` for all authenticated users. This means every logged-in player can read every trainer's and academy's Mollie `access_token` and `refresh_token` — giving them direct API access to payment accounts.

**Fix:** Replace the broad SELECT policies with ones scoped to the owner:
- `trainer_mollie_accounts`: `trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())`
- `academy_mollie_accounts`: `academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))`
- Admin override via `is_admin(auth.uid())`

### 3. Trainer PII publicly readable
The `trainer_profiles` public SELECT policy exposes IBAN, BIC, KVK number, BTW number, business address, and internal Mollie IDs to unauthenticated users. A `trainer_profiles_safe` view already exists but the policy targets the base table.

**Fix:** Remove or restrict the public SELECT policy on `trainer_profiles` to only return columns that are in the safe view, or redirect public access through the view.

---

## HIGH (Fix before launch, but not a data breach risk)

### 4. Profiles table leaks email/phone publicly
The `profiles` policy `Anyone can view public trainer profiles` exposes email, phone, billing details for all public trainers. A `profiles_public` view exists that omits these. Same pattern as #3.

### 5. Club/Academy payment metadata publicly visible
`club_profiles` and `academy_profiles` public SELECT policies expose `mollie_customer_id`, `subscription_id`, and `platform_fee_override`. Public views exist that omit these fields.

### 6. Leaked password protection disabled
A backend auth setting that checks passwords against known breach databases is turned off. Should be enabled.

---

## MEDIUM (Should fix, won't block launch)

### 7. Remaining `console.error` calls: ~540 across 53 files
Pages migrated: 26 of 29 (3 remain: `TrainersCity.tsx`, `AdminRatingSystems.tsx`, `AdminBlogEditor.tsx`). Components: ~50 files with ~505 `console.error` calls still unmigrated. These errors are invisible in production.

### 8. 2 tables with RLS enabled but no policies
Tables exist with RLS turned on but zero policies defined, meaning all access is denied. This may be intentional (admin-only via service role) or a bug causing silent failures.

### 9. 3 Security Definer Views
Views using `SECURITY DEFINER` bypass the querying user's RLS. These are likely the `_public`/`_safe` views which is an intentional pattern, but should be verified.

### 10. Extension in public schema
`pg_net` is installed in the `public` schema. This is a known Supabase limitation and cannot be moved.

---

## What's Solid

- Architecture: Lazy-loaded routes, error boundaries on signup/auth pages, legacy redirect handling
- SEO: Multilingual hreflang, JSON-LD, sitemap automation, Cloudflare pre-rendering for bots
- Auth: INITIAL_SESSION pattern eliminates race conditions, role-based routing, honeypot + rate limiting on signups
- Tracking: Full PostHog funnel from UTM capture through booking/payment
- Payments: Mollie OAuth Connect with token refresh, application fees, webhook verification
- Logging: Centralized logger on 26+ pages (though components still need migration)

---

## Recommended Fix Plan

### Phase 1: Security hotfixes (3 database migrations, blocks launch)

1. **Drop the `user_roles` INSERT policy** — replace with nothing (edge functions already handle role assignment via service role)
2. **Restrict `trainer_mollie_accounts` SELECT** — scope to own record + admin
3. **Restrict `academy_mollie_accounts` SELECT** — scope to own academy + admin
4. **Restrict `trainer_profiles` public SELECT** — limit columns or redirect through safe view
5. **Restrict `profiles` public SELECT** — same pattern
6. **Restrict `club_profiles` public SELECT** — exclude payment columns
7. **Restrict `academy_profiles` public SELECT** — exclude payment/fee columns
8. **Enable leaked password protection** via auth config

### Phase 2: Remaining logging (3 pages + ~50 components)

Migrate `console.error` → `logger.error` in:
- 3 remaining pages: `TrainersCity.tsx`, `AdminRatingSystems.tsx`, `AdminBlogEditor.tsx`
- Top 15 components (Phase 4 from previous plan)

### Phase 3: Verify RLS-no-policy tables

Check the 2 tables with RLS enabled but no policies to confirm they're intentionally service-role-only.

---

## Summary

| Category | Status |
|----------|--------|
| Security: privilege escalation | CRITICAL — any user can become admin |
| Security: payment token exposure | CRITICAL — Mollie tokens readable by all |
| Security: PII exposure | HIGH — IBAN, email, phone publicly readable |
| Auth & routing | Good |
| SEO & discoverability | Good |
| Analytics & tracking | Good (just implemented) |
| Error handling | Good on pages, incomplete on components |
| Logging | 85% migrated, 15% remaining |

**Bottom line: Fix the 3 critical security issues (items 1-3) and this is launch-ready. Everything else is polish.**

