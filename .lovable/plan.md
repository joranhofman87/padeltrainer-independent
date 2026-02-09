
## Decouple Cyclus Creation from Registration Flow

### Problem
When creating a cyclus from the calendar page, it currently opens the `CycleForm` which creates a record in the `cycles` table (designed for registration/intake interest collection). Instead, it should open the `BulkCreateSheet` which creates actual `availability_slots` on the calendar that players can directly book.

### What Changes

**1. TrainerDashboard.tsx** - Wire "Create Cyclus" to open the BulkCreateSheet
- Change `handleChooseCyclus` to set `bulkCreateOpen = true` instead of `showCreateCycleDialog = true`
- Remove the `CycleForm` import and component instance (lines 868-881)
- Remove the `showCreateCycleDialog` state variable (no longer needed)

**2. TrainerCalendar.tsx** - Same change if it also uses CycleForm
- Verify and fix the same pattern: cyclus choice should open `BulkCreateSheet`

**3. AddSlotDialog.tsx** - Clean up legacy `lesson_id` reference
- Remove `lesson_id: slotLessonId` from the single slot insert (line 148) since the `lesson_id` column was dropped
- Remove the lesson selector UI and `slotLessonId` state
- Remove the `lessons` prop from `AddSlotDialog` and `BulkCreateSheet` interfaces

**4. Keep CycleForm for Registration pages only**
- `TrainerCycles.tsx` and `AcademyCycles.tsx` continue using `CycleForm` with `formType="registration"` for intake/interest collection
- No changes needed there

### Result
- Calendar "Create Cyclus" button opens the `BulkCreateSheet` which generates recurring `availability_slots` with a shared `cyclus_id`
- These slots appear directly on the calendar and can be made public for direct player booking
- The `CycleForm` remains available only on the Registration pages for intake management
- No "Save & Open Registration" button on the calendar flow

### Technical Details
- The `BulkCreateSheet` already handles: recurring slot generation, auto-pricing from hourly rate, participant limits, location selection, training level, and the `allow_single_booking` flag
- Slots are grouped by `cyclus_id` (UUID) and labeled with `cyclus_name` for calendar display
- Public visibility is controlled via the `is_public` flag on `availability_slots`, managed from the Open Slots page
