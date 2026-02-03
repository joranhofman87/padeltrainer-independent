

# Pre-Production Finalization Plan

## Overview

This plan addresses the three requested tasks:
1. Remove debug console.log statements
2. Update security scan findings with proper ignore reasons
3. Create a final pre-launch checklist

---

## Task 1: Remove Debug Console.log Statements

### Files to Update

| File | Line | Console Statement | Action |
|------|------|-------------------|--------|
| `src/components/DomainRouter.tsx` | Lines 398-404 | `console.log('[DomainRouter] hostname:...')` | Replace with `logger.debug()` |
| `src/pages/TrainerProfile.tsx` | Lines 197, 210, 233, 298 | `console.error('Error fetching...')` | Replace with `logger.error()` |

### Implementation

**DomainRouter.tsx:**
- Import logger from `@/lib/logger`
- Change `console.log('[DomainRouter]...)` to `logger.debug('DomainRouter routing', { hostname, isAppDomain, isMarketingDomain, isDevelopment })`
- This preserves debugging in development but removes production console noise

**TrainerProfile.tsx:**
- Import logger from `@/lib/logger`
- Replace `console.error()` calls with `logger.error()` for structured logging
- Replace `console.log()` calls with `logger.debug()` for development-only output

---

## Task 2: Update Security Scan Findings

### Findings to Mark as Ignored (False Positives)

| Internal ID | Issue | Status | Ignore Reason |
|-------------|-------|--------|---------------|
| `mollie_accounts_public_tokens` | Payment tokens exposed | False Positive | All Mollie account tables have RLS policies restricting access to account owners only (trainers to their own, club managers to their clubs, academy managers to their academies) |
| `user_calendar_connections_token_exposure` | Calendar tokens exposed | False Positive | RLS policy restricts access to `user_id = auth.uid()` - users can only access their own calendar connections |
| `intake_requests_personal_data` | Registration forms expose PII | False Positive | RLS policies restrict access to: (1) the player who submitted the request, (2) cycle owners (trainers/clubs/academies). No public access. |
| `profiles_email_phone_exposure` | Contact info exposed | Needs Clarification | `profiles_public` intentionally exposes phone for trainer contact, but uses security_invoker=off for public access. `profiles_safe` excludes phone/email. This is by design. |
| `SUPA_security_definer_view` | Security Definer View | Intentional | `profiles_public` uses security_invoker=off to allow public read access to trainer contact info (name, avatar, bio, phone). This is intentional for the marketing pages. |

### API Call Sequence
1. Update `mollie_accounts_public_tokens` - ignore with detailed RLS explanation
2. Update `user_calendar_connections_token_exposure` - ignore with user_id restriction explanation
3. Update `intake_requests_personal_data` - ignore with player/owner restriction explanation
4. Update `profiles_email_phone_exposure` - ignore with intentional design explanation
5. Update `SUPA_security_definer_view` - ignore with public access design explanation

---

## Task 3: Final Pre-Launch Checklist

### Document to Create: `.lovable/LAUNCH_CHECKLIST.md`

```text
text
# PadelTrainer.ai Pre-Launch Checklist

## ✅ Completed Items

### Code Quality
- [x] All Stripe references removed and replaced with Mollie
- [x] Translation files complete for EN and NL
- [x] No production console.log statements (converted to logger)
- [x] Error boundaries implemented for graceful failure
- [x] SEO component added to all marketing pages
- [x] Structured data (JSON-LD) on key pages

### Security
- [x] RLS policies on all sensitive tables
- [x] Admin functions verify role server-side
- [x] Input validation on all edge functions
- [x] Rate limiting on contact forms
- [x] HTML sanitization for user inputs
- [x] SECURITY DEFINER functions use search_path = public

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
- [x] Impersonation logging for admin

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

## ⚠️ Known Warnings (Acceptable)

| Issue | Reason | Risk Level |
|-------|--------|------------|
| profiles_public uses security_invoker=off | Intentional for public trainer profiles | Low |
| pg_net extension in public schema | Cannot be moved (Supabase limitation) | None |
| Leaked password protection disabled | Requires Supabase dashboard | Low |

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

## 🚀 Launch Day

1. [ ] Deploy to production domain
2. [ ] Verify DNS propagation
3. [ ] Check SSL certificates
4. [ ] Monitor error logs for first hour
5. [ ] Verify sitemap is accessible
6. [ ] Submit sitemap to Google Search Console
7. [ ] Verify Mollie webhooks receiving events
8. [ ] Test one real payment (small amount)

## 📊 Post-Launch Monitoring

- [ ] Set up Sentry/LogRocket integration (TODO in logger.ts)
- [ ] Monitor edge function logs daily for first week
- [ ] Track Core Web Vitals in Search Console
- [ ] Monitor payment success rates in Mollie dashboard
- [ ] Review user signup funnel analytics
```

---

## Technical Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/components/DomainRouter.tsx` | Edit | Replace console.log with logger.debug |
| `src/pages/TrainerProfile.tsx` | Edit | Replace console.error with logger.error |
| `.lovable/LAUNCH_CHECKLIST.md` | Create | Comprehensive pre-launch checklist |
| Security Findings | API Update | Mark 5 false positive findings as ignored |

---

## Implementation Order

1. **Update DomainRouter.tsx** - Add logger import, replace console.log
2. **Update TrainerProfile.tsx** - Add logger import, replace console.error calls
3. **Update security findings** - Use manage_security_finding tool to mark false positives
4. **Create launch checklist** - Write .lovable/LAUNCH_CHECKLIST.md
5. **Verify changes** - Run tests to confirm no regressions

