

# Fix Admin-Granted Subscription Not Being Recognized

## Problem
When an admin manually sets a trainer's `subscription_status` to `active`, the trainer dashboard still shows "Trial ended" with a CTA to subscribe.

**Root cause confirmed from logs:**
```
[CHECK-TRAINER-SUBSCRIPTION] User authenticated - {"email":"joranhofman87+rene@gmail.com"}
[CHECK-TRAINER-SUBSCRIPTION] No customer found, returning trial tier
```

The edge function checks for a Stripe customer first, and if none is found, it returns `subscribed: false` **before** ever checking for admin-granted access.

## Current Logic Flow (Buggy)

```text
1. Authenticate user ✓
2. Fetch trainer profile (gets subscription_status = 'active') ✓
3. Look for Stripe customer → NOT FOUND
4. Return { subscribed: false } ← BUG: Exits before checking admin override!
```

## Fixed Logic Flow

```text
1. Authenticate user
2. Fetch trainer profile (gets subscription_status = 'active')
3. Check for admin-granted access FIRST → hasAdminGrantedAccess = true
4. Look for Stripe customer → NOT FOUND
5. Return { subscribed: true } because admin granted access
```

## File to Change

| File | Change |
|------|--------|
| `supabase/functions/check-trainer-subscription/index.ts` | Move admin-granted check before the "no customer" early return |

## Implementation Details

In the edge function, the current problematic block is:

```typescript
// Lines 85-99 - Early return WITHOUT checking admin override
if (customers.data.length === 0) {
  logStep("No customer found, returning trial tier");
  return new Response(JSON.stringify({ 
    subscribed: false,  // ← Always returns false, ignoring admin override
    tier: 'trial',
    // ...
  }));
}
```

**Fix:** Check for admin-granted access BEFORE the early return:

```typescript
// Check for admin-granted subscription status FIRST
const hasAdminGrantedAccess = trainerProfile?.subscription_status === 'active';

if (customers.data.length === 0) {
  // Even without Stripe, respect admin-granted access
  if (hasAdminGrantedAccess) {
    logStep("No Stripe customer, but admin-granted access detected");
    return new Response(JSON.stringify({ 
      subscribed: true,
      tier: 'professional',
      product_id: null,
      subscription_end: null,
      trial_ends_at: trialEndsAt,
      is_trial: false,
      is_public: isPublic,
    }), { ... });
  }
  
  logStep("No customer found, returning trial tier");
  return new Response(JSON.stringify({ 
    subscribed: false,
    // ...
  }));
}
```

## Expected Result After Fix

**For Rene (admin-granted subscription):**

| Before | After |
|--------|-------|
| `subscribed: false` | `subscribed: true` |
| `tier: 'trial'` | `tier: 'professional'` |
| Shows "Trial ended" banner | No trial banner |

