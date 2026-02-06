

# Fix: Mollie Callback Still Hanging

## Problem

The CORS header fix was applied to `mollie-callback/index.ts` earlier, but the user is still stuck. The edge function logs show **zero calls** to `mollie-callback`, confirming the browser is still blocking the request.

Two issues need to be addressed:

1. **Deploy the edge function** -- the CORS fix in the code needs to be deployed so it takes effect
2. **Add error resilience to the callback page** -- even with the CORS fix, the page should never hang indefinitely

## Changes

### 1. Deploy `mollie-callback` edge function

Force a redeployment so the updated CORS headers are live.

### 2. `src/pages/MollieCallback.tsx` -- Add timeout and better error handling

Add a safety timeout so the page never hangs forever:

- Add a 15-second timeout around the `supabase.functions.invoke()` call
- If it times out, show the error state with a helpful message instead of spinning forever
- Wrap the invoke in a try/catch that properly catches network/CORS errors

```typescript
// Add timeout wrapper around the invoke call
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15000);

try {
  const { data, error } = await supabase.functions.invoke('mollie-callback', {
    body: { code, state, error: oauthError, error_description: errorDescription },
  });
  clearTimeout(timeout);
  // ... handle response
} catch (err) {
  clearTimeout(timeout);
  setStatus('error');
  setErrorMessage(
    err instanceof DOMException && err.name === 'AbortError'
      ? 'The connection timed out. Please try again.'
      : err instanceof Error ? err.message : 'An unexpected error occurred'
  );
}
```

## Summary

| Item | Change |
|------|--------|
| Edge function deployment | Redeploy `mollie-callback` with the CORS fix |
| `src/pages/MollieCallback.tsx` | Add 15-second timeout so the page never hangs indefinitely |

## After Publishing

The trainer should:
1. Navigate to `/trainer/earnings`
2. Click "Connect Mollie" again to restart the flow
3. The callback should now complete successfully (or show an error within 15 seconds if something else is wrong)

