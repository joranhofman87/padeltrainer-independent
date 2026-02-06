

# Fix: Mollie Connect Callback Architecture

## Problem

The current Mollie Connect OAuth flow is correct in concept but has a broken callback architecture. The authorization code expires after **30 seconds** (per Mollie docs), yet:

1. Mollie redirects to a React page (`/api/mollie-callback`)
2. The React page loads, then tries to forward the code to the backend via `supabase.functions.invoke()`
3. This browser-to-backend call silently fails (confirmed: zero logs reach the edge function from real attempts)
4. The code expires unused, the page hangs forever

## Solution

Route the Mollie callback **directly to the backend function** (server-to-server), then redirect the browser to the React app with the result. This is the standard pattern for OAuth callbacks.

```text
CURRENT (broken):
  Mollie --> React app (browser) --> supabase.functions.invoke --> Mollie API
                                     ^^ silently fails

FIXED:
  Mollie --> Backend function --> Mollie API (token exchange, server-to-server)
         --> HTTP 302 redirect --> React app (shows result)
```

## Changes

### 1. `supabase/functions/mollie-connect-trainer/index.ts`

Change the `redirect_uri` from the React app to the backend function directly:

```
// Before
const redirectUri = `${origin}/api/mollie-callback`;

// After
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const redirectUri = `${supabaseUrl}/functions/v1/mollie-callback`;
```

### 2. `supabase/functions/mollie-connect-academy/index.ts`

Same redirect URI change as the trainer function.

### 3. `supabase/functions/mollie-callback/index.ts`

Refactor to handle a direct GET redirect from Mollie (instead of a POST with JSON body from the React app):

- Parse `code`, `state`, `error` from URL query parameters (GET request) instead of JSON body
- Update the `redirect_uri` used in token exchange to match the new direct URL
- After processing, return an HTTP 302 redirect to the React app with the result as query parameters:
  - Success: `https://app.padeltrainer.ai/api/mollie-callback?status=success&name=OrgName`
  - Error: `https://app.padeltrainer.ai/api/mollie-callback?status=error&message=Something+went+wrong`

### 4. `src/pages/MollieCallback.tsx`

Simplify to only read the connection result from URL parameters -- no more `supabase.functions.invoke()` call:

- If `status=success` in URL params: show success message, redirect to earnings page
- If `status=error` in URL params: show error message with retry button
- If `code` is present (direct Mollie redirect that somehow reaches the React app): show a generic error
- Remove the `AbortController` timeout and invoke logic entirely

## After Publishing

You will need to register the new redirect URI in the **Mollie Dashboard** (App Settings > Redirect URIs):

```
https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/mollie-callback
```

The old React app URI can remain registered as a fallback but is no longer used.

## Summary

| File | Change |
|------|--------|
| `mollie-connect-trainer/index.ts` | Point `redirect_uri` to the backend function URL |
| `mollie-connect-academy/index.ts` | Same redirect URI change |
| `mollie-callback/index.ts` | Handle GET params instead of JSON body; HTTP 302 redirect to React app after processing |
| `MollieCallback.tsx` | Read result from URL params only; remove invoke/timeout logic |

