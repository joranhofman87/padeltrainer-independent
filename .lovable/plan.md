

## Clean Slate: Wipe Test Data and Remove Legacy Lessons Code

### Part 1: Delete All Test Data

Wipe the following tables (in order to respect foreign keys):

| Table | Current Rows | Action |
|---|---|---|
| bookings | 41 | DELETE all |
| invoices | 2 | DELETE all |
| reviews | 2 | DELETE all |
| intake_requests | 0 | Already empty |
| availability_slots | 39 | DELETE all |
| cycles | 5 | DELETE all |
| guest_players | 2 | DELETE all |
| lessons | 7 | DELETE all |
| waiting_list_entries | 0 | Already empty |

Order matters due to foreign keys: bookings and invoices first, then slots, cycles, guest_players, and lessons last.

### Part 2: Remove the `lessons` Table and Legacy Code

Since pricing now lives on `availability_slots` (via `price_per_session`), the `lessons` table is no longer needed for cyclus creation. We can fully remove it.

**Database migration:**
- Drop the `lesson_id` foreign key column from `availability_slots`
- Drop the `lesson_id` column from `bookings`
- Drop the `lessons` table entirely

**Code cleanup (files to update):**

| File | Change |
|---|---|
| `src/lib/lessons.ts` | Remove `Lesson` type, `createLesson`, `getTrainerLessons`, `updateLesson`, `deleteLesson`. Keep `Booking`, `AvailabilitySlot`, booking-related functions |
| `src/lib/lessons.test.ts` | Remove lesson-related test cases, update slot type to not include `lesson_id` |
| `src/pages/TrainerLessons.tsx` | Remove this entire page (lesson CRUD for trainers) |
| `src/pages/club/ClubLessons.tsx` | Remove this entire page (lesson CRUD for clubs) |
| `src/pages/TrainerCalendar.tsx` | Remove lesson fetching and the `lessons` prop passed to `AddSlotDialog` |
| `src/pages/academy/AcademyCalendar.tsx` | Remove lesson fetching logic |
| `src/pages/club/ClubCalendar.tsx` | Remove `lesson_id` and lessons join from slot interface |
| `src/pages/TrainerDashboard.tsx` | Remove lesson fetching |
| `src/pages/TrainerGetStarted.tsx` | Remove lesson count check from setup checklist |
| `src/pages/BookLesson.tsx` | Remove `lesson_id` from slot type and booking inserts |
| `src/components/trainer/AddSlotDialog.tsx` | Remove any remaining `lesson_id` / `lessonId` references |
| `src/components/trainer/DuplicateCyclusDialog.tsx` | Remove `lesson_id` from slot duplication |
| `src/components/trainer/TrainerSidebar.tsx` | Remove lesson count query from setup checklist |
| `src/components/trainer/TrainerSetupChecklist.tsx` | Remove "create a lesson" step |
| `src/components/trainer/onboarding/OnboardingStep3Lesson.tsx` | Repurpose or remove this onboarding step |
| `src/components/DomainRouter.tsx` | Remove routes for TrainerLessons and ClubLessons |

### Part 3: Live Environment

Before publishing, you will need to run the same data cleanup on Live if there is any real data there. Since this is all test data, publishing the schema changes should be safe.

### Summary

- Wipe all test data from 7 tables
- Drop the `lessons` table and all `lesson_id` columns
- Remove ~15 files/sections of legacy lesson code
- The pricing model now lives entirely on `availability_slots` and `trainer_profiles.hourly_rate`

