

# Expand Cycle Edit Dialog with Bulk Fields

## What
Expand the pencil-icon dialog on cycle groups in the Schedule Overview to allow editing **name**, **price per session**, **location**, and **max group size** in bulk across all slots in that cycle. VAT is already global (trainer profile level), so it's not included here.

## Layout

```text
┌─────────────────────────────────┐
│  Edit Cycle                     │
│                                 │
│  Name:  [Monday Beginners    ]  │
│  Price per session:  [€ 35   ]  │
│  Location:  [Select location ▼] │
│  Max players:  [4            ]  │
│                                 │
│  ⚠️ Changes apply to all X     │
│     sessions in this cycle.     │
│                                 │
│         [Cancel]  [Save]        │
└─────────────────────────────────┘
```

## Changes

### 1. `src/pages/TrainerScheduleOverview.tsx`

**Expand query** to also fetch `price_per_session`, `location_id` on slots (already have `max_participants`, `location_id`). Add `price_per_session` to the `SlotWithBookings` type.

**Expand rename dialog → "Edit Cycle" dialog** with additional fields:
- `cyclus_name` (existing)
- `price_per_session` (number input, €)
- `location_id` (Select dropdown, fetched from trainer's locations)
- `max_participants` (number input)

Pre-fill from first slot in the cycle. On save, bulk-update all slots with matching `cyclus_id`. Show warning: "Changes apply to all X sessions in this cycle."

**Add location query**: fetch trainer's locations for the dropdown (reuse pattern from AddSlotDialog).

**State changes**: Replace single `renameCycleName` state with a `cycleEditData` object holding all four fields.

### 2. Translation keys (`en/trainer.json`, `nl/trainer.json`)

Add under `scheduleOverview`:
- `editCycleTitle`: "Edit Cycle" / "Cyclus bewerken"
- `bulkWarning`: "Changes apply to all {{count}} sessions in this cycle." / "Wijzigingen gelden voor alle {{count}} sessies in deze cyclus."
- `pricePerSession`: "Price per session" / "Prijs per sessie"
- `maxPlayers`: "Max players" / "Max spelers"
- `location`: "Location" / "Locatie"
- `selectLocation`: "Select location" / "Selecteer locatie"

## Files
- `src/pages/TrainerScheduleOverview.tsx` — Expand edit dialog with bulk fields
- `src/i18n/locales/en/trainer.json` — Add translation keys
- `src/i18n/locales/nl/trainer.json` — Add translation keys

