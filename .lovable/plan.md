

# E2E Tests & Error Logging: Go-Live Audit

## Current State Assessment

### What's already good
- **Error logging**: `logger.error()` is used across 153 files, sending errors to PostHog as `$exception` events
- **Error boundaries**: `FeatureErrorBoundary` wraps all critical pages (Auth, all Signups, BookLesson, CycleRegistration, BrandedCycleRegistration)
- **Slack notifications**: Covering signups, bookings, payments, profile publish, registration success/errors
- **E2E tests**: 12 spec files covering auth, booking, payments, error handling, navigation, i18n, roles, accessibility, performance

### Gaps Found

**1. No E2E test for the registration form (your most critical go-live flow)**
- `booking.spec.ts` only tests navigation to cycle pages, never fills/submits the form
- No test for the branded registration URL pattern (`/nl/academies/:slug/register/:cycleId`)
- No test for guest vs logged-in form variants

**2. Registration form error handling has no client-side validation test**
- `error-handling.spec.ts` tests login/signup validation but not the registration form

**3. Edge function errors are logged but not all alert to Slack**
- `submit-guest-intake` has Slack alerts (added recently)
- `send-email` failures log to console but don't trigger Slack
- `generate-invoice-pdf` errors don't alert to Slack

**4. No console error monitoring on the registration page**
- `error-handling.spec.ts` checks console errors on home and auth pages only

## Plan

### 1. New E2E test: `e2e/registration.spec.ts`

Test the branded registration flow end-to-end:
- Navigate to a real academy registration URL (`/nl/academies/rl-padel-performance/register/:cycleId`)
- Verify the form loads (cycle name, lesson type options, price visible)
- Verify group4 is pre-selected by default
- Fill the guest form fields (name, email, phone, rating)
- Submit and verify success state appears
- Test validation: submit without required fields, verify error messages
- Test console errors: no JS errors during the flow

### 2. Add console error check for registration page in `e2e/error-handling.spec.ts`

Add a test that navigates to the registration page and checks for zero console errors (same pattern as the existing home/auth page tests).

### 3. Add Slack alerts for `send-email` failures in `supabase/functions/send-email/index.ts`

When the email sending fails (Resend API error), fire a non-blocking Slack notification via `slack-notify` with event `edge_function_error` including the recipient, email type, and error message. This way you get alerted when confirmation emails fail.

### 4. Add test route to `e2e/fixtures/test-data.ts`

Add a `registration` route constant for the RL Performance registration page.

## Files
- `e2e/registration.spec.ts` — New: full registration form E2E test
- `e2e/error-handling.spec.ts` — Add console error check for registration page
- `e2e/fixtures/test-data.ts` — Add registration route
- `supabase/functions/send-email/index.ts` — Add Slack alert on email send failure

