
# Fix Impersonation Magic Link Flow

## Problem Analysis
When an admin clicks "Login as User", the system generates a magic link that opens in a new tab. Currently:

1. The magic link URL contains auth tokens in the URL fragment (hash)
2. When the new tab loads `/auth`, the Supabase client needs to detect and exchange these tokens
3. The Auth page shows the login form instead of processing the magic link tokens
4. This creates a loop where the user sees the login form but can't actually log in as the impersonated user

## Root Cause
The Supabase client should automatically detect tokens in the URL hash via its default `detectSessionInUrl` option. However, there's a race condition:
- The `useAuth` hook calls `getSession()` which might return the existing session from localStorage
- The URL hash tokens aren't being processed because the auth state listener isn't triggering a fresh token exchange

## Solution
Add explicit URL hash token detection in the Auth page component. When the page loads with a magic link hash fragment, we need to explicitly trigger a session refresh to ensure the Supabase client processes the URL tokens.

### Changes to Auth.tsx

Add a useEffect that:
1. Detects if the URL contains an `access_token` hash fragment (magic link callback)
2. Forces a session refresh by calling `supabase.auth.getSession()` which will detect and exchange the tokens
3. Shows a loading state while the token exchange happens

```typescript
// Detect and handle magic link tokens in URL hash
useEffect(() => {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = hashParams.get('access_token');
  
  if (accessToken) {
    // Magic link detected - Supabase will automatically exchange this
    // Force a session refresh to trigger the auth state change
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        // Clear the hash from URL for cleaner UX
        window.history.replaceState(null, '', window.location.pathname);
      }
    });
  }
}, []);
```

## Files to Change

| File | Changes |
|------|---------|
| `src/pages/Auth.tsx` | Add useEffect to detect and process magic link hash tokens, import supabase client |

## Alternative Approach (if above doesn't work)
If the implicit flow doesn't work reliably, we could switch the impersonation to use PKCE flow by:
1. Changing the edge function to use `type: 'magiclink'` with PKCE
2. Using `supabase.auth.exchangeCodeForSession()` on the callback page

## Technical Notes
- The fix preserves existing login/signup functionality
- Magic links are already handled by Supabase's auth system - we just need to ensure the token exchange triggers properly
- The loading state prevents showing the login form during token processing
