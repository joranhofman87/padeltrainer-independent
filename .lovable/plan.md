

# Slot Detail Page + Fix Edit Crash

## Root Cause of the Error
The `EditSlotDialog` crashes because of `<SelectItem value="">` on line 334 (the "No location" option). Radix Select does not allow empty string values — it throws "A `<Select.Item />` must have a value prop that is not an empty string", which cascades into the crash.

## Your Question: Dedicated Page vs Dialogs

**Yes, a dedicated slot detail page is the right long-term approach.** Here's why:

- **Dialogs are fragile** — they rely on complex state passing between parent and child, and cascading open/close states across 4+ dialogs (Detail → Edit → Booking → Delete) cause exactly these kinds of crashes
- **URL-based routing is more robust** — clicking a slot navigates to `/app/academy/slot/:id`, which fetches its own data. No state to pass, no dialog chains
- **Scales with bookings** — a full page can show more info (full player list, booking history, payment status) without cramming it into a modal
- **Consistent entry point** — whether you click from Overview, Manage, Open Spots, or even the Club calendar, it's the same page

## Changes

### 1. `src/pages/academy/AcademySlotDetail.tsx` — **New page**
A full page at `/app/academy/slot/:slotId` that:
- Fetches slot data by ID (date/time, trainer, location, cyclus, capacity, privacy, pricing, rating range)
- Shows booked players with status badges and edit buttons
- Has action buttons: Edit details (inline form, not dialog), Add player, Mark private, Delete
- Edit mode: toggle inline editing of all slot fields (trainer, location, time, capacity, rating, privacy)
- "Apply to cyclus" checkbox when editing cyclus slots
- Back button returns to previous page

### 2. `src/pages/academy/AcademyCalendar.tsx` — Simplify
- Replace `handleSlotClick` / `onSlotClick` to navigate: `navigate(\`/app/academy/slot/\${slotId}\`)`
- Remove `EditSlotDialog`, `SlotDetailDialog`, and `EditBookingDialog` imports and state — they move to the slot page
- Keep `DeleteSlotDialog` and `BookForPlayerDialog` as lightweight confirms (or move those too)

### 3. `src/components/academy/AcademyCalendarOverview.tsx` — Update click handler
- `onSlotClick` now calls `navigate` instead of opening a dialog

### 4. `src/App.tsx` — Add route
- Add `/app/academy/slot/:slotId` → `AcademySlotDetail`

### 5. Fix the immediate `<SelectItem value="">` crash
- In `EditSlotDialog.tsx` (kept for trainer calendar usage): change `value=""` to `value="none"` and handle "none" → `null` in the save logic

### 6. `src/pages/club/ClubCalendar.tsx` — Optional
- Can also route to the same slot detail page, or keep its existing `ClubSlotDetailSheet` for now

## Page Layout (AcademySlotDetail)

```text
┌─────────────────────────────────────────┐
│ ← Back to Calendar                      │
├─────────────────────────────────────────┤
│ Wednesday 9 April 2026                  │
│ 09:00 – 10:00  ·  Trainer Name  ·  📍  │
│                                         │
│ ┌─────────────┐ ┌──────────────────────┐│
│ │ Details     │ │ Players (2/4)        ││
│ │ Trainer: .. │ │ • Jan (confirmed) ✏️  ││
│ │ Location: . │ │ • Piet (pending)  ✏️  ││
│ │ Level: 3-5  │ │                      ││
│ │ Price: €25  │ │ [+ Add Player]       ││
│ │ Private: 🔒 │ │                      ││
│ │ Cyclus: ... │ │                      ││
│ │             │ │                      ││
│ │ [Edit] [Del]│ │                      ││
│ └─────────────┘ └──────────────────────┘│
└─────────────────────────────────────────┘
```

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | **New** — Full slot detail/edit page |
| `src/pages/academy/AcademyCalendar.tsx` | Replace dialog-based slot actions with `navigate()`, remove dialog state |
| `src/components/academy/AcademyCalendarOverview.tsx` | Update `onSlotClick` to use navigation |
| `src/App.tsx` | Add route `/app/academy/slot/:slotId` |
| `src/components/trainer/EditSlotDialog.tsx` | Fix `<SelectItem value="">` → `value="none"` |

