
## Fix: Show Academy Trainers on Public Location Page

### Problem
Trainers assigned to a location by an academy (with `relationship_type = 'academy_trainer'`) have `show_on_club_page` defaulting to `false`. The public location page query in `getTrainersAtLocation()` filters by `show_on_club_page = true`, so these trainers never appear.

### Solution

**1. Update `getTrainersAtLocation()` in `src/lib/locations.ts`**

Change the query filter so that trainers are shown if:
- `show_on_club_page` is `true` (club-managed trainers, existing behavior), **OR**
- `relationship_type` is `'academy_trainer'` (academy-assigned trainers should always be visible)

This uses Supabase's `.or()` filter:
```typescript
.or('show_on_club_page.eq.true,relationship_type.eq.academy_trainer')
```

**2. Set existing academy trainer records to visible**

Run a migration to set `show_on_club_page = true` for all existing `academy_trainer` records, so the behavior is consistent going forward:
```sql
UPDATE trainer_locations
SET show_on_club_page = true
WHERE relationship_type = 'academy_trainer';
```

**3. Update academy trainer creation to default `show_on_club_page` to `true`**

Check where academy trainers are inserted into `trainer_locations` (likely in `src/lib/academy.ts` or the `create-academy-trainer` edge function) and ensure `show_on_club_page` defaults to `true` for `academy_trainer` relationship types.

### Technical Details

- **File**: `src/lib/locations.ts` -- update `getTrainersAtLocation()` filter (line ~159)
- **Migration**: update existing rows and optionally add a default trigger
- **Edge function / lib**: update academy trainer insertion to set `show_on_club_page = true`

This is a minimal, targeted fix that preserves the existing club trainer visibility toggle while ensuring academy-assigned trainers are visible by default.
