

# Fix: Auth Page Infinite Loading After Google OAuth

## Root Cause

When Google OAuth completes, the browser redirects back to `/auth#access_token=...&refresh_token=...`. Two things then fight over these tokens:

1. **Supabase's built-in handler** automatically detects the hash tokens and fires `onAuthStateChange` with `SIGNED_IN` -- this works correctly
2. **The magic link handler** in `Auth.tsx` (originally added for impersonation) ALSO detects the same hash tokens and calls `supabase.auth.setSession()` a second time

This second `setSession` call can fail (tokens already consumed), and because there's no `.catch()`, the `isProcessingMagicLink` state stays `true` forever. The spinner condition `if (loading || isProcessingMagicLink)` keeps showing the loading screen even after the 10-second safety timeout resolves `loading`.

## Changes

### `src/pages/Auth.tsx`

Two fixes to the magic link `useEffect` (lines 26-51):

1. **Skip OAuth callbacks**: Only process hash tokens that DON'T include a `provider_token` parameter (OAuth redirects always include this, magic links don't). This prevents the handler from interfering with Google OAuth.

2. **Add `.catch()` safety**: If `setSession` rejects for any reason, ensure `isProcessingMagicLink` is set to `false` so the page never hangs.

```typescript
useEffect(() => {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  const providerToken = hashParams.get('provider_token');

  // Only handle magic link tokens, NOT OAuth callbacks
  // OAuth callbacks include provider_token and are handled by Supabase automatically
  if (accessToken && refreshToken && !providerToken) {
    setIsProcessingMagicLink(true);
    supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    }).then(({ error }) => {
      if (error) {
        console.error('Failed to set session from magic link:', error);
        toast({ ... });
      }
      window.history.replaceState(null, '', window.location.pathname);
      setIsProcessingMagicLink(false);
    }).catch(() => {
      // Safety: ensure we never hang on magic link processing
      setIsProcessingMagicLink(false);
    });
  }
}, [toast, t]);
```

## Summary

| Item | Change |
|------|--------|
| `src/pages/Auth.tsx` | Skip magic link handler for OAuth callbacks (check for `provider_token`), add `.catch()` safety |

This is a one-file fix. After publishing, Google OAuth login should redirect properly to `/admin` (or the appropriate dashboard) instead of getting stuck on the loading spinner.

