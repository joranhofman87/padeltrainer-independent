
# Fix: Trainer Dashboard Not Showing Mollie Connection Status

## Problem

The `check-mollie-connect-status` edge function expects `{ entityType, entityId }` in the request body, but the trainer earnings page sends `{ type: 'trainer' }` -- wrong parameter name and missing trainer ID entirely. This causes the edge function to throw "Entity type and ID are required", which the frontend catches silently and defaults to `{ connected: false }`.

## Fix

### `src/pages/TrainerEarnings.tsx`

Change the `checkConnectStatus` function call from:

```typescript
body: { type: 'trainer' }
```

to:

```typescript
body: { entityType: 'trainer', entityId: trainerProfile.id }
```

This is a one-line fix. The trainer profile ID is already available in the component. Once fixed, the edge function will correctly look up the `trainer_mollie_accounts` record (which already has `charges_enabled: true` and `onboarding_complete: true` from the successful connection) and return the connected status.

### Admin Panel

The admin panel likely reads from the database directly. Let me note the admin check may be a separate issue -- but fixing the trainer dashboard status check is the primary fix needed here.

## Summary

| File | Change |
|------|--------|
| `src/pages/TrainerEarnings.tsx` | Fix request body: `{ type: 'trainer' }` to `{ entityType: 'trainer', entityId: trainerProfile.id }` |
