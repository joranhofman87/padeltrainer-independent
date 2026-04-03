
## Problem
This is not just a slow login. There are two linked issues:

1. The auth session is getting into a bad state and refresh calls start failing (`Failed to fetch` on the auth token refresh request).
2. After that, the app treats an existing account as a brand new user because role/profile lookups fail and return “no role”.

That explains both symptoms you saw:
- long loading / stuck auth flow
- then being sent into player onboarding as if you had just signed up

## What I found
From the current code and logs:

- `useAuth` sets `user/session`, then immediately fetches roles/profile/club-manager/academy-manager data.
- Those helper functions mostly swallow errors and return empty values (`[]`, `null`, `false`).
- In `Auth.tsx`, if `user` exists but `role` is still null, it runs a one-time `user_roles` check.
- If that check returns no data, it navigates to `/app/onboarding/player`.

So a temporary auth/session failure currently looks identical to “this user has no role yet”.

There is also an auth initialization risk:
- `useAuth` bootstraps with `getSession()`
- then subscribes to `onAuthStateChange`
- and it awaits extra async work inside the auth flow

That matches the known race pattern where auth-dependent queries run before the session is truly ready.

## Fix
### 1. Make auth initialization deterministic
In `src/hooks/useAuth.tsx`:
- subscribe to auth changes first
- bootstrap session separately
- introduce an explicit auth-ready state
- avoid awaiting app data fetches inside the auth listener
- only run role/profile queries after auth is confirmed ready and a user exists

This separates:
- “is there a signed-in user?”
from
- “have we loaded their app profile data yet?”

### 2. Stop treating fetch failures as “new user”
In `src/pages/Auth.tsx`:
- change the `role === null` branch so it does **not** route to onboarding when the role lookup failed due to auth/network issues
- only send users to onboarding when we positively know there are no roles
- if role/profile fetch fails, show a toast and keep the user on auth (or retry auth refresh), instead of assuming signup flow

### 3. Make role/profile helpers return failure state, not silent empties
In:
- `src/lib/auth.ts`
- `src/lib/club.ts`
- `src/lib/academy.ts`

Update the helpers used by `useAuth` so auth/network errors can be distinguished from true “no data” cases.

Right now:
- auth error -> `[]` / `null` / `false`
- real no-role user -> also `[]` / `null` / `false`

That is the core reason existing users get misclassified.

### 4. Recover from broken/stale stored sessions
In `src/hooks/useAuth.tsx`:
- detect refresh/session fetch failures
- clear invalid local auth state by signing out locally
- avoid leaving the app half-authenticated with `user` set but unusable token state

This should eliminate the long “takes ages” behavior caused by repeated failing refresh attempts.

### 5. Harden loading-state behavior on auth screens
In `src/pages/Auth.tsx`:
- wrap sign-in flow in `try/catch/finally`
- ensure `setIsLoading(false)` always runs
- keep analytics/non-essential side effects from affecting auth outcome

## Files
- `src/hooks/useAuth.tsx`
- `src/pages/Auth.tsx`
- `src/lib/auth.ts`
- `src/lib/club.ts`
- `src/lib/academy.ts`

## Expected result
After this change:
- existing users will no longer be redirected into player onboarding when auth/profile fetches glitch
- login will fail cleanly or recover cleanly, instead of hanging for a long time
- the app will only route to onboarding when it has confirmed the user is truly new
- stale local sessions will be cleared instead of poisoning future logins

## Technical details
Main design adjustment:

```text
auth session ready
  -> user exists?
      -> yes: fetch app user data
          -> success with role: go to dashboard
          -> success with no role: go to onboarding
          -> fetch/auth failure: stay in auth flow and recover/retry
      -> no: stay logged out
```

Key rule:
- “role is null” must no longer mean “new player”
- it must first distinguish:
  - no role exists
  - role lookup failed
  - auth token/session is broken
