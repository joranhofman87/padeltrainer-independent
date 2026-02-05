

# Add Auto-Logout on Invalid Session Token

## Problem

When a user's refresh token becomes invalid (expired, revoked, or corrupted), the application gets stuck in an infinite loading state because:
1. `getSession()` may return a stale session object from localStorage
2. Subsequent API calls fail silently or the session can't be refreshed
3. The loading state never resolves, leaving users stuck

## Solution

Add error handling in the `useAuth` hook to detect invalid session errors and automatically sign out the user, clearing the corrupted session and redirecting to login.

## Technical Changes

### File: `src/hooks/useAuth.tsx`

**1. Handle TOKEN_REFRESHED failures in onAuthStateChange**

The `onAuthStateChange` listener receives a `TOKEN_REFRESH_FAILED` event when refresh fails. We need to catch this and sign out:

```typescript
// Inside onAuthStateChange callback (around line 142)
if (event === 'TOKEN_REFRESHED' && !session) {
  // Token refresh failed - sign out to clear invalid session
  logger.warn('Token refresh failed, signing out', { component: 'useAuth' });
  await supabase.auth.signOut();
  return;
}
```

**2. Add error handling to getSession()**

Wrap the `getSession()` call to catch errors and handle invalid sessions:

```typescript
// Replace the getSession call (lines 182-190)
supabase.auth.getSession().then(async ({ data: { session }, error }) => {
  // If there's an error getting the session, sign out to clear corrupted state
  if (error) {
    logger.warn('Failed to get session, signing out', { component: 'useAuth', error });
    await supabase.auth.signOut();
    setLoading(false);
    return;
  }
  
  setSession(session);
  setUser(session?.user ?? null);
  
  if (session?.user) {
    await fetchUserData(session.user.id);
  }
  setLoading(false);
}).catch(async (error) => {
  logger.error('Session retrieval error', error, { component: 'useAuth' });
  await supabase.auth.signOut();
  setLoading(false);
});
```

**3. Add periodic session validation**

Add a check that validates the session periodically and signs out if invalid:

```typescript
// Add new useEffect after line 211
useEffect(() => {
  // Periodically validate session is still valid (every 5 minutes)
  const interval = setInterval(async () => {
    if (!session) return;
    
    const { error } = await supabase.auth.getUser();
    if (error?.message?.includes('Invalid Refresh Token') || 
        error?.message?.includes('Refresh Token Not Found')) {
      logger.warn('Invalid session detected, signing out', { component: 'useAuth' });
      await supabase.auth.signOut();
    }
  }, 300000); // 5 minutes

  return () => clearInterval(interval);
}, [session]);
```

## Summary of Changes

| Location | Change |
|----------|--------|
| Line ~142 | Handle `TOKEN_REFRESHED` event with null session |
| Lines 182-190 | Add error handling to `getSession()` |
| After line 211 | Add periodic session validation |

## Expected Result

- Invalid/expired sessions are automatically detected
- User is signed out and session is cleared from localStorage
- User can then log in fresh without manual localStorage clearing
- Loading states will properly resolve even with invalid sessions

