

## QA / Product Audit: Performance, UX, and Code Hygiene

After reviewing the codebase, here are the issues worth addressing, grouped by priority.

---

### HIGH PRIORITY

#### 1. Dual Supabase client — consolidate to one
There are **two** Supabase clients: `@/lib/supabaseClient` (155 files) and `@/integrations/supabase/client` (12 files). They have identical config but create separate instances, meaning separate auth sessions, separate connection pools, and potential state drift. `LocationEditDialog.tsx` even imports **both** as `supabase` and `supabaseTyped`.

**Fix:** Migrate all 12 files using `@/integrations/supabase/client` to import from `@/lib/supabaseClient` instead. The auto-generated file can't be edited, but it also shouldn't be used.

#### 2. Dead hook: `usePlatformStats`
`src/hooks/usePlatformStats.ts` is defined but **never imported anywhere** in the codebase. It makes 4 sequential DB queries on mount (trainer count, booking count, all reviews, all locations). If it was ever re-enabled it would be a waterfall. Safe to delete.

#### 3. `useFollowTrainer` and `useFollowClub` redundantly fetch profile
Both hooks call `supabase.from('profiles').select('id').eq('user_id', user.id)` on every mount to get the player's profile ID. The auth context already has `profile.id` available. This is an unnecessary round-trip per trainer/club page load.

**Fix:** Use `profile.id` from `useAuth()` directly (like `useFollowedTrainerIds` already does).

---

### MEDIUM PRIORITY

#### 4. Framer Motion loaded eagerly on homepage
`framer-motion` (~40KB gzipped) is imported synchronously by the HeroSection and 12+ homepage components. For first-time visitors (marketing landing), this delays LCP.

**Fix:** Use `import { LazyMotion, domAnimation, m } from 'framer-motion'` with the tree-shakeable `m` component, or wrap homepage sections in a lazy-loaded wrapper so framer-motion is code-split away from the critical path.

#### 5. Tiptap imported eagerly in page components
`TrainerTerms.tsx` and `AcademySettings.tsx` directly import Tiptap extensions (~60KB). These are niche settings pages visited by few users.

**Fix:** Extract the rich-text editor into a lazy-loaded component (the existing `rich-text-editor.tsx` component exists but isn't used by these pages).

#### 6. `useBannerRotation` — waterfall queries
The banner hook makes two sequential queries (placement lookup, then assignments). These could be combined into a single query with a join, or moved to TanStack Query for caching so repeated page visits don't re-fetch.

#### 7. i18n: all NL namespaces loaded eagerly
The default language (NL) loads **11 JSON files** synchronously in the initial bundle — including `admin.json`, `academy.json`, `waitingList.json` that most visitors never need. Only `common` and `marketing` are needed for the landing page.

**Fix:** Lazy-load NL namespaces the same way non-NL languages are loaded, except for `common` and `marketing`.

---

### LOW PRIORITY (Code Hygiene)

#### 8. `main.tsx` has an out-of-order import
The `import { initializePostHog }` statement is placed after the global error handlers (line 27) instead of at the top with other imports. Not a bug, but violates standard conventions and could confuse linters.

#### 9. Follow hooks missing i18n
`useFollowTrainer` and `useFollowClub` have hardcoded English strings ("Sign in required", "Following trainer!", "Unfollowed club"). These should use `t()` for consistency with the rest of the app.

#### 10. Recharts loaded synchronously in analytics pages
`TrainerAnalytics.tsx` and `AdminCharts.tsx` import recharts directly. These are dashboard pages that are already lazy-loaded at the route level, so this is lower priority — but wrapping chart components in their own `lazy()` would further reduce the trainer dashboard chunk.

---

### Summary Table

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 1 | Dual Supabase client | Auth bugs, wasted connections | Small |
| 2 | Dead `usePlatformStats` hook | Dead code bloat | Trivial |
| 3 | Redundant profile fetches in follow hooks | Extra DB round-trips | Small |
| 4 | Framer Motion on critical path | Slower LCP for new visitors | Medium |
| 5 | Tiptap eagerly loaded | Larger page chunks | Small |
| 6 | Banner waterfall queries | Slower banner load | Small |
| 7 | NL i18n all-eager loading | Larger initial bundle | Medium |
| 8 | Out-of-order import in main.tsx | Code hygiene | Trivial |
| 9 | Hardcoded English in follow hooks | i18n gap | Small |
| 10 | Recharts eager in dashboards | Chunk size | Small |

I'd recommend tackling 1-3 first (quick wins, real impact), then 4 and 7 (biggest bundle savings for marketing visitors).

