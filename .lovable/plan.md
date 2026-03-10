

# Performance Analysis & Build Error Fixes

## Build Errors (7 TypeScript errors in edge functions)

These are blocking deployment. All are straightforward type fixes:

1. **mollie-subscription-webhook/index.ts:317** — `subscriptionPayload` typed as `Record<string, unknown>` but function expects a specific interface. Fix: type the variable with the correct interface directly instead of `Record<string, unknown>`.

2. **send-email/index.ts:949** — Dynamic property access `prefs?.[prefColumn]` where `prefColumn` is a string variable. Fix: cast or use type assertion.

3. **send-push-bulk/index.ts:83** and **send-push/index.ts:76** — `err` is `unknown` in catch block. Fix: `(err as Error).message`.

4. **track-banner-event/index.ts:90** — Union type indexing issue on `banner[column]`. Fix: type assertion on banner. Line 115: same `error` unknown issue. Fix: `(error as Error).message`.

5. **verify-mollie-payment/index.ts:178** — `string | undefined` not assignable to `string | null`. Fix: `trainerId = slotsData?.trainer_id ?? null`.

---

## Performance Issues Analysis

### Root Cause 1: No data caching — every page re-fetches on mount

The dashboards (`PlayerDashboard`, `TrainerDashboard`) and most pages use raw `useState` + `useEffect` + direct Supabase calls. This means:
- **Every navigation triggers fresh API calls** — going back to a page re-fetches everything
- **No stale-while-revalidate** — users see loading skeletons every time
- **No shared cache** — the same data (e.g., profile, bookings) is fetched independently by multiple components

TanStack Query (`useQuery`) is installed but only used in blog/admin pages. The main app pages don't use it at all.

### Root Cause 2: Auth waterfall on every route change

The network logs show duplicate requests on navigation: `user_roles`, `profiles`, `club_managers`, `academy_managers` are all re-fetched. The `useAuth` provider fetches user data correctly once, but layout components like `TrainerLayout` make additional Supabase calls (e.g., `getTrainerAcademy`) on every mount.

### Root Cause 3: Subscription polling every 60 seconds

`useAuth` polls `check-mollie-subscription` edge function every 60 seconds for trainers — this is an unnecessary overhead for a status that rarely changes.

### Root Cause 4: Dashboard data fetching pattern

`PlayerDashboard` has 4 separate `useEffect` + fetch calls (`fetchPlayerData`, `fetchFollowedTrainers`, `fetchPlayerClubs`, plus slots). `TrainerDashboard` has 3-4 similar cascading fetches. None are cached.

---

## Implementation Plan

### Phase 1: Fix build errors (immediate)
- Apply the 7 type fixes across 5 edge function files as described above

### Phase 2: Add TanStack Query to dashboard pages
Convert the main pages from `useState`/`useEffect` fetch patterns to `useQuery`:

- **PlayerDashboard**: Replace `fetchPlayerData`, `fetchFollowedTrainers`, `fetchPlayerClubs` with `useQuery` hooks using keys like `['player-bookings', profileId]`, `['player-followed-trainers', profileId]`
- **TrainerDashboard**: Same conversion for `fetchStats`, `fetchActivityData`
- This gives instant back-navigation (cached data shown immediately) and background revalidation

### Phase 3: Cache auth-adjacent data
- Move `getTrainerAcademy` check in `TrainerLayout` into a `useQuery` with `staleTime: 5 * 60 * 1000` so it doesn't re-fetch on every navigation
- Reduce subscription polling from 60s to 5 minutes (subscription status doesn't change that frequently)

### Phase 4: Optimize re-renders
- Add `staleTime` configuration to `QueryClient` defaults (e.g., `staleTime: 30_000`) so data isn't considered stale immediately
- Add `gcTime` (garbage collection time) to keep cached data in memory longer during session

### Files to modify:
- `src/App.tsx` — QueryClient default options
- `src/pages/PlayerDashboard.tsx` — convert to useQuery
- `src/pages/TrainerDashboard.tsx` — convert to useQuery
- `src/components/trainer/TrainerLayout.tsx` — useQuery for academy check
- `src/hooks/useAuth.tsx` — reduce subscription poll interval
- 5 edge function files for build error fixes

