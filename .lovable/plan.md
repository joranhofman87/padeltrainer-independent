

# Fix Trainer Profile Visibility Toggle

## Problem

The visibility toggle appears to work but doesn't stick because of a state management bug in the subscription/auth flow:

1. **`check-mollie-subscription` edge function** doesn't return the `is_public` field from the database
2. **`useAuth.tsx`** hardcodes `isPublic` based on subscription status (`data.subscribed || data.status === 'trialing'`) instead of the actual DB value
3. **`TrainerSettings.tsx`** syncs its local toggle state from `subscription.isPublic`, so every 60-second subscription refresh overwrites whatever the user toggled

The admin panel update likely succeeds at the DB level, but the trainer dashboard never reflects it because of this same loop.

## Fix

### 1. Edge Function: `supabase/functions/check-mollie-subscription/index.ts`

Include `is_public` in the SELECT query and in every response payload for trainers:

```text
Before (line 47):
  .select("id, mollie_customer_id, subscription_status, ...")

After:
  .select("id, mollie_customer_id, subscription_status, ..., is_public")
```

Add `isPublic: profile.is_public ?? false` to each JSON response for the trainer type.

### 2. Auth Hook: `src/hooks/useAuth.tsx`

Change line 114 from:

```typescript
isPublic: data.subscribed || data.status === 'trialing',
```

to:

```typescript
isPublic: data.isPublic ?? false,
```

This makes the auth context reflect the actual database value instead of a computed guess.

### 3. TrainerSettings.tsx - No changes needed

The settings page already reads from `subscription.isPublic` and updates via direct DB call. Once the above two fixes are in place, the data flow becomes correct:

```text
Toggle ON --> DB update (is_public = true) --> refreshSubscription()
--> edge function returns is_public: true --> useAuth sets isPublic: true
--> TrainerSettings syncs from subscription.isPublic --> UI shows ON
```

## Summary

| File | Change |
|------|--------|
| `supabase/functions/check-mollie-subscription/index.ts` | Add `is_public` to SELECT and include in all trainer responses |
| `src/hooks/useAuth.tsx` | Read `isPublic` from API response instead of computing from subscription status |

