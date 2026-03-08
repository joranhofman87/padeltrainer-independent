

# Pre-Launch Checklist: What's Left

## Security Status: GOOD
All 3 critical vulnerabilities from the last audit are **fixed**:
- Privilege escalation on `user_roles` — policy dropped
- Mollie token exposure — scoped to owners + admin
- PII on base tables — public policies removed, access via safe views

Remaining security scan findings are all **reviewed and accepted**:
- Leaked password protection disabled (platform limitation)
- `pg_net` in public schema (Supabase limitation)
- Security definer views (intentional for public data boundaries)
- `subscription_payments` / `notification_queue` with no policies (service-role-only by design)
- Invoices and bookings RLS properly scoped to owner (player sees own, trainer sees own)

**No security blockers remain.**

---

## What Still Needs Attention

### 1. Console.error migration (~505 calls in 50 components)
These errors are invisible in production. Three pages (`TrainersCity.tsx`, `AdminRatingSystems.tsx`, `AdminBlogEditor.tsx`) and ~50 components still use `console.error` instead of `logger.error`. This means production bugs in these components won't surface in your monitoring.

**Recommendation:** Migrate in batches. Prioritize user-facing components (booking, payment, signup-related) first. Admin-only components are lower risk.

### 2. Stale secret: STRIPE_SECRET_KEY
You migrated from Stripe to Mollie, but the `STRIPE_SECRET_KEY` secret is still configured. It's harmless but should be cleaned up to avoid confusion.

### 3. Manual testing from the launch checklist
Per your `.lovable/LAUNCH_CHECKLIST.md`, these manual verifications are still unchecked:

**Payment Testing:**
- Test Mollie payment with test card
- Verify webhook receives payment confirmation
- Test subscription creation and cancellation
- Test trainer payout flow

**User Flows:**
- Trainer signup → onboarding → first lesson
- Player signup → book lesson → receive confirmation
- Club signup → onboarding → add trainer
- Academy signup → create cycle → receive applications

**Mobile Verification:**
- All pages on iPhone Safari and Android Chrome
- Touch targets 44px minimum
- Calendar drag-and-drop on mobile

**Email Delivery:**
- Welcome emails sent and received
- Booking confirmation emails
- Password reset emails
- Spam folder delivery rates

### 4. Post-launch monitoring setup
Your `logger.ts` has a TODO for Sentry/LogRocket integration. Without it, the `logger.error` calls go nowhere in production beyond the browser console.

---

## Verdict

**The app is production-ready from a security and architecture standpoint.** The critical fixes are deployed. What remains is:

| Item | Priority | Effort |
|------|----------|--------|
| Manual payment + user flow testing | Must do | 2-3 hours |
| Mobile testing | Must do | 1-2 hours |
| Email delivery verification | Must do | 30 min |
| Console.error → logger.error migration | Should do | Can batch over time |
| Remove stale Stripe secret | Nice to have | 1 min |
| Monitoring integration (Sentry) | Should do post-launch | 1-2 hours |

**Bottom line: You're ready to go live once you complete the manual testing in the launch checklist. No more code changes are blocking launch.**

