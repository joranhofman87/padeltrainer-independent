# PadelTrainer.ai Pre-Launch Checklist

**Last Updated:** 2026-02-03  
**Status:** Ready for Production

---

## ✅ Completed Items

### Code Quality
- [x] All Stripe references removed and replaced with Mollie
- [x] Translation files complete for EN and NL
- [x] **COMPLETE** No production console.error/warn statements (all migrated to logger)
  - Core libraries: 10 files migrated
  - Pages: 18 files migrated (final batch 2026-02-03)
  - Components: 22 files migrated
  - Hooks: 6 files migrated
- [x] Error boundaries implemented for graceful failure
- [x] SEO component added to all marketing pages
- [x] Structured data (JSON-LD) on key pages
- [x] data-testid attributes on critical UI elements
- [x] Image lazy loading implemented

### Security
- [x] RLS policies on all sensitive tables
- [x] Admin functions verify role server-side
- [x] Input validation on all edge functions
- [x] Rate limiting on contact forms (3 requests/hour)
- [x] HTML sanitization for user inputs
- [x] SECURITY DEFINER functions use `search_path = public`
- [x] Security scan findings reviewed and false positives documented

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
- [x] Sitemap edge function deployed
- [x] Static sitemap.xml generated
- [x] robots.txt configured for app/marketing domains
- [x] llms.txt for AI crawlers
- [x] Hreflang tags for EN/NL
- [x] Open Graph meta tags
- [x] Twitter cards
- [x] Structured data on 9+ pages

### E2E Tests
- [x] Authentication flows
- [x] Navigation
- [x] Booking flows
- [x] Role-based access
- [x] i18n language switching
- [x] Accessibility basics
- [x] Performance thresholds
- [x] Error handling

---

## ⚠️ Known Warnings (Acceptable)

| Issue | Reason | Risk Level |
|-------|--------|------------|
| profiles_public uses security_invoker=off | Intentional for public trainer profiles | Low |
| pg_net extension in public schema | Cannot be moved (Supabase limitation) | None |
| Leaked password protection disabled | Requires Supabase dashboard toggle | Low |

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

---

## 📊 Post-Launch Monitoring

- [ ] Set up Sentry/LogRocket integration (TODO in logger.ts)
- [ ] Monitor edge function logs daily for first week
- [ ] Track Core Web Vitals in Search Console
- [ ] Monitor payment success rates in Mollie dashboard
- [ ] Review user signup funnel analytics

---

## 📝 Technical Debt (Low Priority)

| Item | Location | Notes |
|------|----------|-------|
| Logger monitoring integration | `src/lib/logger.ts:68` | TODO: Integrate with Sentry |
| Slot picker for proposals | `src/components/cycles/ProposalCard.tsx` | Button disabled until feature is built |
| Plan placeholder values | `src/components/admin/PlanEditDialog.tsx` | Admin-only, cosmetic |
| TrainerDashboard refactoring | `src/pages/TrainerDashboard.tsx` | Components extracted but file still large |

---

## 🔗 Quick Links

- **Preview URL:** https://id-preview--f04c6cfe-e2a8-41a5-974c-e82c2372539e.lovable.app
- **Production URL:** https://padeltrainer.ai
- **App URL:** https://app.padeltrainer.ai
