## Problem
Only Rene appears in the Cycles tab. The other 8 trainers vanished after the previous fix that filtered out `type='registration'` cycles.

## Root cause
For this academy, all real scheduled cycles are stored as cycles with `type='registration'` (the intake-form record doubles as the schedule container). Their `availability_slots` are the actual weekly sessions and most have real bookings:

```
Tygho     126/126 slots booked
Yannick    70/70  slots booked
Patrick    70/84  slots booked
Rene       42/42  slots booked  (+275 legacy orphan slots)
Rikkert     0/44  slots booked
```

The previous patch dropped every cycle and every slot whose cycle was `type='registration'`, which removed all of the above except Rene's 275 legacy orphan slots (no `cycles` row → not filtered).

What we actually want to hide is only the standalone intake form (a `registration` cycle with **zero scheduled slots**), not the real per-trainer scheduled rows that happen to live under a registration cycle.

## Changes (single file: `src/pages/academy/AcademyCyclusOverview.tsx`)

### 1. Remove the blanket type filter (lines ~145–152)
- Drop the `registrationCycleIds` Set and the `.filter(c => c.type !== 'registration')` on `allCycles`.
- Drop the `allSlots = allSlots.filter(s => !registrationCycleIds.has(s.cyclus_id))` line.
- Result: cycles + slots of every type are processed again.

### 2. Hide only empty registration intake forms (lines ~311–344)
In the `if (slotsByTrainer.size === 0)` branch (the no-slots placeholder), early-return when `cycle.type === 'registration'`:

```ts
if (slotsByTrainer.size === 0) {
  if (cycle.type === 'registration') return; // skip empty intake forms
  // …existing placeholder push…
}
```

This drops the four placeholder rows the user previously complained about (84/70/42/126 sessions) while keeping every real, slot-backed per-trainer row visible.

### 3. No other changes
- Per-trainer slot grouping already produces one row per (cycle × trainer), so all 9 trainers will reappear.
- Counts shown (`sessions = trainerSlots.length`, `player_count = unique booked names`) reflect actual scheduled sessions, matching the detail view.

## Out of scope
- No schema changes.
- No UI/styling changes (single-line row layout from the previous turn stays).
- Time filter ("Huidig") behaviour unchanged.