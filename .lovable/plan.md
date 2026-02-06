

# Auth Simplification: Remove Accumulated Complexity

## Current Situation

Your app used to have two domains (`app.padeltrainer.ai` and `padeltrainer.ai`), but you've since consolidated to a **single domain** with path-based routing (`/app/*` for authenticated pages, `/:lang/*` for marketing). However, the auth code still carries baggage from the two-domain era, plus multiple incremental fixes that have piled up.

## Problems Found

### 1. `useAuth` has no safety net -- `loading` can stay `true` forever
The `loading` state starts as `true` and only becomes `false` inside `onAuthStateChange`. If the callback never fires, or if `fetchUserData` hangs (network issue, Supabase connection pool), the entire app is stuck on skeleton loaders permanently. This is the "nothing loads on refresh" issue you're seeing.

### 2. `BookingSuccess` requires auth to verify a payment
When returning from Mollie's external checkout, the browser reloads the app from scratch. The auth session may not restore in time (or at all if tokens expired). The page redirects to `/auth` (line 27-29), losing the `booking_id`. Even if auth restores, the verify call depends on `user` being truthy.

### 3. Redundant auth guards everywhere
Every layout (`TrainerLayout`, `PlayerLayout`, `ClubLayout`, `AcademyLayout`, `AdminLayout`) independently checks `!user` and redirects to `/app/auth`. This duplicated logic creates inconsistency and makes debugging harder.

### 4. `BookingSuccess` navigates to wrong routes
The "View My Bookings" button navigates to `/bookings` (line 135) which doesn't exist -- it should be `/app/player/bookings`.

## Proposed Changes

### A. Add a safety timeout to `useAuth` (prevents infinite loading)

Add a 10-second timeout that forces `loading = false` if auth hasn't initialized. Also fix the `TOKEN_REFRESHED` early return that skips `setLoading(false)`. Wrap `fetchUserData` in a 5-second `Promise.race` so a hanging database query can't block the whole app.

**File: `src/hooks/useAuth.tsx`**

### B. Make `BookingSuccess` auth-independent (fixes payment verification)

The webhook already marks bookings as `paid` in the database. The page should:
- Check the `bookings` table directly (no auth needed for reading with proper RLS or using the edge function without auth)
- Poll every 2 seconds for up to 30 seconds
- Fall back to calling `verify-mollie-payment` 
- Never redirect to `/auth`
- Fix the broken navigation links

**File: `src/pages/BookingSuccess.tsx`**

### C. No other changes needed right now

The rest of the auth architecture is actually sound:
- Single `onAuthStateChange` listener (good)
- `Auth.tsx` role-check logic with `hasCheckedRoles` ref (good)
- OAuth vs magic link separation (good)
- Single-domain routing (good)

The layout auth guards are duplicated but they work fine and aren't causing the current issues. Consolidating them would be a nice-to-have but isn't urgent.

## Technical Details

### `useAuth.tsx` changes:

```typescript
// 1. Safety timeout in the main useEffect
const safetyTimeout = setTimeout(() => {
  setLoading((current) => {
    if (current) {
      logger.warn('Auth safety timeout - forcing loading=false', { component: 'useAuth' });
    }
    return false;
  });
}, 10_000);

// 2. Fix TOKEN_REFRESHED early return
if (event === 'TOKEN_REFRESHED' && !session) {
  logger.warn('Token refresh failed, signing out', { component: 'useAuth' });
  setLoading(false); // ADD THIS
  await supabase.auth.signOut();
  return;
}

// 3. Wrap fetchUserData with deadline
if (session?.user) {
  await Promise.race([
    fetchUserData(session.user.id),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}

// 4. Cleanup
return () => {
  clearTimeout(safetyTimeout);
  authSubscription.unsubscribe();
};
```

### `BookingSuccess.tsx` changes:

- Remove `useAuth` dependency entirely
- On mount, query `bookings` table by ID for `payment_status`
- If `paid`, show success immediately
- If not, poll every 2s up to 15 times
- If still not paid, call `verify-mollie-payment` as fallback (without auth header)
- Fix button navigation to `/app/player/bookings`

## Files to Change

1. **`src/hooks/useAuth.tsx`** -- safety timeout, fetchUserData deadline, TOKEN_REFRESHED fix
2. **`src/pages/BookingSuccess.tsx`** -- remove auth dependency, database-first polling, fix navigation links

