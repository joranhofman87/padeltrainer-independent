

# Fix Crash on Cycles Tab

## Root Cause
The error `A <Select.Item /> must have a value prop that is not an empty string` crashes the page. This happens because some cycles (academy-owned, without slots) produce a `CyclusGroup` with `trainer_id: ''`. This empty string ends up in the trainer filter `<SelectItem value="">`.

Additionally, `period_start`/`period_end` can be null when a cycle has no slots and no `start_date`/`end_date`, which would crash `parseISO`.

## Fix in `src/pages/academy/AcademyCyclusOverview.tsx`

1. **Filter out empty trainer IDs** in the `trainers` memo — skip entries where `id` is falsy:
   ```ts
   const trainers = useMemo(() => {
     const map = new Map<string, string>();
     groups.forEach(g => { if (g.trainer_id) map.set(g.trainer_id, g.trainer_name); });
     return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
   }, [groups]);
   ```

2. **Guard `period_start`/`period_end`** — when building `CyclusGroup`, default to current date if both cycle dates and slot dates are missing. In the time filter, guard `parseISO` against null/empty values.

3. **Guard `trainer_id`** in the grouping logic — default to empty string is fine for data, but ensure the filter Select only renders items with non-empty IDs (already fixed by step 1).

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCyclusOverview.tsx` | Filter empty trainer IDs from filter dropdown, guard null period dates |

