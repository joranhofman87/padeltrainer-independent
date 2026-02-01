
# Fix: Pages Not Opening at Top of Viewport

## Problem
When navigating to `/nl/academies` or `/nl/locations` (and likely other marketing pages), the page does not scroll to the top. This is a common issue in Single Page Applications (SPAs) where React Router handles navigation client-side without triggering a full page reload.

## Root Cause
The project uses `react-router-dom` for navigation, but there's no scroll restoration logic implemented. By default, React Router preserves the scroll position between route changes, which means if a user scrolls down on one page and then navigates to another, they'll still be scrolled down on the new page.

## Solution
Create a `ScrollToTop` component that listens for route changes and scrolls the window to the top on each navigation. This component will be placed inside the `BrowserRouter` in `App.tsx`.

---

## Implementation Steps

### Step 1: Create ScrollToTop Component
Create a new file `src/components/ScrollToTop.tsx` with a simple component that:
- Uses `useLocation` from react-router-dom to detect route changes
- Uses `useLayoutEffect` to scroll to top before the browser paints (prevents visual flicker)
- Scrolls the window to position (0, 0) on every pathname change

### Step 2: Add ScrollToTop to App.tsx
Integrate the `ScrollToTop` component inside the `BrowserRouter` wrapper in `src/App.tsx`, ensuring it runs on every route change across both marketing and app routes.

---

## Technical Details

**New File: `src/components/ScrollToTop.tsx`**
```tsx
import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
```

**Modified File: `src/App.tsx`**
Add the `ScrollToTop` component inside `BrowserRouter`:
```tsx
import { ScrollToTop } from '@/components/ScrollToTop';

// Inside App component, after <BrowserRouter>:
<BrowserRouter>
  <ScrollToTop />
  <AuthProvider>
    ...
  </AuthProvider>
</BrowserRouter>
```

---

## Why This Approach?

1. **useLayoutEffect vs useEffect**: Using `useLayoutEffect` ensures the scroll happens synchronously before the browser repaints, preventing any visual "jump" that could occur if we used `useEffect`.

2. **Global placement**: Placing the component directly under `BrowserRouter` ensures it catches all route changes, regardless of whether they're marketing pages, app pages, or admin pages.

3. **Minimal footprint**: The component returns `null` and has no visual impact - it purely handles the scroll behavior.

## Files Changed
| File | Action |
|------|--------|
| `src/components/ScrollToTop.tsx` | Create new |
| `src/App.tsx` | Add import and component |
