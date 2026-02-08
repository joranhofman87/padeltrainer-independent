

# Rebuild Trainer Onboarding Flow

## Overview
Replace the current minimal trainer onboarding page (`Onboarding.tsx` with `pendingRole === 'trainer'`) with a new multi-step, SPICED-aligned onboarding wizard. The flow collects goals, builds an MVP profile, creates the first lesson + slots, and ends at a "review-ready" state where the trainer is NOT yet visible in the marketplace (leveraging the existing `is_public: false` default on `trainer_profiles`).

## Database Changes

A new table `trainer_onboarding` to persist onboarding progress and SPICED data:

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid UNIQUE FK | References auth.users |
| current_step | int | 1-4, which step user is on |
| completed_at | timestamptz | NULL until step 4 is finished |
| goal | text | "fill_slots", "new_players", "reduce_admin", "club_sessions", "other" |
| goal_other_text | text | Free-text if "other" selected |
| followup_answer | text | The conditional follow-up answer |
| icd_responses | jsonb | For post-onboarding I/C/D data (optional, stored later) |
| created_at | timestamptz | Default now() |
| updated_at | timestamptz | Default now() |

RLS: user can only read/write their own row.

## Routing Changes

**New route:** `/app/onboarding/trainer` will render the new `TrainerOnboarding` page instead of the generic `Onboarding` component.

In `DomainRouter.tsx`, add a specific route BEFORE the existing `/app/onboarding/:role`:
```
<Route path="/app/onboarding/trainer" element={<TrainerOnboarding />} />
<Route path="/app/onboarding/:role" element={<Onboarding />} />
```

## New Files

### 1. `src/pages/TrainerOnboarding.tsx`
Main orchestrator page. Manages state for all 4 steps, progress indicator, back button, and persistence.

- Uses `trainer_onboarding` table for resume support
- On mount: checks if user has existing onboarding progress, resumes from `current_step`
- After each step, saves progress to DB
- Fires analytics events via a simple `trackOnboardingEvent()` helper

### 2. `src/components/trainer/onboarding/OnboardingStep1Goal.tsx`
Step 1 -- Goal (SPICED: S/P)

- Single-select cards for the 5 goal options
- On selection, reveals one conditional follow-up question (mapped per goal)
- "Other" option reveals a free-text input
- No skip allowed
- Data: `goal`, `goal_other_text`, `followup_answer`

### 3. `src/components/trainer/onboarding/OnboardingStep2Profile.tsx`
Step 2 -- MVP Profile

Reuses existing components and writes to the same `profiles` + `trainer_profiles` tables:
- **Name** (required) -- pre-filled from signup, `profiles.full_name`
- **About** (required, short bio) -- `profiles.bio`, with placeholder helper text
- **Training locations** (optional) -- reuses `TrainerLocationPicker` component, writes to `trainer_locations`
- **Specializations** -- reuses `SpecializationsPicker`, writes to `trainer_profiles.specializations`
- **Phone** (optional) -- `profiles.phone`, with helper text "For booking updates"

Fields like `hourly_rate` are NOT collected here (they come with the lesson in Step 3).

### 4. `src/components/trainer/onboarding/OnboardingStep3Lesson.tsx`
Step 3 -- Create first bookable lesson + slots

Two sub-panels presented as one step:

**Part A: Lesson creation** (inline form, not a dialog)
- Title (required)
- Duration (select: 30/45/60/90/120 min)
- Price (required) -- also sets `trainer_profiles.hourly_rate` as a side effect
- Max participants (default 1)
- Payment timing (upfront/after)
- Uses `createLesson()` from `lib/lessons.ts`

**Part B: Slot creation**
- Simplified inline slot creator (date picker + time picker)
- Auto-links the lesson created in Part A
- Shows count of slots added, with inline prompt if < 2:
  "Add at least 2 time slots so players can request a booking."
- Uses direct `supabase.from('availability_slots').insert()` (same as `AddSlotDialog`)
- Soft validation: can proceed with < 2 slots but shown a warning

### 5. `src/components/trainer/onboarding/OnboardingStep4Done.tsx`
Step 4 -- Review-ready screen

