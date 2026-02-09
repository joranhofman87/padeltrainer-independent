
## Final Legacy Code Cleanup

After a thorough scan, the critical `lessons(...)` query joins and `from("lessons")` calls have been successfully removed. The database confirms: no `lessons` table, no `lesson_id` column, and no `stripe_accounts` tables remain. However, several cosmetic and minor functional issues persist.

---

### What's Left to Clean Up

#### 1. TrainerGetStarted -- `hasLessons` is always false (functional bug)

**File:** `src/pages/TrainerGetStarted.tsx`

The `hasLessons` field is hardcoded to `(lessonCount || 0) > 0` but `lessonCount` is hardcoded to `0`. This means the "all complete" check on line 113 will **never** pass. The `SetupStatus` interface and `TrainerSetupChecklist.tsx` also carry this dead field.

**Fix:** Remove `hasLessons` from the interface and the `allComplete` check. The `hasAvailability` check (slot count) already covers this use case.

**Files:** `src/pages/TrainerGetStarted.tsx`, `src/components/trainer/TrainerSetupChecklist.tsx`

---

#### 2. OnboardingStep3Schedule -- stale "lesson" naming throughout

**File:** `src/components/trainer/onboarding/OnboardingStep3Schedule.tsx`

This file was renamed from `OnboardingStep3Lesson.tsx` but still has:
- `lessonCreated`, `lessonId`, `creatingLesson` state variables
- `handleCreateLesson` function name
- `canCreateLesson` variable
- UI text: "Create your first bookable lesson", "Lesson details", "Create lesson"
- Comment: "// Lesson fields"

**Fix:** Rename all internal variables and update user-facing text to use "training session" or "rate" terminology. This is a text/variable rename, no logic change.

---

#### 3. Email templates use `lessonTitle`/`lessonDate`/`lessonTime` naming

**Files:** `src/lib/email.ts`, `supabase/functions/send-email/index.ts`

These are parameter names only (not DB column references), so they work fine. However, the email body text in `send-email/index.ts` says things like "Your lesson has been successfully booked!" and "Lesson Reminder". 

**Fix:** Rename parameters to `sessionTitle`/`sessionDate`/`sessionTime` in both files. Update email body text from "lesson" to "training session". Update all 6 call sites in `BookLesson.tsx`, `BookForPlayerDialog.tsx`, `DeleteSlotDialog.tsx`, `PlayerBookings.tsx`, `TrainerEarnings.tsx` to pass the renamed parameters.

---

#### 4. Calendar sync uses "Tennis:" prefix

**File:** `supabase/functions/sync-calendar-event/index.ts` line 266

The Google Calendar event summary says `Tennis: ${slot.cyclus_name || 'Lesson'}`.

**Fix:** Change to `Padel: ${slot.cyclus_name || 'Training Session'}`.

---

#### 5. `max_lessons` still in admin UI and pricing hook

The `max_lessons` column still exists in the database `subscription_plans` table and is referenced in:
- `src/hooks/usePricingPlans.ts` (interface definition)
- `src/components/admin/PlanEditDialog.tsx` (form field)

**Fix:** 
- Remove `max_lessons` from the `SubscriptionPlan` interface in `usePricingPlans.ts`
- Remove the `max_lessons` form field from `PlanEditDialog.tsx`
- Drop the `max_lessons` column from the `subscription_plans` table via DB migration

---

#### 6. CalendarSettings -- "lessons" wording in UI text

**File:** `src/pages/CalendarSettings.tsx`

Four instances of "lessons" in user-facing text:
- "automatically add confirmed lessons to your calendar"
- "See lessons alongside your other events"

**Fix:** Replace with "training sessions".

---

#### 7. Stale comment in useAuth

**File:** `src/hooks/useAuth.tsx` line 90

Comment says: `// Use check-mollie-subscription with type: "trainer" instead of legacy check-trainer-subscription`

**Fix:** Simplify to just describe what it does, remove the "instead of legacy" reference.

---

#### 8. Subscription.ts stale comment

**File:** `src/lib/subscription.ts` line 16

Comment says: `// Subscription tier configuration (database-driven, no Stripe IDs)`

**Fix:** Remove the "no Stripe IDs" part since Stripe is no longer relevant.

---

### Summary

| # | What | Files | Impact |
|---|------|-------|--------|
| 1 | `hasLessons` always false -- blocks checklist completion | 2 | Functional bug |
| 2 | OnboardingStep3Schedule stale lesson naming | 1 | Cosmetic/confusing |
| 3 | Email param names `lessonTitle` etc. | 8 | Cosmetic |
| 4 | Calendar sync "Tennis:" prefix | 1 edge function | Wrong sport name |
| 5 | `max_lessons` in admin UI + DB | 2 + DB migration | Dead field |
| 6 | CalendarSettings "lessons" text | 1 | Cosmetic |
| 7-8 | Stale comments | 2 | Cosmetic |

### Execution Order

1. Fix the `hasLessons` bug (items 1)
2. Rename lesson variables in OnboardingStep3Schedule (item 2)
3. Rename email parameters and update call sites (item 3)
4. Fix calendar sync prefix (item 4)
5. Remove `max_lessons` from admin UI + DB migration (item 5)
6. Fix remaining text and comments (items 6-8)
