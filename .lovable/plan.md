

# Rewrite Auth Flow - Clean Slate

## Problems Identified

After analyzing the full auth codebase, here are the root causes of the issues you're experiencing:

### 1. Race condition between `onAuthStateChange` and `getSession` (infinite loading)
The `useAuth` hook sets up `onAuthStateChange` first, then calls `getSession()`. Both paths set state (`setSession`, `setUser`, `setLoading`). When a stale/corrupted session exists in localStorage, `getSession()` may error out and trigger `signOut()`, but `onAuthStateChange` fires simultaneously with stale data, creating a loop where loading never resolves cleanly -- or resolves and then flips back.

### 2. Auth page redirect loop (need to clear site data)
When a user with an existing role visits `/auth`, the redirect logic (lines 80-137 of Auth.tsx) fires on every `[user, role, loading]` change. If `role` is null momentarily (while `fetchUserData` is in progress), it calls `checkExistingRoles()` which calls `refreshAuth()`, which updates `role`, which re-triggers the effect, potentially creating a cycle. The `refreshAuth` in the dependency array makes this worse.

### 3. Player signup broken
The `signUpWithEmail` function calls the `signup-user` edge function which creates users via Admin API. The function returns `{ success, user }` but **never returns a session** (by design -- email verification required). The PlayerSignup page then falls into the `else` branch and shows the verification screen. However, if the user already exists in a stale local session, the `useAuth` effect (lines 35-44 of PlayerSignup.tsx) immediately redirects away before the form is even shown.

### 4. Stale localStorage `pendingRole` causes misdirects
The `pendingRole` key persists across browser sessions in `localStorage`. If a previous signup attempt set `pendingRole = 'player'` but never completed, the next login (even for an existing trainer) may briefly hit the code path that checks `pendingRole` and redirect to onboarding.

## Solution: Simplify and De-duplicate

### File 1: `src/hooks/useAuth.tsx` - Simplified initialization

**Changes:**
- Remove the dual `onAuthStateChange` + `getSession` pattern that races. Use only `onAuthStateChange` for state updates (Supabase fires `INITIAL_SESSION` on first load, which replaces the need for `getSession`)
- Remove the 10-second safety timeout (symptom fix for the real bug)
- Remove the 5-minute session validation interval (unnecessary -- Supabase auto-refreshes tokens and fires `TOKEN_REFRESHED` events)
- Keep `fetchUserData` await pattern (this is correct)
- Keep subscription fetch logic unchanged

### File 2: `src/pages/Auth.tsx` - Fix redirect logic

**Changes:**
- Remove `refreshAuth` from the redirect effect's dependency array to prevent re-trigger loops
- Gate the `checkExistingRoles` call with a flag so it only runs once per mount
- Clear `pendingRole` immediately when an existing user with roles signs in

### File 3: `src/pages/PlayerSignup.tsx` - Guard against stale sessions

**Changes:**
- Only redirect logged-in users if they already have a role. If no role, don't auto-redirect to onboarding (let the form render)
- This prevents stale sessions from blocking the signup form

### File 4: `src/pages/TrainerSignup.tsx` - Same fix as PlayerSignup

**Changes:**
- Same guard: only redirect if user has a role

## Technical Details

### useAuth.tsx rewrite (core fix)

```text
Key change: Replace getSession().then(...) with reliance on
onAuthStateChange INITIAL_SESSION event.

Before:
  1. onAuthStateChange listener set up
  2. getSession() called separately
  3. Both update same state -> race condition

After:
  1. onAuthStateChange listener set up (handles INITIAL_SESSION automatically)
  2. No separate getSession() call
  3. Single source of truth for session state
```

Supabase JS v2 fires `INITIAL_SESSION` as the first event from `onAuthStateChange`, which contains the same data as `getSession()`. This eliminates the race entirely.

### Auth.tsx redirect fix

```text
Before:
  useEffect depends on [user, role, loading, navigate, refreshAuth]
  -> refreshAuth changes role -> effect re-fires -> potential loop

After:
  useEffect depends on [user, role, loading, navigate]
  -> checkExistingRoles uses a ref flag to run only once
  -> refreshAuth called inside but not in dependency array
```

### Signup pages fix

```text
Before:
  if (!loading && user) {
    if (role) redirect to dashboard
    else redirect to onboarding  // <-- blocks form for stale sessions
  }

After:
  if (!loading && user && role) {
    redirect to dashboard  // only redirect if fully authenticated with role
  }
  // No redirect for user-without-role -- let form render
```

## Summary

| File | Change |
|------|--------|
| `src/hooks/useAuth.tsx` | Remove `getSession()` race; rely on `INITIAL_SESSION` event. Remove safety timeout and 5-min validation interval. |
| `src/pages/Auth.tsx` | Remove `refreshAuth` from deps; add once-only flag for role check; clear `pendingRole` on existing user login. |
| `src/pages/PlayerSignup.tsx` | Only redirect if user has a role; don't redirect to onboarding for stale sessions. |
| `src/pages/TrainerSignup.tsx` | Same fix as PlayerSignup. |

