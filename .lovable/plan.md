

# Fix Trainer Filter + Add Active Filter on Players & Email Campaign

## Root Cause
The trainer filter checks `player.trainer_id` — the trainer who **created** the guest player record. But players booked into a trainer's slots via the academy or another trainer won't have that `trainer_id`. The filter needs to check which trainers' **slots** a player has bookings in.

## Changes

### 1. `src/pages/academy/AcademyPlayers.tsx` — Enrich players with `trainer_ids` set

**In `fetchPlayers()`:**
- For **guest players**: when iterating `guestBookings`, also track which `trainer_id` (from the slot) each guest player is associated with. Build a `guestTrainerMap: Map<string, Set<string>>` mapping guest player ID → set of trainer IDs from their booked slots.
- For **registered players**: already tracked via `slotTrainerMap` — extend `playerMap` entry to store a `Set<string>` of all trainer IDs (not just the first one).
- Add `trainer_ids: string[]` to `UnifiedPlayer` type.
- Populate it: combine the ownership `trainer_id` with all slot-derived trainer IDs.

**Update filter logic (line 140-142):**
```typescript
// Old: p.trainer_id === selectedTrainerId
// New: p.trainer_ids?.includes(selectedTrainerId)
```

**Add "Active" filter** — rename "Active Cyclus" to "Active" with clearer labels:
- Already exists as `selectedCyclus` filter. Just confirm labels are clear: "Active" / "Yes" / "No". Current labels are fine.

### 2. `EmailCampaignTab.tsx` — Same trainer filter fix

**Update player interface** to include `trainer_ids?: string[]`.

**Update filter (line 140):**
```typescript
// Old: p.trainer_id !== filterTrainer
// New: !p.trainer_ids?.includes(filterTrainer)
```

**Add "Active" filter** — already has `filterCyclus` with yes/no. Already working since it uses `has_active_cyclus`. No change needed there.

### 3. `UnifiedPlayer` type — extend

Add:
```typescript
trainer_ids?: string[];
```

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyPlayers.tsx` | Add `trainer_ids` enrichment in `fetchPlayers()`, fix trainer filter to use `trainer_ids.includes()` |
| `src/components/academy/EmailCampaignTab.tsx` | Add `trainer_ids` to player interface, fix trainer filter to use `trainer_ids.includes()` |

