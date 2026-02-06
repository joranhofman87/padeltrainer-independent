
# Fix: Stop Auto-Logout on AbortError

## Problem

After the auto-logout mechanism was added, users get stuck on the loading page at `/auth` when trying to sign in. The console shows `AbortError: signal is aborted without reason` errors.

**What's happening:**

1. User signs in via Google OAuth → tokens are received
2. `useAuth` processes the session and calls `fetchUserData()`  
3. During the parallel database queries, an `AbortError` occurs (this is normal - happens due to React's component lifecycle or fast navigation)
4. The `.catch()` block interprets this as a "corrupted session" and calls `signOut()`
5. User is immediately signed out after signing in
6. This creates an infinite loop where users can't stay logged in

**Why AbortError is normal:**
- React Strict Mode double-renders components in development, canceling the first render's network requests
- Fast navigation or page changes can abort in-flight requests
- This is NOT a sign of a corrupted session

## Solution

Modify the error handling in `useAuth.tsx` to distinguish between:
- **AbortError**: Ignore - this is a normal browser event, not an auth failure
- **Session errors**: Only sign out for actual token/session problems

## Technical Changes

### File: `src/hooks/useAuth.tsx`

**1. Update the `.catch()` block for `getSession()` (lines 205-209)**

Only sign out for actual session errors, not AbortError:

```typescript
}).catch(async (error) => {
  // AbortError is normal (React StrictMode, navigation) - don't treat as auth failure
  if (error?.name === 'AbortError') {
    logger.warn('Session retrieval aborted (normal)', { component: 'useAuth' });
    setLoading(false);
    return;
  }
  logger.error('Session retrieval error', error as Error, { component: 'useAuth' });
  await supabase.auth.signOut();
  setLoading(false);
});
```

**2. Update the `.then()` error handler (lines 189-196)**

Also check for AbortError in the explicit error case:

```typescript
supabase.auth.getSession().then(async ({ data: { session }, error }) => {
  // AbortError is normal - don't treat as auth failure
  if (error?.name === 'AbortError') {
    logger.warn('Session retrieval aborted (normal)', { component: 'useAuth' });
    setLoading(false);
    return;
  }
  // If there's an error getting the session, sign out to clear corrupted state
  if (error) {
    logger.warn('Failed to get session, signing out', { component: 'useAuth', error });
    await supabase.auth.signOut();
    setLoading(false);
    return;
  }
  // ... rest of the code
```

## Summary

| Location | Change |
|----------|--------|
| Lines 189-196 | Check for AbortError before signing out in `.then()` |
| Lines 205-209 | Check for AbortError before signing out in `.catch()` |

## Expected Result

- `AbortError` during session retrieval is treated as a normal event (logged as warning, not error)
- Users can sign in without being immediately signed out
- The auto-logout mechanism still works for actual token/session failures
- Loading states properly resolve
