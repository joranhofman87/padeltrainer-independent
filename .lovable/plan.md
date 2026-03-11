

# Performance & Code Quality Audit — Final Improvements

Your codebase is already in excellent shape: lazy-loaded routes, TanStack Query caching, skeleton loaders, structured logging, error boundaries, and deferred analytics. Here are the remaining improvements worth making.

---

## 1. Move Leaflet CSS to dynamic import (Performance)

**Problem:** `@import 'leaflet/dist/leaflet.css'` in `index.css` forces every visitor to download Leaflet styles (~40KB) even if they never visit the map page.

**Fix:** Remove the `@import` from `index.css` and import Leaflet CSS only inside `LeafletMap.tsx` (the lazy-loaded component).

---

## 2. Clean up `any` type usage (Code Quality)

Several lib files use `any` casts (`src/lib/club.ts`, `src/lib/cycles.ts`, `src/lib/lessons.ts`, `src/lib/admin.ts`). The most impactful ones to type properly:

- `toCycle(row: any)` / `toIntakeRequest(row: any)` / `toProposedAssignment(row: any)` in `cycles.ts` — replace with generated DB types
- `(slot as any).max_participants` in `lessons.ts` — add proper interface
- `getUserClubProfiles` return type `location: any` in `club.ts` — use `Location` type

This is cosmetic but prevents bugs during future refactoring.

---

## 3. Add `font-display: swap` (Performance)

If any custom fonts are loaded via `@font-face`, ensure they use `font-display: swap` to prevent invisible text during load (improves FCP). If using system fonts only — this is already fine.

---

## 4. Preload critical route chunks (Performance)

For high-traffic entry points (Home, Trainers, TrainerProfile), add `<link rel="modulepreload">` hints or use Vite's `prefetchDynamicImport` to warm the cache while the user is idle on the landing page.

---

## Summary

| Change | Impact | Effort |
|--------|--------|--------|
| Move Leaflet CSS to dynamic import | ~40KB saved on initial load | 5 min |
| Type `any` usage in lib files | Prevents future bugs | 30 min |
| Preload critical route chunks | Faster navigation to key pages | 10 min |

The Leaflet CSS change is the most impactful quick win. The `any` cleanup is good hygiene. Everything else is already production-ready per your launch checklist.

