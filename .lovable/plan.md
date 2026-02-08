
# ✅ IMPLEMENTED
## Separate Registrations from Cyclus (Calendar Slots)

### The Problem
Currently, "Registrations" (collecting player interest) and "Cyclus" (specific recurring calendar entries) are mixed together in the same `cycles` table and use the same `CycleForm`. These are fundamentally different things:

1. **Registrations** = "We're looking for players interested in training." No specific day/time. Players fill in their availability, preferences, rating, etc. All responses go to Intake Requests. From there, the trainer/academy plans the agenda.

2. **Cyclus** (or single slots) = A specific recurring training on a day and timeframe (e.g. "Tuesday 16:00-17:00, 10 weeks"). Shown on the calendar. Has a trainer, level, group size, pricing.

### What Changes

**1. Simplify the Registration form (public-facing CycleApplicationForm)**
- Remove the cycle-specific timeframe info from the registration page header (no specific day/time to show since registrations are not tied to a slot)
- Keep the detailed player application form: availability picker (multiple time windows per day with 30-min increments), lesson type, rating, preferred trainer, notes
- The form stays largely the same -- it already collects availability via `DayAvailabilityPicker`

**2. Simplify the Registration creation form (CycleForm for registrations)**
- When creating a Registration, remove timeframe fields (`start_time`, `end_time`) and the auto-pricing calculation -- these belong to Cyclus only
- Keep: name, enrollment deadline, lesson types, rating requirements, location
- The `CycleForm` will detect which mode it's in based on a new prop or a field

**3. Keep the Cyclus creation form (CycleForm for cyclus)**
- When creating a Cyclus, keep all the current fields: start date, number of weeks, start time, end time, trainer, level, group size, auto-pricing
- This creates calendar entries and is tied to specific day/time

**4. Navigation restructuring**

For **Trainers**, reorganize the sidebar:
- **Players** group:
  - My Players
  - Intake Requests (all intake requests across all registrations)
- **Schedule** group:
  - Calendar (create Cyclus/single slots here)
  - Open Slots
  - Lessons
- **Registrations** -- single page (not a group): shows the list of registrations + create button + link to share. Intake requests link from here too.

For **Academies**, same pattern:
- Move "Registrations" out of the Schedule group and make it a standalone nav item
- Add an Intake Requests page for academies (currently only trainers have one)

**5. Add Intake Requests page for Academy**
- Create `src/pages/academy/AcademyIntakeRequests.tsx` mirroring `TrainerIntakeRequests.tsx`
- Uses `getIntakeRequestsWithProposals('academy', academyId)` -- the function already supports this owner type
- Add route and sidebar link

**6. Differentiate Registration vs Cyclus in the database**
- Add a `type` field to the `cycles` table: `'registration'` or `'cyclus'`
- Default to `'registration'` for backward compatibility
- Filter by type in queries: Registrations page shows type=registration, Calendar shows type=cyclus

### Technical Details

**Database migration:**
```sql
ALTER TABLE cycles ADD COLUMN type TEXT NOT NULL DEFAULT 'registration' 
  CHECK (type IN ('registration', 'cyclus'));
```

**CycleForm changes (`src/components/cycles/CycleForm.tsx`):**
- Add a `formType: 'registration' | 'cyclus'` prop
- When `formType === 'registration'`: hide start_time, end_time, auto-pricing. Show name, enrollment deadline, lesson types, rating, location
- When `formType === 'cyclus'`: show all current fields (date, weeks, timeframe, trainer, pricing, etc.)
- On submit, include `type` in the cycle input

**SlotTypeChoiceDialog stays the same** -- "Training Cycle" opens CycleForm with `formType='cyclus'`

**TrainerCycles/AcademyCycles pages** -- these become the "Registrations" pages, filtering for `type='registration'` only. Add a "Create Registration" button that opens CycleForm with `formType='registration'`.

**Calendar pages** -- "Training Cycle" choice opens CycleForm with `formType='cyclus'`

**New files:**
- `src/pages/academy/AcademyIntakeRequests.tsx`

**Modified files:**
- `src/components/cycles/CycleForm.tsx` -- add `formType` prop, conditional field visibility
- `src/lib/cycles.ts` -- add `type` to `CycleInput` and `Cycle` interfaces, update queries
- `src/pages/TrainerCycles.tsx` -- filter by type='registration'
- `src/pages/academy/AcademyCycles.tsx` -- filter by type='registration'
- `src/pages/TrainerDashboard.tsx` -- pass formType='cyclus' to CycleForm
- `src/pages/TrainerCalendar.tsx` -- pass formType='cyclus' to CycleForm
- `src/pages/academy/AcademyCalendar.tsx` -- pass formType='cyclus' to CycleForm
- `src/components/trainer/TrainerSidebar.tsx` -- restructure Registration nav
- `src/components/academy/AcademySidebar.tsx` -- add Registrations + Intake nav items
- `src/App.tsx` -- add academy intake requests route
- `src/i18n/locales/en/cycles.json` and `nl/cycles.json` -- add new translation keys

