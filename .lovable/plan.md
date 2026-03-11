

## Performance Improvements & Legacy Cleanup

### Findings

After a thorough codebase analysis, here are the remaining performance issues and legacy artifacts:

---

### 1. N+1 Query in TrainersCity (Critical Performance)
`src/pages/TrainersCity.tsx` line 183-193 calls `getTrainerAverageRating()` individually for **every trainer** in a `Promise.all` loop. This fires N separate database queries. The `Trainers.tsx` page already uses `getBatchTrainerRatings()` which does it in a single query.

**Fix:** Replace `getTrainerAverageRating` loop with `getBatchTrainerRatings(trainerIds)`.

### 2. Unused `contentful` Dependencies (Bundle Bloat)
`contentful` and `@contentful/rich-text-react-renderer` are in `package.json` but never imported anywhere in `src/`. These add unnecessary weight to the install and potentially to the bundle.

**Fix:** Remove both packages from `package.json`.

### 3. Unused `react-leaflet` and `@react-leaflet/core` Dependencies
The map component (`LeafletMap.tsx`) uses the `leaflet` library directly — `react-leaflet` and `@react-leaflet/core` are never imported.

**Fix:** Remove both packages from `package.json`.

### 4. Leftover `priceRange` in Filter State
`TrainerFiltersState` still has a `priceRange` field and `Trainers.tsx` still parses `minPrice`/`maxPrice` from URL params, even though price filtering was removed. This is dead code.

**Fix:** Remove `priceRange` from `TrainerFiltersState`, `DEFAULT_FILTERS`, and the URL param parsing in `Trainers.tsx`.

### 5. `hourly_rate` Still Fetched in Queries
Several pages still SELECT `hourly_rate` from `trainer_profiles_safe` even though it's no longer displayed. While not a major issue, removing it from SELECT statements reduces payload size.

**Fix:** Remove `hourly_rate` from the SELECT in `Trainers.tsx` (line 237), `TrainersCity.tsx` (line 138), and `HomeFeaturedSections.tsx` (line 42). Keep it in internal/admin views where it's still used.

### 6. Trainers Page Uses `useEffect`+`useState` Instead of `useQuery`
`Trainers.tsx` and `TrainersCity.tsx` use manual `useEffect`/`useState` for data fetching, which means no caching, no stale-while-revalidate, and full re-fetches on every navigation. The rest of the app uses TanStack Query.

**Fix:** Migrate both pages to `useQuery` with appropriate `staleTime` (5 minutes). This gives instant back-navigation and reduces redundant API calls.

### 7. `hourly_rate` in `TrainerWithProfile` Interface
The interface in `Trainers.tsx`, `TrainersCity.tsx`, and `HomeFeaturedSections.tsx` still includes `hourly_rate` even though it's not rendered.

**Fix:** Remove from interfaces alongside the SELECT changes.

---

### Files to Edit
- `src/pages/TrainersCity.tsx` — fix N+1 query, migrate to `useQuery`, remove `hourly_rate`
- `src/pages/Trainers.tsx` — migrate to `useQuery`, remove `hourly_rate` from SELECT/interface, clean `priceRange` from URL parsing
- `src/components/trainers/TrainerFilters.tsx` — remove `priceRange` from interface and defaults
- `src/components/home/HomeFeaturedSections.tsx` — remove `hourly_rate` from SELECT/interface
- `package.json` — remove `contentful`, `@contentful/rich-text-react-renderer`, `react-leaflet`, `@react-leaflet/core`

### Impact
- **N+1 fix:** Reduces TrainersCity queries from N+4 to 5 (biggest win)
- **useQuery migration:** Instant back-navigation, no re-fetching on revisit
- **Dependency removal:** ~4 fewer packages in bundle/install
- **Dead code cleanup:** Cleaner codebase, smaller payloads

