# PadelTrainer.ai Pre-Launch Checklist

**Last Updated:** 2026-03-11  
**Status:** Ready for Production

---

## ✅ Completed Items

### Code Quality
- [x] All Stripe references removed and replaced with Mollie
- [x] Translation files complete for EN and NL
- [x] **COMPLETE** No production console.error/warn statements (all migrated to logger)
  - Core libraries: 10 files migrated
  - Pages: 29 files migrated
  - Components: 28 files migrated
  - Hooks: 6 files migrated
  - All remaining admin/internal components migrated (2026-03-11)
- [x] Error boundaries implemented for graceful failure
- [x] SEO component added to all marketing pages
- [x] Structured data (JSON-LD) on key pages
- [x] data-testid attributes on critical UI elements
- [x] Image lazy loading implemented
- [x] Deprecated `isAppPage` SEO prop removed (2026-03-11)
- [x] All files migrated to unified Supabase client (`@/lib/supabaseClient`) (2026-03-11)

### Security
- [x] RLS policies on all sensitive tables
- [x] Admin functions verify role server-side
- [x] Input validation on all edge functions
- [x] Rate limiting on contact forms (3 requests/hour)
- [x] HTML sanitization for user inputs
- [x] SECURITY DEFINER functions use `search_path = public`
- [x] Security scan findings reviewed and all documented (2026-03-11)
  - All findings reviewed — 0 actionable issues remaining
  - All findings documented with ignore reasons
  - admin_impersonation_logs INSERT tightened to is_admin() check
  - Mollie verification fields protected by database trigger
  - slack-notify endpoint secured with service role key auth

### Payments (Mollie)
- [x] create-mollie-payment function deployed
- [x] verify-mollie-payment function deployed
- [x] mollie-webhook function deployed
- [x] mollie-subscription-webhook function deployed
- [x] create-mollie-subscription function deployed
- [x] cancel-mollie-subscription function deployed
- [x] mollie-connect-trainer function deployed
- [x] mollie-connect-club function deployed

### Authentication
- [x] Email verification enabled
- [x] Password reset flow working
- [x] Role-based access control implemented
- [x] Impersonation logging for admin (admin_impersonation_logs table)

### SEO
- [x] Sitemap edge function deployed (dynamic sitemap index via Cloudflare Worker)
- [x] Static sitemap.xml fallback via GitHub Action
- [x] Dynamic sitemap proxy live (Cloudflare Worker → edge function)
- [x] llms.txt for AI crawlers
- [x] Hreflang tags for EN/NL/ES/DE/FR (all 5 languages)
- [x] Open Graph meta tags
- [x] Twitter cards
- [x] Structured data on 9+ pages

### Observability (2026-03-11)
- [x] Structured logger with PostHog exception tracking
- [x] Global error/unhandledrejection handlers in main.tsx
- [x] FeatureErrorBoundary on all critical user flows
- [x] Cookieless PostHog (GDPR-compliant, production-only)
- [x] Health-check edge function for uptime monitoring
- [x] Slack error alerting on critical payment functions (mollie-webhook, create-mollie-payment, verify-mollie-payment)
- [x] `edge_function_error` event type added to slack-notify

### E2E Tests
- [x] Authentication flows
- [x] Navigation
- [x] Booking flows
- [x] Role-based access
- [x] i18n language switching
- [x] Accessibility basics
- [x] Performance thresholds
- [x] Error handling
- [x] All tests updated to current route structure (2026-03-11)

---

## ⚠️ Known Warnings (Acceptable)

| Issue | Reason | Risk Level |
|-------|--------|------------|
| profiles_public uses security_invoker=off | Intentional for public trainer profiles | Low |
| pg_net extension in public schema | Cannot be moved (Supabase limitation) | None |
| Leaked password protection disabled | Requires Supabase dashboard toggle | Low |
| subscription_payments & notification_queue have no RLS policies | Intentionally service-role-only tables | None |
| admin_impersonation_logs INSERT uses USING(true) | Service-role-only inserts during impersonation | None |

---

## 📋 Pre-Launch Manual Verification

### Payment Testing
- [ ] Test Mollie payment with test card
- [ ] Verify webhook receives payment confirmation
- [ ] Test subscription creation and cancellation
- [ ] Test trainer payout flow

### User Flows
- [ ] Complete trainer signup → onboarding → first lesson
- [ ] Complete player signup → book lesson → receive confirmation
- [ ] Complete club signup → onboarding → add trainer
- [ ] Complete academy signup → create cycle → receive applications

### Mobile Verification
- [ ] Test all pages on iPhone Safari
- [ ] Test all pages on Android Chrome
- [ ] Verify touch targets are 44px minimum
- [ ] Check calendar drag-and-drop on mobile

### Email Delivery
- [ ] Verify welcome emails are sent
- [ ] Verify booking confirmation emails
- [ ] Verify password reset emails
- [ ] Check spam folder delivery rates

---

## 🚀 Launch Day

1. [ ] Deploy to production domain
2. [ ] Verify DNS propagation
3. [ ] Check SSL certificates
4. [ ] Monitor error logs for first hour
5. [ ] Verify sitemap is accessible
6. [ ] Submit sitemap to Google Search Console
7. [ ] Verify Mollie webhooks receiving events
8. [ ] Test one real payment (small amount)
9. [ ] Set up uptime monitoring (UptimeRobot/BetterStack) pointing to health-check endpoint

---

## 📊 Post-Launch Monitoring

- [ ] Set up Sentry/LogRocket integration (TODO in logger.ts)
- [ ] Monitor edge function logs daily for first week
- [ ] Track Core Web Vitals in Search Console
- [ ] Monitor payment success rates in Mollie dashboard
- [ ] Review user signup funnel analytics
- [ ] Build PostHog dashboard for signup → booking → payment funnel

---

## 📝 Technical Debt (Low Priority)

| Item | Location | Notes |
|------|----------|-------|
| Logger monitoring integration | `src/lib/logger.ts:68` | TODO: Integrate with Sentry |
| Slot picker for proposals | `src/components/cycles/ProposalCard.tsx` | Button disabled until feature is built |
| Plan placeholder values | `src/components/admin/PlanEditDialog.tsx` | Admin-only, cosmetic |
| TrainerDashboard refactoring | `src/pages/TrainerDashboard.tsx` | Components extracted but file still large |
| Legacy redirect routes | `src/components/DomainRouter.tsx` | ~12 routes for old path compatibility — keep for now, add usage logging later |

---

## 🔗 Quick Links

- **Preview URL:** https://id-preview--f04c6cfe-e2a8-41a5-974c-e82c2372539e.lovable.app
- **Production URL:** https://padeltrainer.ai
- **App URL:** https://app.padeltrainer.ai
- **Health Check:** `POST /functions/v1/health-check`
