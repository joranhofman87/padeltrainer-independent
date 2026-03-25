

# Fix Registration Page Load Speed

## Problem
Two issues cause slow loading:

1. **Auth blocks the page** — The page shows a skeleton while `authLoading` is true. Console logs confirm the 5-second safety timeout is being triggered for anonymous users, meaning `onAuthStateChange` isn't firing quickly enough. The auth listener waits for Supabase to check for a stored session before emitting `INITIAL_SESSION`, which can take seconds on cold loads.

2. **Sequential data fetching** — The page makes ~6 DB calls in series (owner → cycle → location → trainers → locations → applied check), each waiting for the previous one.

## Changes

### 1. `src/pages/BrandedCycleRegistration.tsx` — Don't block on auth

The registration page is a public page. It should **not** wait for `authLoading` before rendering content. Only the "has applied" check and the form variant (guest vs logged-in) depend on auth.

- Remove `authLoading` from the loading skeleton guard (line ~167)
- Start fetching cycle/owner data immediately, regardless of auth state
- Split the `useEffect` into two: one for public data (owner, cycle, location, trainers, locations) that runs immediately, and one for auth-dependent data (hasApplied check) that runs when `user` changes
- Parallelize the public data fetches where possible (owner + cycle can be fetched in parallel)

### 2. `src/pages/BrandedCycleRegistration.tsx` — Parallelize fetches

Current waterfall:
```text
owner → cycle → location → trainers → locations → applied
```

Improved:
```text
[owner + cycle] in parallel → [location + trainers + locations] in parallel → applied (only if logged in)
```

Use `Promise.all` for independent calls.

## Files
- `src/pages/BrandedCycleRegistration.tsx` — Remove auth blocking, parallelize data fetching

