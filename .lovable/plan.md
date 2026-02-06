
# Fix: Existing Users Incorrectly Sent to Onboarding

## Problem

When an existing user (joranhofman87@gmail.com with `player` and `admin` roles) clicks "Sign in with Google" from the `/signup/player` page:

1. `localStorage.setItem('pendingRole', 'player')` is set **before** OAuth redirect
2. After OAuth returns to `/auth`, the `role` state in `useAuth` may briefly be `null` during the initial fetch
3. Auth.tsx sees `role === null`, finds `pendingRole` in localStorage, and redirects to `/onboarding/player`
4. User gets stuck on onboarding even though they already have roles in the database

## Root Cause

There's a race condition in the redirect logic. The code checks `if (role)` but doesn't distinguish between:
- `role === null` because we haven't fetched it yet
- `role === null` because the user genuinely has no roles

## Solution

**Option A (Preferred):** Check if the user has roles in the database directly before redirecting to onboarding. If they have roles, clear `pendingRole` and redirect to the appropriate dashboard.

**Option B:** Add a separate "rolesLoaded" state to `useAuth` that indicates whether role fetching has completed.

I recommend **Option A** because it's simpler and directly addresses the issue.

## Technical Changes

### File: `src/pages/Auth.tsx`

Update the redirect useEffect (lines 74-114) to verify the user doesn't already have roles before redirecting to onboarding:

```typescript
useEffect(() => {
  if (!loading && user) {
    const redirectUrl = sessionStorage.getItem('redirectAfterLogin');
    
    if (role) {
      // Existing user with role - clear any stale pendingRole and redirect
      localStorage.removeItem('pendingRole');
      
      if (redirectUrl) {
        sessionStorage.removeItem('redirectAfterLogin');
        navigate(redirectUrl);
      } else {
        // Priority: admin > trainer > club > player
        if (role === 'admin') {
          navigate('/admin');
        } else if (role === 'trainer') {
          navigate('/trainer');
        } else if (role === 'club') {
          navigate('/club');
        } else {
          navigate('/player');
        }
      }
    } else {
      // Role is null - could be new user OR roles haven't loaded yet
      // Double-check by querying the database directly
      const checkExistingRoles = async () => {
        const { data } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .limit(1);
        
        if (data && data.length > 0) {
          // User has roles in DB - this was a race condition
          // Clear pendingRole and refresh auth to get the correct role
          localStorage.removeItem('pendingRole');
          await refreshAuth();
        } else {
          // Genuinely new user - proceed with onboarding
          if (redirectUrl) {
            sessionStorage.removeItem('redirectAfterLogin');
          }
          
          const pendingRole = localStorage.getItem('pendingRole');
          if (pendingRole) {
            localStorage.removeItem('pendingRole');
            navigate(`/onboarding/${pendingRole}`);
          } else {
            navigate('/onboarding/player');
          }
        }
      };
      
      checkExistingRoles();
    }
  }
}, [user, role, loading, navigate]);
```

### Changes Summary

| File | Change |
|------|--------|
| `src/pages/Auth.tsx` | Add database check before redirecting to onboarding when `role === null` |

## Expected Result

- Existing users signing in via Google from signup pages will be correctly redirected to their dashboard
- New users will still be directed to onboarding as expected
- The `pendingRole` localStorage value will be cleared for existing users to prevent future issues
- Race conditions between auth state and role fetching are handled gracefully
