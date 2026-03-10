

# Performance Audit Report — Launch Readiness

## Executive Summary

The homepage takes **~5 seconds to show any content** (First Contentful Paint: 4.99s). For non-technical users on slower connections, this will feel broken. There are 20 API calls on the homepage alone, several taking 1-2.5 seconds each. The entire i18n bundle (5 languages x 11 namespaces = 55 JSON files) loads eagerly on every page, even if the user only needs Dutch.

**Overall verdict: Not launch-ready for a consumer audience without the fixes below.**

---

## Critical Issues (Must Fix Before Launch)

### 1. First Contentful Paint: 5 seconds — users will bounce

**Measured:** FCP = 4,992ms, DOM Content Loaded = 4,823ms

**Root cause:** 250 resources load before anything paints. The critical render chain includes:
- React DOM (166KB)
- lucide-react (157KB) — the entire icon library
- react-router-dom (96KB)
- framer-motion (90KB)
- Supabase client (83KB)
- All 55 i18n JSON files (every language, every namespace)

**Fix:** 
- Lazy-load i18n — only load the active language on startup, load others on demand
- The `lucide-react` import is pulling the entire icon set (157KB). This is a Vite dev-mode artifact that resolves in production builds, but should be verified in the published build.

### 2. Duplicate API calls — every request fires twice

**Evidence from network log:** The locations endpoint fires **4 times** (937ms–2,550ms each). `academy_profiles_public`, `banner_placements`, `club_profiles`, and `trainer_profiles_safe` all fire **twice each**.

**Root cause:** `HomeFeaturedSections` and other home page sections use raw `useEffect` + direct Supabase calls. When React StrictMode double-mounts in dev, these fire twice. But more critically, `HomeFeaturedSections` calls `getActiveLocations()` AND the `Locations`-related components on the home page likely also call it independently.

**Fix:**
- Wrap `HomeFeaturedSections` data fetching in `useQuery` with proper query keys — TanStack Query deduplicates identical in-flight requests automatically
- The `getActiveLocations()` call fetches `SELECT *` on all locations (every column). The homepage only needs `id, name, city, slug, logo_url`. Selecting only needed columns reduces payload significantly.

### 3. Locations query is the slowest request (2.5 seconds)

`SELECT * FROM locations WHERE is_active = true` takes up to 2.5 seconds and returns all rows with all columns. This is the single biggest bottleneck.

**Fix:**
- Add a database index on `locations(is_active)` if not present
- For the homepage, select only the columns needed: `id, name, city, slug, logo_url`
- Consider a `locations_summary` view or materialized view for public-facing pages

### 4. i18n loads ALL 5 languages eagerly (55 JSON files in initial bundle)

Every user downloads Dutch, English, Spanish, German, AND French translation files on first load — even though they only need one language. This adds significant weight to the initial JS bundle.

**Fix:** Use dynamic `import()` for non-active languages. Load only the detected language on init, lazy-load others when the user switches via `LanguageSwitcher`.

---

## High Priority Issues

### 5. HomeFeaturedSections has a waterfall pattern

The data fetching in `HomeFeaturedSections` does:
1. First parallel batch: trainers, academies, locations, claimed IDs (1-2.5s)
2. Then sequentially: profiles + ratings for trainers (200ms each)
3. Then: club_profiles_public (200ms)

Steps 2-3 can't start until step 1 finishes. That's a 3+ second waterfall before the featured sections can render.

**Fix:** Flatten the waterfall — fetch profiles/ratings/club_profiles in the same initial `Promise.all` where possible, or use a database view that joins trainer + profile + rating data.

### 6. No loading skeleton for above-the-fold content

The `HeroSection` renders static content immediately (good), but `HomeFeaturedSections` shows a full skeleton until all data loads. Users scrolling down will see a loading state for 3+ seconds.

**Fix:** Already using skeletons, which is fine. But consider rendering featured sections with `Suspense` boundaries individually so trainers can appear before locations finish loading.

### 7. Auth provider runs on marketing pages unnecessarily

`MarketingLayout` calls `useAuth()` just to check if the user is logged in (for showing "Dashboard" vs "Sign in" buttons). This triggers the full auth initialization flow (Supabase `onAuthStateChange`) even for anonymous marketing visitors.

**Fix:** This is likely acceptable since `onAuthStateChange` fires once quickly for anonymous users. But ensure it doesn't block rendering — currently it doesn't since `loading` isn't used to gate marketing content.

---

## Medium Priority

### 8. 3,224 DOM nodes on homepage

This is borderline high (Google recommends <1,500). The featured sections render up to 24 cards with motion wrappers, each containing multiple nested elements.

### 9. No `loading="lazy"` on featured section images

Avatar images in the featured trainers/academies/locations sections load eagerly even though they're below the fold.

### 10. framer-motion on every card is expensive

Each featured card is wrapped in `<motion.div>` with `whileInView` animations. With 24 cards, that's 24 IntersectionObservers + animation calculations. Consider using CSS animations or `@starting-style` for simple fade-ins.

---

## Implementation Plan

### Phase 1: Eliminate duplicate requests (biggest quick win)
- Convert `HomeFeaturedSections` to use `useQuery` hooks instead of raw `useEffect`
- This alone will cut the 20 API calls roughly in half via deduplication
- Add narrow column selects for the homepage locations query

### Phase 2: Optimize the locations query
- Add database index on `locations(is_active)` via migration
- Create a lightweight query variant that selects only `id, name, city, slug, logo_url` for listing pages

### Phase 3: Lazy-load i18n
- Refactor `src/i18n/index.ts` to only load the detected language eagerly
- Load other languages on demand via `i18n.loadLanguages()` when the user switches

### Phase 4: Flatten the data waterfall
- Combine the sequential fetches in `HomeFeaturedSections` into a single parallel batch
- Consider a Supabase view that joins `trainer_profiles_safe` + `profiles_public` + ratings

### Phase 5: DOM/render optimizations
- Add `loading="lazy"` to below-fold images
- Replace `framer-motion` `whileInView` with CSS animations for cards
- Reduce DOM depth in featured card components

### Files to modify:
- `src/components/home/HomeFeaturedSections.tsx` — useQuery + narrow selects + flatten waterfall
- `src/i18n/index.ts` — lazy language loading
- `src/lib/locations.ts` — add lightweight query variant
- Database migration — index on `locations(is_active)`

