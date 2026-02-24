

# Speed Up Browser Back Button Navigation

## Problem
When you press the browser's back button, the app feels slow or unresponsive. The in-app back button is fast because it only updates state, but the browser back button triggers heavier processing.

## Root Causes Found

1. **All 80+ pages are loaded upfront** -- Every single page in the app (admin, trainer, player, club, academy, marketing) is imported eagerly in `DomainRouter.tsx`. This means the initial bundle is massive and route transitions process more code than needed.

2. **ScrollToTop blocks rendering** -- `ScrollToTop` uses `useLayoutEffect`, which is synchronous and blocks the browser from painting until the scroll completes. On back navigation, this causes a visible freeze.

3. **No route-level code splitting** -- There's zero use of `React.lazy` anywhere in the app. Every page transition loads the full app bundle.

## Solution

### 1. Lazy-load all page components in `DomainRouter.tsx`
Convert all ~80 page imports from eager imports to `React.lazy()` with a shared `Suspense` wrapper. This means only the page you're navigating to gets loaded, and back/forward navigation is instant for already-loaded pages.

### 2. Fix ScrollToTop to use non-blocking `useEffect`
Change `useLayoutEffect` to `useEffect` so the scroll happens after paint rather than blocking it. This alone can eliminate the "frozen" feeling on back navigation.

### 3. Add a lightweight loading fallback
Wrap lazy routes in a `Suspense` boundary with a minimal skeleton/spinner so transitions feel instant even when a new page chunk hasn't loaded yet.

---

## Technical Details

### File: `src/components/ScrollToTop.tsx`
- Change `useLayoutEffect` to `useEffect` (1 line change)

### File: `src/components/DomainRouter.tsx`
- Convert all ~80 page imports to `React.lazy(() => import(...))` calls
- Wrap the `<Routes>` block in a `<Suspense fallback={...}>` component
- Layout components (`TrainerLayout`, `PlayerLayout`, `ClubLayout`, `AcademyLayout`, `AdminLayout`) stay eagerly loaded since they wrap multiple child routes

This is a significant change to the file but purely mechanical -- the route structure stays identical, only the import style changes.

### Expected Impact
- Browser back button becomes near-instant (no more blocked paint)
- Initial page load faster (smaller initial bundle)
- Each page loads its own small chunk on first visit, then is cached