Exact copy as specified:
- Headline: "Nice -- your setup is ready to review"
- Body text explaining profile isn't visible yet
- Primary button: "Review your profile" (navigates to public profile preview)
- Secondary button: "Go to dashboard" (navigates to `/app/trainer/get-started`)
- Link: "Edit profile" (navigates to `/app/trainer/profile`)
- Small note about publishing anytime

Also marks `trainer_onboarding.completed_at` and fires `onboarding_completed` event.

### 6. `src/components/trainer/onboarding/OnboardingProgressBar.tsx`
Simple step indicator showing "Step X of 4" with a progress bar.

### 7. `src/lib/onboardingTracking.ts`
Analytics helper for onboarding funnel events:
- Uses `window.gtag` if available (respects cookie consent)
- Also logs to `supabase.from('analytics_events')` if such a table exists, or uses `console.log` as fallback
- Events: `onboarding_started`, `step1_goal_selected`, `profile_mvp_completed`, `lesson_created`, `slots_created`, `onboarding_completed`, `preview_opened`, `dashboard_opened`, `publish_toggled_on/off`, `icd_card_completed`

## Modified Files

### `src/components/DomainRouter.tsx`
- Import `TrainerOnboarding`
- Add route `/app/onboarding/trainer` before the generic `:role` route

### `src/pages/TrainerProfile.tsx`
- Add a "Preview mode" banner when the viewing user is the trainer themselves AND `is_public === false`
- Banner includes: "Edit profile", "Add availability", "Publish profile" actions
- "Publish profile" toggles `is_public` to `true` with confirmation

### `src/pages/TrainerSettings.tsx`
- Enhance the existing `is_public` toggle with the specified copy:
  - Label: "Marketplace visibility"
  - Off helper: "Hidden -- you won't appear in search and players can't book you"
  - On helper: "Visible -- players can find you and request lessons"
  - Safety line: "You can switch this off anytime."

### `src/pages/TrainerGetStarted.tsx` (post-onboarding checklist)
Update the checklist items to match the spec:
1. Complete your profile essentials
2. Add 3 more time slots
3. Add your existing players
4. Set up payments (Mollie or manual invoicing)
5. Publish your profile

### `src/pages/TrainerSignup.tsx`
- Update navigation after signup to point to `/app/onboarding/trainer` (already does this)

### `src/pages/Onboarding.tsx`
- Add early redirect: if `pendingRole === 'trainer'`, redirect to `/app/onboarding/trainer`
- This ensures existing flows (e.g., Google OAuth returning to generic onboarding) still work

## How Onboarding Resume Works

1. On mount, `TrainerOnboarding` queries `trainer_onboarding` for the current user
2. If a row exists with `completed_at IS NULL`, resume from `current_step`
3. If no row exists, insert one with `current_step: 1`
4. After each step's "Next" action, update `current_step` in the DB
5. If the user already has a role set and onboarding is complete, redirect to dashboard

## Data Flow Summary

```text
Step 1 (Goal)
  -> trainer_onboarding.goal, followup_answer

Step 2 (MVP Profile)
  -> profiles.full_name, profiles.bio, profiles.phone
  -> trainer_locations (via TrainerLocationPicker)
  -> trainer_profiles.specializations

Step 3 (Lesson + Slots)
  -> lessons table (via createLesson)
  -> trainer_profiles.hourly_rate (side-effect from lesson price)
  -> availability_slots table (direct insert)

Step 4 (Done)
  -> trainer_onboarding.completed_at
  -> user_roles (trainer role set if not already)
  -> trainer_profiles.is_public remains false
```

## Key Design Decisions

1. **No "Skip" buttons** except: phone number is optional, locations are optional, slot count is soft-validated (warning, not blocking)
2. **`is_public` is already `false` by default** -- no migration needed for visibility logic
3. **Trainer role + profile creation** happens at the START of onboarding (in the existing `setUserRole` flow), so Steps 2-3 can write to `trainer_profiles` immediately
4. **Lesson form is inline** (not a dialog) to reduce friction and make it feel like one continuous action with slot creation
5. **Existing components reused**: `TrainerLocationPicker`, `SpecializationsPicker`, lesson form fields, slot creation logic

