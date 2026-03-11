

## Performance Improvements for Academy Pages

### Root Cause Analysis

The screenshot shows `ERR_INSUFFICIENT_RESOURCES` — the browser ran out of network connections. This happens because the academy pages fire a **cascade of sequential and parallel Supabase requests** on every mount, none of which use TanStack Query caching. Here's what fires when an academy manager opens the dashboard:

1. **AcademyLayout mount**: `getUserAcademyProfiles` → then `checkAcademySubscription` (edge function call)
2. **useAuth**: `fetchUserData` (4 parallel queries) + `fetchSubscription` (edge function)
3. **AcademyDashboard mount**: Two separate `useEffect`s both fire on `activeAcademy` change:
   - `fetchStats`: 3 queries (trainers, locations, view stats — view stats itself is 2 queries)
   - `fetchActivityData`: 5+ sequential queries (academy_trainers, bookings, guest_players, registered bookings, slots, intake_requests)
4. **UnpaidBookingsCard**: Another `useEffect` fetch on mount

That's **15+ Supabase requests** on a single page load, with zero caching. If the user tabs away and back, or navigates between academy pages, all of these re-fire because they use raw `useEffect` + `useState` instead of TanStack Query.

### Non-Breaking Changes

#### 1. Migrate AcademyDashboard fetches to TanStack Query (biggest win)

Convert the two `useEffect` + `setState` patterns in `AcademyDashboard.tsx` to `useQuery` with appropriate `staleTime`. This gives:
- **Deduplication**: Same data won't be fetched twice
- **Caching**: Navigating away and back uses cached data
- **No re-fetch on re-mount**: Data stays fresh for the configured window

Set `staleTime: 5 * 60 * 1000` for stats and activity data — this is dashboard data that doesn't need to be real-time.

#### 2. Migrate AcademyLayout subscription check to TanStack Query

Currently `checkAcademySubscription` is called via `useEffect` + `setInterval`. Convert to `useQuery` with `staleTime: 5 * 60 * 1000` and `refetchInterval: 5 * 60 * 1000`. This prevents duplicate calls when the component re-renders.

#### 3. Consolidate AcademyDashboard's two useEffects into one query

Currently there are two separate `useEffect`s both triggered by `activeAcademy` — `fetchStats` and `fetchActivityData`. Merge them into a single `useQuery` call that runs one function doing all fetches in parallel where possible, reducing waterfall.

#### 4. Batch the sequential queries in fetchActivityData

Currently `fetchActivityData` does: fetch trainer IDs → then 4 sequential queries using those IDs → then 1 more query. Restructure to run the 4 dependent queries in a single `Promise.all` after getting trainer IDs.

#### 5. Migrate UnpaidBookingsCard to TanStack Query

Same pattern — convert `useEffect` fetch to `useQuery` with `staleTime: 2 * 60 * 1000`.

#### 6. Increase global default staleTime

The current global `staleTime: 30_000` (30s) is quite aggressive. For a management app, `60_000` (1 min) is more appropriate and reduces unnecessary refetches.

### Files to Edit

1. **`src/pages/academy/AcademyDashboard.tsx`** — Replace `useEffect` + `useState` with `useQuery` for stats and activity data; merge into fewer queries; parallelize dependent fetches
2. **`src/components/academy/AcademyLayout.tsx`** — Replace subscription `useEffect` + `setInterval` with `useQuery` + `refetchInterval`
3. **`src/components/trainer/UnpaidBookingsCard.tsx`** — Replace `useEffect` fetch with `useQuery`
4. **`src/App.tsx`** — Increase default `staleTime` from 30s to 60s

### Impact

- Reduces initial academy dashboard load from ~15 requests to ~8 (via parallelization and dedup)
- Eliminates redundant refetches on navigation (TanStack Query cache)
- Prevents `ERR_INSUFFICIENT_RESOURCES` crashes caused by request storms
- All changes are purely internal refactors — no UI or behavior changes

