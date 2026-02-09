

## Unify Calendar Grid Across Roles

### Current State

There are 3 separate calendar implementations:

- **TrainerCalendar** (681 lines) -- uses the shared `TrainerCalendarGrid` component with `CalendarSlotCard` popovers. Supports day/week/month views. Single trainer, no trainer filter.
- **AcademyCalendar** (795 lines) -- has its own inline week grid (~150 lines of copy-pasted HTML). Shows trainer name/avatar and location per slot. Has trainer + location filters.
- **ClubCalendar** (564 lines) -- has its own inline week grid (~150 lines of copy-pasted HTML). Shows trainer name/avatar per slot. Has trainer filter. Uses a separate `ClubSlotDetailSheet` for slot details.

The desktop week grid (header + time rows + slot cards), mobile day view, slot color logic, and navigation (prev/next week, today button) are nearly identical across all three.

### What's Different Per Role

| Feature | Trainer | Club | Academy |
|---------|---------|------|---------|
| Trainer filter | No (single user) | Yes | Yes |
| Location filter | No | No (single location) | Yes |
| Slot card shows trainer name | No | Yes | Yes |
| Slot card shows location | Yes | No | Yes |
| Slot detail interaction | Popover (CalendarSlotCard) | Sheet (ClubSlotDetailSheet) | None (no detail view) |
| View modes | Day/Week/Month | Week only | Day/Week/Month |
| Data fetching | Own trainer's slots | Club trainer slots | Academy trainer slots |
| Slot spanning (multi-hour) | Yes | No | No |

### Plan

#### Step 1: Extend `TrainerCalendarGrid` to support multi-trainer mode

Add optional props to the existing `TrainerCalendarGrid`:

```text
interface CalendarGridProps {
  // Existing props stay the same
  slots: SlotWithBookings[];
  currentDate: Date;
  view: "day" | "week" | "month";
  onCellClick?: (date: Date, hour: number) => void;
  ...

  // NEW: Multi-trainer mode props
  showTrainerInfo?: boolean;          // Show trainer name/avatar on slot cards
  showLocationInfo?: boolean;         // Show location on slot cards  
  renderSlotCard?: (slot) => ReactNode; // Custom slot card renderer (optional)
  onSlotClick?: (slot) => void;       // For club's sheet-based detail view
}
```

This lets club/academy pages pass `showTrainerInfo={true}` and get trainer names on slots, while the trainer page keeps the existing behavior.

#### Step 2: Extend `SlotWithBookings` interface

Add optional fields to the existing `SlotWithBookings` type in `CalendarSlotCard.tsx`:

```typescript
export interface SlotWithBookings {
  // ... existing fields
  trainer_name?: string;    // NEW
  trainer_avatar?: string;  // NEW
}
```

#### Step 3: Update `CalendarSlotCard` to optionally show trainer info

When `showTrainerInfo` is true, display the trainer name/avatar inside the slot card. This is a small addition to the existing component.

#### Step 4: Refactor `ClubCalendar.tsx`

- Remove the ~200 lines of inline grid HTML (mobile view + desktop grid + legend)
- Import and use `TrainerCalendarGrid` with `showTrainerInfo={true}`
- Keep the club-specific: data fetching, trainer filter dropdown, `ClubSlotDetailSheet`, and the Add Slot / Create Cyclus buttons
- Map `ClubSlot` data to `SlotWithBookings` format

**Estimated reduction: ~200 lines removed, ~20 lines added for the mapping**

#### Step 5: Refactor `AcademyCalendar.tsx`

- Remove the ~200 lines of inline grid HTML (mobile view + desktop grid + legend)
- Import and use `TrainerCalendarGrid` with `showTrainerInfo={true}` and `showLocationInfo={true}`
- Keep the academy-specific: data fetching, trainer + location filters, slot creation dialogs, stats section
- Map `AcademySlot` data to `SlotWithBookings` format

**Estimated reduction: ~200 lines removed, ~20 lines added**

#### Step 6: Add slot spanning support for all roles

Currently only the trainer grid supports multi-hour slot rendering (slots that visually span multiple rows). This will now automatically work for club and academy calendars too since they'll use the same grid.

### What Stays Role-Specific

- **Data fetching logic** -- each role fetches differently (own slots vs. all trainers' slots)
- **Filter dropdowns** -- trainer filter (club/academy), location filter (academy only)
- **Page header and action buttons** -- each role has different CTAs
- **Slot detail interaction** -- club keeps its Sheet, trainer keeps its Popover via CalendarSlotCard

### Impact

- ~400 lines of duplicated grid code removed across ClubCalendar + AcademyCalendar
- Single source of truth for the calendar grid, slot colors, and time layout
- Bug fixes and improvements (like slot spanning) automatically apply to all roles
- No visual changes for users

