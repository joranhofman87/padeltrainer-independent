

## Problem

The cycle `1561ada2...` ("voorjaar trainingen") has `owner_type: 'trainer'`, not `'academy'` or `'club'`. The current `getRegisterPath` logic only handles those two cases, so trainer-owned cycles fall through to the generic `/register/:id` URL — no branding.

The trainer (`c0497580...`) is an active member of academy **RL Padel Performance** (`slug: rl-padel-performance`). So the fix is to resolve trainer-owned cycles to their parent academy's branded URL.

## Plan

**File: `src/components/club/LocationOpenCycles.tsx`**

1. In the `fetchData` effect, after fetching cycles, also collect trainer-owned cycle `owner_id`s.
2. For those trainer IDs, query `academy_trainers` (status = active) joined with `academy_profiles` to get the academy slug.
3. Store these in the existing `academySlugs` map (keyed by **trainer** profile ID → academy slug).
4. In `getRegisterPath`, add a branch for `owner_type === 'trainer'`: look up the trainer's academy slug from the map, and if found, route to `/academies/:slug/register/:cycleId`.

```text
getRegisterPath logic after fix:
  club    + clubSlug         → /clubs/:clubSlug/register/:id
  academy + academySlugs[id] → /academies/:slug/register/:id
  trainer + trainerAcademySlugs[id] → /academies/:slug/register/:id
  fallback                   → /register/:id
```

This is a small change — ~15 lines added to the existing fetch logic and one new condition in `getRegisterPath`.

