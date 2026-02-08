

# Fix: Admin "Login as User" Impersonation

## Problem
When an admin clicks "Login as User", the magic link is generated and opens in a new tab, but the new tab shares the same browser session. The Auth.tsx page detects the admin is already logged in (via the existing session) and immediately redirects to `/app/admin` before the magic link tokens in the URL hash can be processed by `setSession`.

## Root Cause
In Auth.tsx, there's a race between:
1. The redirect effect that checks `user` and `role` and immediately navigates to `/app/admin`
2. The magic link processing effect that calls `supabase.auth.setSession()` with the tokens from the URL hash

The redirect fires first because the admin's existing session is already available, so the user never gets impersonated.

## Solution

Two changes are needed:

### 1. Edge function: update redirect path (line 90-92)
Change the redirect from `/auth` to `/app/auth` to skip the unnecessary legacy redirect hop:
```
const redirectUrl = `${origin}/app/auth`;
```

### 2. Auth.tsx: skip auto-redirect when magic link tokens are present
In the redirect effect (the `useEffect` that checks `user` and `role`), add a guard that skips the redirect if the URL hash contains `access_token` (meaning a magic link is being processed). This gives the `setSession` call time to replace the admin session with the target user's session.

The magic link processing effect already sets `isProcessingMagicLink = true`, but the redirect effect doesn't check this flag. The fix adds `isProcessingMagicLink` to the redirect guard so it waits for magic link processing to complete before deciding where to navigate.

## Technical Details

### Modified: `supabase/functions/impersonate-user/index.ts`
- Line 90-92: Simplify redirect URL to always use `/app/auth`

### Modified: `src/pages/Auth.tsx`
- In the redirect effect (line 83-134): add `isProcessingMagicLink` to the early-return condition so the redirect doesn't fire while the magic link session is being established
- This means: if `isProcessingMagicLink` is true, don't redirect -- wait for the session swap to finish, then the auth state will update with the impersonated user's role and redirect correctly

