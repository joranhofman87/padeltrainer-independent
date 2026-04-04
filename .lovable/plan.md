

# Fix Orphan Slots: Backfill + Prevent Future Orphans

## Problem
277 slots have `academy_profile_id = NULL` despite belonging to academy-linked trainers. The `AddSlotDialog` defaults `slotAcademyId` to `null` and only sets it if the trainer manually picks the academy — so slots created from the trainer dashboard were never tagged.

## Changes

### 1. Database migration — Backfill orphan slots
```sql
UPDATE availability_slots s
SET academy_profile_id = at.academy_profile_id
FROM academy_trainers at
WHERE at.trainer_profile_id = s.trainer_id
  AND at.status = 'active'
  AND s.academy_profile_id IS NULL;
```
This fixes 275 slots for Rene + 2 for the other trainer.

### 2. `src/components/trainer/AddSlotDialog.tsx` — Auto-default academy ID
When `trainerAcademy` is fetched, auto-set `slotAcademyId` to the academy ID so any future slots from the trainer dashboard are always tagged:

```typescript
useEffect(() => {
  if (trainerAcademy?.id) {
    setSlotAcademyId(trainerAcademy.id);
  }
}, [trainerAcademy]);
```

This is belt-and-suspenders since academy trainers now have restricted dashboard access, but protects against edge cases.

## File summary

| File | Change |
|------|--------|
| Migration SQL | Backfill `academy_profile_id` on 277 orphan slots |
| `src/components/trainer/AddSlotDialog.tsx` | Auto-set `slotAcademyId` from trainer's academy affiliation |

