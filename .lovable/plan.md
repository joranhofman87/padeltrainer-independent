

## Replace End Date with Number of Weeks

### What changes
In the CycleForm popup, the "End Date" date picker will be replaced with a "Number of Weeks" numeric input. The end date will be automatically calculated as `start_date + (number_of_weeks * 7 days)` and shown as a read-only hint below the input (e.g., "Ends: May 9, 2026").

When editing an existing cycle, the number of weeks will be back-calculated from the start and end dates.

### Technical Details

**File: `src/components/cycles/CycleForm.tsx`**

1. **Schema change**: Replace `end_date: z.date()` with `number_of_weeks: z.coerce.number().min(1).max(52)`. Remove the `end_date > start_date` refinement since it is now guaranteed by construction.

2. **Default values**: Instead of defaulting `end_date` to 90 days from now, default `number_of_weeks` to `10`. When editing, back-calculate weeks from `(end_date - start_date) / 7`, rounded to nearest integer.

3. **UI change**: Replace the end date `Popover + Calendar` column (lines 306-339) with a simple numeric `Input` for weeks, plus a small text line showing the computed end date: `format(addWeeks(startDate, numberOfWeeks), 'PPP')`.

4. **Submit logic**: In `onSubmit`, compute `end_date` from `addWeeks(start_date, number_of_weeks)` before passing it to `createCycle` / `updateCycle`. The database field `end_date` stays unchanged.

**Locale files** (`en/cycles.json`, `nl/cycles.json`):
- Add keys: `form.numberOfWeeks` ("Number of weeks" / "Aantal weken") and `form.endsOn` ("Ends on {{date}}" / "Eindigt op {{date}}")

### What stays the same
- The database schema (still stores `end_date` as a date)
- All display components (CycleCard, registration pages, etc.)
- Start date picker -- unchanged
- All other form fields

