
# Fix: Mollie Callback Page Stuck Loading

## Problem

The trainer (`joranhofman87+trainermollie@gmail.com`) completed the Mollie OAuth flow and was redirected back to `https://app.padeltrainer.ai/api/mollie-callback`, but the page is stuck showing "Connecting your Mollie account..." indefinitely.

**Symptoms:**
- Page shows loading spinner with "Please wait while we complete the connection"
- No error is displayed
- Edge function logs show no calls to `mollie-callback`

## Root Cause

The `mollie-callback` edge function has **incomplete CORS headers**. The Supabase JavaScript client automatically sends additional headers that aren't listed in `Access-Control-Allow-Headers`:

**Current headers (line 6):**
```javascript
"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
```

**Missing headers sent by Supabase client:**
- `x-supabase-client-platform`
- `x-supabase-client-platform-version`
- `x-supabase-client-runtime`
- `x-supabase-client-runtime-version`

When the browser sends a preflight OPTIONS request, the edge function says "I don't allow those headers", so the browser blocks the actual POST request entirely. This causes the `supabase.functions.invoke()` call to hang silently.

## Solution

Update the CORS headers in the `mollie-callback` edge function to include all headers sent by the Supabase client.

## Technical Changes

### File: `supabase/functions/mollie-callback/index.ts`

**Update lines 4-6** - Expand the CORS headers:

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
```

## Immediate Workaround

For the stuck user right now:
1. The user should manually navigate to `/trainer/earnings`
2. Click "Connect Mollie" again to restart the OAuth flow
3. After publishing this fix, the callback will work correctly

## Summary

| File | Change |
|------|--------|
| `supabase/functions/mollie-callback/index.ts` | Add missing CORS headers for Supabase client compatibility |

## Expected Result

- Mollie OAuth callbacks will process successfully
- Users will see the success message and be redirected to `/trainer/earnings?mollie_connected=true`
- The edge function logs will show the callback being processed
