

# Fix Plan: Logging, Error Boundaries, and Console.error Migration

## Summary

There are 3 categories of work remaining:

1. **Migrate `console.error` to `logger.error`** across 26 pages and ~50 components (~750 calls total)
2. **Add `FeatureErrorBoundary`** to 4 signup pages + Auth page
3. **No new test files needed** — the subscription/sharedSubscription tests were already created

Given the volume, I recommend a phased approach focusing on the highest-risk pages first.

---

## Phase 1: FeatureErrorBoundary on Signup + Auth (5 files)

Wrap the return JSX of these pages in `<FeatureErrorBoundary>`:
- `src/pages/PlayerSignup.tsx`
- `src/pages/TrainerSignup.tsx`
- `src/pages/AcademySignup.tsx`
- `src/pages/ClubSignup.tsx`
- `src/pages/Auth.tsx`

Each needs: import + wrap outer div in `<FeatureErrorBoundary featureName="X" onRetry={...}>`.

## Phase 2: Migrate console.error on HIGH-RISK pages (13 files)

These pages handle money, user data, or core flows and still use raw `console.error`:

| File | console.error count | Has logger? |
|------|---------------------|-------------|
| `TrainerCalendar.tsx` | 10+ | No |
| `EditProfile.tsx` | 4 | No |
| `PlayerDashboard.tsx` | 4 | No |
| `TrainerPlayers.tsx` | 3 | No |
| `TrainerCycles.tsx` | 1 | No |
| `TrainerBookings.tsx` | 2 | No |
| `TrainerDashboard.tsx` | 3+ | No |
| `TrainerOnboarding.tsx` | 1 | No |
| `NotificationSettings.tsx` | 2 | No |
| `LocationDetail.tsx` | 1 | No |
| `Trainers.tsx` | 4 | No |
| `club/ClubProfile.tsx` | 3 | No |
| `club/ClubSubscription.tsx` | 2 | No |

For each: add `import { logger } from '@/lib/logger'` and replace `console.error('msg', error)` with `logger.error('msg', error instanceof Error ? error : new Error(String(error)), { component: 'PageName' })`.

## Phase 3: Migrate console.error on MEDIUM-RISK pages (13 files)

Remaining pages and admin panels:
- `club/ClubPlayers.tsx`, `club/ClubCalendar.tsx`, `club/ClubTrainerInvitation.tsx`
- `academy/AcademyTrainers.tsx`, `academy/AcademyLocations.tsx`
- `admin/AdminAcademies.tsx`
- `Academies.tsx`, `Locations.tsx`
- `marketing/Partner.tsx`
- `TrainerSettings.tsx` (already has logger but one leftover console.error)
- `CalendarSettings.tsx`, `PlayerBookings.tsx`, `PlayerSettings.tsx`

## Phase 4: Migrate console.error in critical components (~15 highest-traffic)

Top priority components with `console.error`:
- `CycleForm.tsx`, `AddIntakeRequestDialog.tsx`
- `EditAcademyTrainerDialog.tsx`, `EditClubTrainerDialog.tsx`
- `EditPlayerDialog.tsx`
- `BookForPlayerDialog.tsx`, `ManualPaymentDialog.tsx`
- `WaitingListTable.tsx`
- `AdminTrainerReviewsTab.tsx`, `TrainerSubscriptionEditDialog.tsx`
- `ClubSubscriptionEditDialog.tsx`
- `PlayerInvoicesTab.tsx`
- `RatingHistoryChart.tsx`
- `ScrapeLogosDialog.tsx`

---

## Estimated scope

- **Phase 1**: 5 files, ~5 lines each = trivial
- **Phase 2**: 13 files, ~3-10 replacements each = moderate
- **Phase 3**: 13 files, ~2-5 replacements each = moderate
- **Phase 4**: 15 components, ~2-4 replacements each = moderate

Total: ~46 files touched, all mechanical find-and-replace of `console.error` to `logger.error` with proper Error wrapping and context tags.

I recommend doing **Phases 1-3** now (31 files, all pages) and deferring Phase 4 (components) to a follow-up pass to keep the changeset reviewable.

