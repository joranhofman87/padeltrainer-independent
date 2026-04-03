
# Fix live-site login failure on `padeltrainer.ai`

## What the issue is
This is now clearly a **live-site authentication CORS problem**, not just a slow-loading auth screen.

The key clue is the browser error:
```text
Access to fetch at .../auth/v1/token?grant_type=password
from origin https://padeltrainer.ai
has been blocked by CORS policy
```

That means the login request is being rejected **before** the app can even complete sign-in. So the role/profile logic is secondary here.

## Root cause
The published custom domain (`https://padeltrainer.ai`) is not being accepted correctly by the backend auth service for password-token requests.

There is also a secondary UX problem in the frontend:
- stale auth refresh attempts keep retrying
- auth bootstrap can linger while token refresh is failing
- some auth flows still don’t fail fast enough with a clear message

## Plan

### 1. Fix backend auth domain/origin configuration
Update the authentication configuration in Lovable Cloud so the live domain is explicitly allowed for auth requests.

What to verify/configure:
- published origin: `https://padeltrainer.ai`
- `https://www.padeltrainer.ai` too, if that domain is ever used
- valid auth redirect URLs for:
  - `/app/auth`
  - `/app/reset-password`

This is the primary fix for the live-site CORS error.

### 2. Harden auth bootstrap so it stops looping on broken sessions
In `src/hooks/useAuth.tsx`:
- fail fast when session restore / token refresh throws fetch errors
- clear stale local auth state immediately instead of letting refresh retries keep spinning
- avoid waiting on extra user-data work during auth restoration
- only fetch profile/roles after auth is confirmed usable

This prevents the “takes ages / keeps loading” behavior when a stored session is broken.

### 3. Make login failures explicit instead of looking stuck
In `src/lib/auth.ts` and `src/pages/Auth.tsx`:
- catch network/CORS auth failures and convert them into a clear login error
- stop any onboarding redirect logic from running after auth transport failures
- keep `setIsLoading(false)` guaranteed in every path
- show a user-facing message like “Login is temporarily unavailable on this domain” instead of a vague generic failure

### 4. Align the signup / Google auth flows with the same resilience
In:
- `src/pages/PlayerSignup.tsx`
- `src/pages/TrainerSignup.tsx`
- other signup pages using the same pattern

Apply the same hardening:
- `finally` for loading reset
- no silent hangs
- no follow-up onboarding routing after auth transport failure

For Google specifically, switch to the Lovable Cloud OAuth pattern instead of direct `supabase.auth.signInWithOAuth(...)`, since this project uses Lovable Cloud.

## Files involved
- `src/hooks/useAuth.tsx`
- `src/lib/auth.ts`
- `src/pages/Auth.tsx`
- `src/pages/PlayerSignup.tsx`
- `src/pages/TrainerSignup.tsx`
- other signup pages that reuse the same Google/email auth pattern

## No database change
No schema, table, or RLS change is needed for this fix.

## Expected result
After this:
- email/password login works on the live site
- stale/broken sessions no longer trap the app in long refresh loops
- existing users are not misrouted to onboarding after auth transport failures
- auth failures become immediate and understandable instead of looking frozen

## Technical note
The current code already improved role/profile failure handling, but this bug happens earlier in the chain:

```text
click Sign In
-> POST /auth/v1/token?grant_type=password
-> blocked by CORS on live origin
-> no valid session created
-> refresh/bootstrap logic keeps trying
-> user experiences long loading / failed login
```

So the implementation should prioritize:
1. backend auth origin fix
2. frontend stale-session recovery
3. clearer auth failure behavior
