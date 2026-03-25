

# Performance Optimization: Reduce Page Load Times

## Problem
Pages take 5-10 seconds to load. The root causes are:

1. **Auth waterfall blocks rendering**: `useAuth` makes 4 parallel DB queries (roles, profile, club manager check, academy manager check) + a Stripe subscription edge function call — all while showing a loading skeleton. Edge function cold starts can add 2-5 seconds alone.
2. **No data caching between navigations**: Public pages (AcademyPublicProfile, TrainerProfile, etc.) use raw `useEffect` + `useState` instead of TanStack Query, so every navigation re-fetches everything from scratch.
3. **Subscription check blocks auth**: `fetchSubscription` calls an edge function on every page load for trainers — even on public pages where subscription status is irrelevant.
4. **Sequential data waterfalls**: AcademyPublicProfile first fetches the academy, THEN fetches trainers + locations — a classic waterfall.

## Changes

### 1. Defer subscription check out of auth loading (`src/hooks/useAuth.tsx`)
- Stop calling `fetchSubscription` inside the initial auth flow
- Set `loading = false` immediately after `fetchUserData` completes (roles + profile)
- Keep subscription fetch as a separate, non-blocking effect that updates `subscription` state after render
- This alone should cut 2-4 seconds off initial load for trainers

### 2. Migrate AcademyPublicProfile to TanStack Query (`src/pages/AcademyPublicProfile.tsx`)
- Replace `useEffect` + `useState` with `useQuery` for academy data, trainers, and locations
- Use `staleTime: 5 * 60 * 1000` so revisiting the page is instant
- Enable parallel fetching: use separate `useQuery` calls for trainers/locations that depend on `academy.id`, so they start as soon as academy data resolves
- This means navigating back to a previously visited profile is instant

### 3. Migrate TrainerProfile to TanStack Query (`src/pages/TrainerProfile.tsx`)
- Same pattern: replace `useEffect` data fetching with cached `useQuery` calls
- Trainer data, reviews, availability — all cached across navigations

### 4. Skip auth-related DB calls for anonymous users (`src/hooks/useAuth.tsx`)
- When `onAuthStateChange` fires with no session, immediately set `loading = false`
- Don't call `fetchUserData` (roles, profile, manager checks) for anonymous users — they have no data to fetch
- This speeds up all public page loads for non-logged-in visitors

### 5. Lazy-load subscription check only for trainer routes
- Move the `check-stripe-subscription` edge function call to the TrainerLayout component instead of the global auth provider
- Academy subscription is already handled separately in `AcademyLayout` via TanStack Query — good pattern to follow

## Impact
- **Anonymous visitors** (majority of traffic): Auth resolves instantly (no DB calls), page data loads via cached queries
- **Logged-in trainers**: Auth resolves after 4 fast DB queries (~200-500ms), subscription check happens in background after page renders
- **Return navigations**: Instant from TanStack Query cache

## Files
- `src/hooks/useAuth.tsx` — Defer subscription, skip calls for anon users
- `src/pages/AcademyPublicProfile.tsx` — Migrate to TanStack Query
- `src/pages/TrainerProfile.tsx` — Migrate to TanStack Query
- `src/components/trainer/TrainerLayout.tsx` — Move subscription check here

