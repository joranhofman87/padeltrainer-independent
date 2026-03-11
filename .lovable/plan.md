

## Mobile Performance & UX Optimization

After profiling on mobile (375x812) and reviewing the codebase, here are the findings and fixes:

### Current Mobile State
- **FCP: 5.4s** — still too slow for mobile users
- **153 resources loaded** on homepage — many are render-blocking
- **2,915 DOM nodes** — reasonable but could be lower
- Skeleton loading works well on trainers page
- Footer and navigation look clean on mobile
- Horizontal scroll carousels work for featured sections

---

### Issues Found & Fixes

**1. Dead CSS file (`src/App.css`) — Legacy cleanup**
This file contains Vite boilerplate CSS (`#root { max-width: 1280px; padding: 2rem }`) that constrains the layout and is completely unused. Removing it eliminates a wasted download and prevents any accidental style conflicts.

**2. Reditus affiliate script is render-blocking**
The inline `<script>` in `index.html` (line 16) loads synchronously before the app renders. It should be deferred or loaded after first paint.

**Fix:** Move the Reditus script to load after the app is interactive, similar to how PostHog is handled — via `requestIdleCallback` in `main.tsx` or a dedicated component.

**3. Mobile touch targets too small**
The mobile hamburger menu button uses `p-2` (8px padding), making it ~40px — below the recommended 48px minimum. Footer links and filter chips have the same issue.

**Fix:** Add `min-h-[48px] min-w-[48px]` to interactive mobile elements (hamburger, filter buttons, footer links).

**4. No `overscroll-behavior` on scroll containers**
Horizontal scroll carousels (featured trainers, academies, locations) can accidentally trigger browser back-navigation on iOS/Android. Adding `overscroll-behavior-x: contain` prevents this.

**Fix:** Add a global utility class and apply to all `overflow-x-auto` containers.

**5. Mobile menu lacks `AnimatePresence` for exit animation**
The mobile menu in `MarketingLayout.tsx` uses conditional rendering with `motion.div` but no `AnimatePresence`, so the exit animation never plays — the menu just disappears instantly.

**Fix:** Wrap the mobile menu in `AnimatePresence`.

**6. Trainers page still uses `useEffect`/`useState` (not migrated to `useQuery`)**
The previous plan included migrating `Trainers.tsx` to `useQuery`, but it's still using manual `useEffect` + `useState`. This means every back-navigation re-fetches all trainer data from scratch, which is especially painful on mobile networks.

**Fix:** Migrate the data fetching in `Trainers.tsx` to `useQuery` with a 5-minute `staleTime`.

**7. Homepage loads all sections eagerly on mobile**
12 homepage section components all use `whileInView` animations but are imported eagerly. On mobile, sections below the fold should be lazy-loaded to reduce initial JS parsing.

**Fix:** Lazy-load below-fold homepage sections with `React.lazy` + `Suspense`.

---

### Files to Edit
- `src/App.css` — **delete entirely** (dead boilerplate)
- `index.html` — remove inline Reditus script
- `src/main.tsx` — add deferred Reditus initialization
- `src/components/marketing/MarketingLayout.tsx` — fix touch targets, add `AnimatePresence`
- `src/index.css` — add `overscroll-behavior-x: contain` utility
- `src/components/home/HomeFeaturedSections.tsx` — add `overscroll-behavior-x: contain` to scroll containers
- `src/components/featured/FeaturedSection.tsx` — add `overscroll-behavior-x: contain`
- `src/pages/Trainers.tsx` — migrate to `useQuery`

### Impact
- **Faster mobile FCP:** Removing render-blocking Reditus script and dead CSS
- **Better UX:** Proper touch targets, no accidental swipe-back, smooth menu exit
- **Instant back-nav:** `useQuery` caching eliminates re-fetches on the trainers page
- **Lower initial JS:** Lazy-loaded homepage sections reduce parse time on mobile

