
## Leftover / Unused Code Analysis

After the lessons table removal, there are **significant remnants** scattered across the codebase. Here is a categorized inventory of everything that needs cleanup.

---

### Category 1: Supabase Queries Still Joining the `lessons` Table (WILL FAIL)

These queries use `lessons(...)` join syntax against a table that no longer exists, meaning they will produce runtime errors or silently return null.

| File | Line(s) | Issue |
|------|---------|-------|
| `src/pages/TrainerBookings.tsx` | ~119 | `lessons(id, title, price, duration_minutes, location, payment_timing)` |
| `src/pages/TrainerEarnings.tsx` | ~183 | `lessons(title, price, payment_timing)` |
| `src/pages/TrainerAnalytics.tsx` | ~101 | `lessons(price)` |
| `src/pages/PlayerBookings.tsx` | ~69 | `lessons(title, price, location)` |
| `src/pages/PlayerDashboard.tsx` | ~151 | `lessons(title, location)` |
| `src/pages/TrainerCyclus.tsx` | ~139 | `lessons(title)` |
| `src/components/trainer/DeleteSlotDialog.tsx` | ~113, ~195 | `lessons(title)` in two queries |
| `src/components/trainer/EditBookingDialog.tsx` | ~50 | Type definition `lessons: { id, title, price }` and UI rendering |
| `src/lib/cycles.ts` | ~708 | `lessons(id, title)` in proposed_assignments query |
| `supabase/functions/generate-proposals/index.ts` | ~399 | `lessons(id, title, max_participants)` |
| `supabase/functions/sync-calendar-event/index.ts` | ~141-164 | Queries `from('lessons')` and uses `booking.lesson_id` |

### Category 2: `lesson_id` References Still in Code

| File | Line(s) | Issue |
|------|---------|-------|
| `src/components/trainer/EditSlotDialog.tsx` | 36-41, 64, 80, 140, 158, 272-276 | `Lesson` interface, `lessonId` state, writes `lesson_id` to DB, renders lesson selector UI |
| `src/components/trainer/BookForPlayerDialog.tsx` | 49, 60, 260, 322 | `lesson_id` in Slot interface, prop, and booking inserts |
| `src/components/trainer/CalendarSlotCard.tsx` | 32-33 | `lesson_id` and `lesson_title` in type |
| `src/components/club/ClubAddSlotDialog.tsx` | 89, 123, 412, 433 | `slotLessonId` state, writes `lesson_id` to inserts |
| `src/components/club/ClubSlotDetailSheet.tsx` | 56, 58 | `lesson_id` and `lessons` in ClubSlot interface |
| `src/pages/club/ClubCalendar.tsx` | 41, 43, 250 | `lesson_id` and `lessons` in slot type |
| `src/pages/academy/AcademyCalendar.tsx` | 48, 51, 252, 395, 607 | `lesson_id`, `lessons` in type, `lessons?.max_participants` in logic |
| `src/pages/TrainerDashboard.tsx` | 242-243, 814 | `lesson_id: null` in transforms |
| `src/pages/TrainerCalendar.tsx` | 245-246, 631 | `lesson_id: null` in transforms |
| `src/pages/OpenSlots.tsx` | 537 | `lesson_id: null` in slot prop |

### Category 3: Dead State Variables and Unused Logic

| File | Issue |
|------|-------|
| `src/pages/TrainerDashboard.tsx` | `const [lessons, setLessons] = useState<any[]>([])` -- always set to `[]`, never used |
| `src/pages/TrainerCalendar.tsx` | Same dead `lessons` state |
| `src/pages/TrainerProfile.tsx` | Same dead `lessons` state |
| `src/pages/academy/AcademyCalendar.tsx` | Dead `lessons` state + `slotTrainerLessons` useMemo that filters an empty array |
| `src/pages/club/ClubCalendar.tsx` | Dead `lessons` state |
| `src/components/trainer/onboarding/OnboardingStep3Lesson.tsx` | `lessonId` state used as placeholder (set to `trainerId`), not a real lesson reference |

### Category 4: UI Rendering Broken Lesson Data

| File | Issue |
|------|-------|
| `src/pages/PlayerBookings.tsx` | Renders `booking.lessons?.title`, `booking.lessons?.price`, `booking.lessons?.location` -- all will be null |
| `src/pages/TrainerEarnings.tsx` | Shows `booking.lessons?.title`, uses `booking.lessons?.price` for calculations, filters by `lessons?.payment_timing` |
| `src/components/trainer/EditBookingDialog.tsx` | Renders lesson title and price badge |
| `src/pages/TrainerBookings.tsx` | Likely renders lesson data in booking cards |

### Category 5: Subscription Code Referencing Lessons

| File | Issue |
|------|-------|
| `src/lib/subscription.ts` | `canCreateMoreLessons()` function and `STARTER_TIER.maxLessons` -- no longer relevant since lessons table is gone |

### Category 6: Sidebar / Navigation Leftover

| File | Issue |
|------|-------|
| `src/components/trainer/TrainerSidebar.tsx` | Lines 81, 340 still check `isActive("/trainer/lessons")` in the schedule section active state |

### Category 7: Test Data

| File | Issue |
|------|-------|
| `e2e/fixtures/test-data.ts` | `clubLessons: '/club/lessons'` route that no longer exists |

---

### Cleanup Plan

**Phase 1 -- Fix Breaking Queries (Critical)**
Remove `lessons(...)` joins from all Supabase queries in the 11 files listed in Category 1. Replace with slot-level `price_per_session` and `max_participants` where needed.

**Phase 2 -- Remove `lesson_id` from Types, State, and Inserts**
Strip `lesson_id` from all interfaces, type definitions, insert payloads, and update calls across the ~12 files in Category 2.

**Phase 3 -- Remove Dead State**
Delete the `const [lessons, setLessons]` pattern and the `slotTrainerLessons` useMemo from the 5 calendar/dashboard pages.

**Phase 4 -- Fix UI Rendering**
Update all components that display `booking.lessons?.title` or `booking.lessons?.price` to use slot-level data (`price_per_session`, `cyclus_name`) instead.

**Phase 5 -- Cleanup Misc**
- Remove `canCreateMoreLessons` and `maxLessons` from `subscription.ts`
- Remove `/trainer/lessons` check from sidebar active state
- Remove `clubLessons` from e2e test data
- Update `sync-calendar-event` and `generate-proposals` edge functions

**Phase 6 -- Rename `OnboardingStep3Lesson.tsx`**
Rename to `OnboardingStep3Schedule.tsx` to reflect its actual purpose (setting hourly rate and creating slots).

### Estimated Scope
- ~25 files need changes
- ~12 are critical (breaking queries)
- ~8 are cosmetic (dead state, stale types)
- 2 edge functions need updating
