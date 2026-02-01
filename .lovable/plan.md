
# Fix Magic Link Impersonation - Explicit Token Exchange

## Problem Analysis
The magic link impersonation flow is failing because:

1. When an admin clicks "Login as User", the edge function generates a magic link URL pointing to Supabase's auth server
2. Supabase verifies the token and redirects to `/auth#access_token=...&refresh_token=...&type=bearer`
3. The current code calls `getSession()` which reads from localStorage (the admin's old session), not from the URL hash
4. The Supabase client's auto-detection isn't triggering because the page loads with an existing session in localStorage

## Root Cause
The current implementation assumes `getSession()` will process URL hash tokens, but it doesn't. The Supabase client's `detectSessionInUrl` feature works by detecting the hash and triggering an internal token exchange, but this can conflict with existing sessions in localStorage.

## Solution
Explicitly extract tokens from the URL hash and call `supabase.auth.setSession()` to override any existing session. This is the recommended approach from Supabase documentation for handling magic links in SPAs.

### Changes to Auth.tsx

Replace the current passive token detection with active token extraction and session setting:

```typescript
useEffect(() => {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  
  if (accessToken && refreshToken) {
    setIsProcessingMagicLink(true);
    // Explicitly set the session with tokens from URL hash
    supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    }).then(({ data, error }) => {
      if (error) {
        console.error('Failed to set session from magic link:', error);
        toast({
          title: 'Login failed',
          description: 'The login link may have expired. Please try again.',
          variant: 'destructive',
        });
      }
      // Clear the hash from URL for cleaner UX
      window.history.replaceState(null, '', window.location.pathname);
      setIsProcessingMagicLink(false);
    });
  }
}, []);
```

## Technical Details

| Step | Current Behavior | Fixed Behavior |
|------|-----------------|----------------|
| URL Hash Detection | Calls `getSession()` which reads localStorage | Parses hash for `access_token` and `refresh_token` |
| Session Setting | Relies on implicit auto-detection | Explicitly calls `setSession()` with tokens |
| Error Handling | None | Shows toast if session setting fails |
| Session Override | May not override existing localStorage session | Explicitly sets new session, overriding any existing |

## Files to Change

| File | Changes |
|------|---------|
| `src/pages/Auth.tsx` | Update magic link detection useEffect to explicitly extract tokens and call `setSession()` instead of just `getSession()` |

## Flow After Fix

```text
1. Admin clicks "Login as User"
2. Edge function generates magic link → opens in new tab
3. Supabase auth server verifies token → redirects to /auth#access_token=...
4. Auth.tsx detects hash tokens → calls setSession() with extracted tokens
5. New session established → onAuthStateChange fires → user redirected to dashboard
6. URL hash cleared for clean UX
```

## Alternative Approaches Considered

1. **Enable `detectSessionInUrl` explicitly** - Already enabled by default, issue is with existing sessions
2. **Use PKCE flow instead of magic link** - More complex, requires code exchange
3. **Sign out before processing magic link** - Could work but poor UX if something fails

The explicit `setSession()` approach is cleanest and matches Supabase's recommended pattern for React Native and other SPAs.
