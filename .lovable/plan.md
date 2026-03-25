

# Slack Notifications for Registration + Error Monitoring

## Current State
- Slack notifications exist for signups, bookings, payments, profile publish, etc. — but **not** for cycle registration form submissions.
- The registration form has two flows: **guest** (via `submit-guest-intake` edge function) and **logged-in** (via `submitIntakeRequest` in `CycleApplicationForm.tsx`).
- E2E tests for cycle registration exist but are minimal (just navigation check, no form submission test).
- Error logging uses `logger.error()` in the catch block but no Slack alert on failure.

## Changes

### 1. Slack notification on successful registration (`CycleApplicationForm.tsx`)

After `setIsSuccess(true)` (line 384), add a non-blocking Slack notification for the **logged-in** flow:
```typescript
supabase.functions.invoke('slack-notify', {
  body: {
    event: 'new_registration',
    data: {
      name: values.full_name,
      email: values.email,
      cycle: cycle.name,
      lesson_types: values.lesson_types.join(', '),
      flow: 'logged_in',
    },
  },
}).catch(() => {});
```

### 2. Slack notification on successful guest registration (`submit-guest-intake/index.ts`)

Before the success response (line ~422), add:
```typescript
await supabaseAdmin.functions.invoke('slack-notify', {
  body: {
    event: 'new_registration',
    data: { name: fullName, email, cycle: cycleName, flow: 'guest' },
  },
}).catch(() => {});
```
This requires fetching the cycle name (already available in the function context — need to verify).

### 3. Slack notification on form errors (`CycleApplicationForm.tsx`)

In the catch block (line 387-389), add a non-blocking Slack alert:
```typescript
supabase.functions.invoke('slack-notify', {
  body: {
    event: 'registration_error',
    data: {
      cycle: cycle.name,
      error: error?.message || 'Unknown error',
      flow: isGuest ? 'guest' : 'logged_in',
    },
  },
}).catch(() => {});
```

### 4. Add event types to `slack-notify/index.ts`

Add to `EVENT_CONFIG`:
```typescript
new_registration: { emoji: "📝", title: "New Cycle Registration" },
registration_error: { emoji: "⚠️", title: "Registration Form Error" },
```

### 5. Slack notification when guest signs up after registration

Already covered — the existing `new_signup` Slack notification in `submit-guest-intake/index.ts` (line ~252) fires when a new account is created during guest intake. No changes needed here.

## E2E Tests & Error Logging Status

**Current coverage:**
- E2E test exists in `e2e/booking.spec.ts` but only tests navigation to the registration page, not form submission
- `logger.error()` is used in the catch block of `CycleApplicationForm`
- `FeatureErrorBoundary` wraps the registration page

**Recommended additions (optional, can be a follow-up):**
- Add an E2E test that fills and submits the registration form on a test cycle
- Add edge function error logging in `submit-guest-intake` catch block via Slack (registration_error event)

## Files
- `src/components/cycles/CycleApplicationForm.tsx` — Add Slack notifications on success + error
- `supabase/functions/submit-guest-intake/index.ts` — Add Slack notification on guest registration success + error
- `supabase/functions/slack-notify/index.ts` — Add new event types

