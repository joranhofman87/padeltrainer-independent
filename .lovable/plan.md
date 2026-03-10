

## Performance Analysis & Optimization Plan

### Findings

The performance profile reveals several issues causing slow page loads:

**First Contentful Paint: 5.7 seconds** -- far above the recommended 1.8s threshold.

1. **Layout components are eagerly imported** (lines 7-11 of `DomainRouter.tsx`). TrainerLayout, PlayerLayout, ClubLayout, AcademyLayout, and AdminLayout are all loaded synchronously on every page load, even though they contain heavy dependencies (sidebar components, subscription checks, academy queries). This defeats the purpose of lazy-loading the page components inside them.

2. **Duplicate API calls on every page load.** The network logs show `user_roles`, `profiles`, `club_managers`, `academy_managers` are each called **twice**. This happens because `onAuthStateChange` fires both `INITIAL_SESSION` and `SIGNED_IN` events back-to-back, and `fetchUserData` runs for each event without deduplication.

3. **Redundant admin role check.** `AdminLayout` uses a `useIsAdmin()` hook that makes a separate database query for `user_roles`, but `useAuth` already fetches and exposes roles. This adds an unnecessary network round-trip.

4. **PostHog JS (63KB) blocks on the critical path** with 590ms load time.

### Plan

#### 1. Lazy-load all layout components
Change `DomainRouter.tsx` lines 7-11 from eager imports to `lazy()`:
```tsx
const TrainerLayout = lazy(() => import('@/components/trainer/TrainerLayout'));
const PlayerLayout = lazy(() => import('@/components/player/PlayerLayout'));
// etc.
```
This is the single biggest win -- it prevents loading trainer/academy/club code for users who don't visit those sections.

#### 2. Deduplicate auth data fetching
In `useAuth.tsx`, skip `fetchUserData` on `SIGNED_IN` if we already fetched for the same user during `INITIAL_SESSION`. Add a `lastFetchedUserId` ref:
```tsx
const lastFetchedRef = useRef<string | null>(null);
// Inside onAuthStateChange:
if (session?.user && lastFetchedRef.current !== session.user.id) {
  lastFetchedRef.current = session.user.id;
  await fetchUserData(session.user.id);
}
```
This eliminates the duplicate `user_roles`, `profiles`, `club_managers`, `academy_managers` calls.

#### 3. Remove redundant admin check
Update `AdminLayout` to use the `roles` array from `useAuth()` instead of the separate `useIsAdmin()` query:
```tsx
const { user, roles, loading } = useAuth();
const isAdmin = roles.includes('admin');
```
Removes one unnecessary network request.

#### 4. Defer PostHog loading
Move PostHog initialization behind `requestIdleCallback` or a small `setTimeout` so it doesn't compete with critical rendering resources.

### Risk Assessment
- Lazy-loading layouts: **Low risk** -- they're already wrapped in a `<Suspense>` boundary in `DomainRouter`. Users see the spinner briefly while the layout chunk loads (typically < 200ms on subsequent visits due to caching).
- Auth deduplication: **Low risk** -- the ref-based guard is a standard pattern and the safety timeout already handles edge cases.
- Admin check removal: **No risk** -- it's purely redundant with existing data.

