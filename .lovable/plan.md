

## Legacy Code Remaining — Cleanup Plan

After auditing the codebase, here's what's left:

---

### 1. Three more files still import the old Supabase client

The previous migration missed 3 files that use `await import('@/integrations/supabase/client')` (dynamic imports):

| File | Lines |
|------|-------|
| `src/pages/admin/AdminLocations.tsx` | 108 |
| `src/pages/club/ClubTrainerInvitation.tsx` | 64, 73 |
| `src/pages/academy/AcademyTrainerInvitation.tsx` | 64, 73 |

**Fix:** Replace dynamic imports with the standard `import { supabase } from '@/lib/supabaseClient'` at the top of each file.

---

### 2. Deprecated `isAppPage` prop still in SEO component

`src/components/SEO.tsx` has a `@deprecated isAppPage` prop that's no longer used by any page. The prop and all its conditional logic (~15 lines) can be removed — `noIndex` already covers the use case.

**Fix:** Remove the prop from the interface and all references in the component.

---

### 3. Raw `console.*` calls in 17 source files

~240 `console.log/warn/error` calls across `src/` components and hooks bypass the structured `logger` utility that was set up for PostHog integration. These are invisible to monitoring in production.

**Fix:** Replace `console.error` → `logger.error`, `console.warn` → `logger.warn` in the ~17 affected source files. Edge functions (`supabase/functions/*`) can keep `console.*` since they run server-side with their own logging.

**Affected files (src/ only):**
- `WaitingListTable.tsx`, `CycleForm.tsx`, `AcademyOpenCycles.tsx`, `AddSlotDialog.tsx`, `ImportPlayersDialog.tsx`, `ScrapeLogosDialog.tsx`, `DuplicateCyclusDialog.tsx`, `AcademyEditDialog.tsx`, and ~9 others.

---

### 4. Legacy redirect routes still in DomainRouter

`src/components/DomainRouter.tsx` has ~12 legacy redirect routes (lines 274-285) mapping old paths like `/auth`, `/signup/*`, `/trainer/*` to their `/app/` equivalents. These were needed during a routing migration.

**Action:** These should stay for now — removing them would break any bookmarked/shared URLs. But they could be logged (via `logger.info`) to track usage and plan eventual removal.

---

### Summary

| # | Issue | Effort | Impact |
|---|-------|--------|--------|
| 1 | 3 files still on old Supabase client | Trivial | Prevents auth drift |
| 2 | Deprecated `isAppPage` SEO prop | Trivial | Code hygiene |
| 3 | Raw console.* in 17 src files | Medium | Production observability |
| 4 | Legacy redirects (keep, add logging) | Small | Usage tracking |

Items 1-2 are quick wins. Item 3 is the biggest effort but gives production visibility. Item 4 is informational — no action needed yet.

