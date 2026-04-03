
## Fix: Live-site login is still blocked by backend CORS, not the auth page

### Do I know what the issue is?
Yes.

### What the problem actually is
The screenshot confirms the real blocker is still this request:

```text
POST https://ppkbhdiiqdusdeatgdft.supabase.co/auth/v1/token?grant_type=password
Origin: https://padeltrainer.ai
Blocked by CORS: No 'Access-Control-Allow-Origin' header
```

So the login is failing before the app can complete sign-in.

### What I confirmed in the code
- `src/lib/supabaseClient.ts` sends auth requests directly to the backend URL, so browser CORS rules apply to the page origin.
- `src/lib/domains.ts` builds auth redirects from `window.location.origin`, so when users are on `https://padeltrainer.ai`, all auth-related flows stay on that domain.
- `src/hooks/useAuth.tsx` and `src/pages/Auth.tsx` are already defensive about bad sessions and failed lookups, but they cannot fix a browser-level CORS rejection.
- The `v2.js` “reading 'q'” error is from the Reditus script loaded in `src/main.tsx`. It is noisy, but it is not the root cause of the login failure.

## Plan

### 1. Fix backend auth origin / redirect configuration
Update Lovable Cloud auth settings so the backend explicitly accepts:
- `https://padeltrainer.ai`
- `https://www.padeltrainer.ai` if that domain is used
- the published fallback domain if needed: `https://padeltrainer.lovable.app`

Also verify auth redirect URLs include:
- `/app/auth`
- `/app/reset-password`

This is the primary fix. Without it, email/password login from `padeltrainer.ai` will keep failing regardless of frontend changes.

### 2. Stop spending more time patching the login page as the main fix
The current frontend code is already catching failures more safely than before. Further edits to:
- `src/pages/Auth.tsx`
- `src/hooks/useAuth.tsx`
- `src/lib/auth.ts`

will improve messaging, but will not solve the blocked request itself.

So implementation priority should be:
1. backend auth configuration
2. then only minimal frontend cleanup if needed

### 3. Add one small frontend improvement after backend config
After the backend CORS fix, make one small UX hardening pass:
- keep the existing loading reset behavior
- show a clearer “login unavailable on this domain” message when a network/CORS failure is detected
- avoid retry loops on broken restored sessions

This is a polish step, not the root fix.

### 4. Optionally silence the unrelated Reditus script noise
In `src/main.tsx`, make the Reditus loader more defensive or skip it on auth routes so the external `v2.js` error does not confuse debugging.

This is optional and separate from login itself.

## Files involved
Primary fix:
- backend auth configuration in Lovable Cloud

Secondary optional cleanup:
- `src/lib/auth.ts`
- `src/pages/Auth.tsx`
- `src/hooks/useAuth.tsx`
- `src/main.tsx`

## Expected result
After this:
- email/password login works on `https://padeltrainer.ai`
- users are no longer blocked by browser CORS before auth starts
- any remaining auth errors become normal app errors instead of hard transport failures
- console noise from Reditus can be reduced separately

## Technical details
Why this is the real issue:

```text
padeltrainer.ai page
  -> browser calls backend /auth/v1/token directly
  -> backend does not allow origin https://padeltrainer.ai
  -> browser blocks response
  -> app only sees Failed to fetch
```

Key conclusion:
- this is now primarily an auth-origin configuration problem
- not a schedule-state issue
- not a role-fetch issue
- not something the current Auth page alone can solve
