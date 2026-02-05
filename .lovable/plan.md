
# Fix: Trainer Trial Status Not Being Recognized

## Problem

The trainer `joranhofman87+trainermollie@gmail.com` has an active trial (until Feb 12th) but sees the subscription paywall because:

1. The `check-mollie-subscription` edge function checks trial status for academies/clubs but **not for trainers**
2. The function returns `{ subscribed: false, status: "none" }` for trainers without a Mollie customer ID, even if they're in a trial
3. The frontend sets `isInTrial: data.status === 'trialing'`, but the backend never returns that status for trainers

## Solution

Add trainer trial checking logic to the edge function, matching the existing pattern for academies/clubs.

## Files to Modify

| File | Change |
|------|--------|
| `supabase/functions/check-mollie-subscription/index.ts` | Add trial period check for trainers |

## Technical Changes

### check-mollie-subscription Edge Function

Add trial_ends_at to the trainer query and check it before the "no Mollie customer" fallback:

```typescript
// In the trainer section, update the select to include trial_ends_at
.select("id, mollie_customer_id, subscription_status, subscription_tier, subscription_id, subscription_ends_at, trial_ends_at")

// After fetching trainer profile, check trial status (before the customerId check)
if (type === "trainer" && profile.trial_ends_at) {
  const trialEnd = new Date(profile.trial_ends_at);
  if (trialEnd > new Date()) {
    logStep("Trainer is in trial period");
    return new Response(
      JSON.stringify({
        subscribed: false,  // Not technically subscribed, but in trial
        status: "trialing",
        tier: "trial",
        trialEndsAt: profile.trial_ends_at,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
```

This ensures the frontend receives `status: "trialing"` and `trialEndsAt`, which correctly sets `isInTrial: true` and prevents the paywall overlay.
