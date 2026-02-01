
# Fix: Respect Manual Subscription Status Set by Admin

## Problem
Rene's trainer profile was manually set to `subscription_status = 'active'` via the admin panel. However, the trial expired banner still shows because:

1. The `check-trainer-subscription` edge function determines `isSubscribed` by querying **Stripe** for active subscriptions
2. Since Rene doesn't have an actual Stripe subscription, the function returns `subscribed: false`
3. The TrainerDashboard shows the trial banner when `subscription.isSubscribed` is `false`

**Database shows:**
- `subscription_status: active`
- `trial_ends_at: null`
- `is_public: true`

**But the edge function ignores `subscription_status` and only checks Stripe.**

## Solution
Update the `check-trainer-subscription` edge function to respect the database `subscription_status` field when no Stripe subscription exists. This allows admins to manually grant access.

### Logic Change
```text
1. Fetch trainer profile from database (already done)
2. Query Stripe for active subscription
3. If Stripe has active subscription → use Stripe data
4. ELSE IF database subscription_status = 'active' → mark as subscribed (admin override)
5. ELSE → use trial/default logic
```

## Files to Change

| File | Changes |
|------|---------|
| `supabase/functions/check-trainer-subscription/index.ts` | Add fallback check for database `subscription_status = 'active'` when no Stripe subscription found |

## Implementation Details

In the edge function, after checking Stripe subscriptions:

```typescript
const hasActiveSub = subscriptions.data.length > 0;
let productId: string | null = null;
let tier = 'trial';
let subscriptionEnd: string | null = null;

// NEW: Check for admin-granted subscription status
const hasAdminGrantedAccess = trainerProfile?.subscription_status === 'active';

if (hasActiveSub) {
  // Existing Stripe logic
  const subscription = subscriptions.data[0];
  subscriptionEnd = new Date(subscription.current_period_end * 1000).toISOString();
  productId = subscription.items.data[0].price.product as string;
  tier = await getTierFromDB(supabaseClient, productId);
} else if (hasAdminGrantedAccess) {
  // Admin manually set status to active - grant access without Stripe
  tier = 'professional'; // Default tier for admin-granted subscriptions
  logStep("Admin-granted subscription detected", { subscription_status: trainerProfile.subscription_status });
}

return new Response(JSON.stringify({
  subscribed: hasActiveSub || hasAdminGrantedAccess,  // ← Key change
  tier,
  // ... rest unchanged
}));
```

## Testing
After implementation:
1. Refresh Rene's dashboard
2. The trial expired banner should no longer appear
3. The subscription page should show "Current Plan: professional" (or similar)
