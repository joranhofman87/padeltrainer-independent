
## Allow Academy Owner to Click Calendar to Add Slots

### Overview
Currently, the academy calendar displays slots but empty cells are not interactive. The trainer calendar allows clicking empty time slots to open a dialog for creating new slots. We'll bring this same click-to-add functionality to the academy calendar.

### Changes

**1. Add cell click handling to the academy calendar grid (AcademyCalendar.tsx)**

- Add `onCellClick` behavior to empty desktop grid cells: cursor pointer, hover state, and a "+" icon overlay (matching the trainer calendar pattern)
- Add the same behavior for the mobile view (empty time slots become clickable)
- Track `isPast` for each cell to prevent clicking on past time slots

**2. Add slot creation dialog states**

- Add state for `SlotTypeChoiceDialog` (single slot vs cyclus choice)
- Add state for `AddSlotDialog` (single slot creation)
- Add state for `BulkCreateSheet` (cyclus/recurring creation)
- Track `defaultSlotDate` and `defaultSlotTime` from the clicked cell

**3. Add trainer selection step**

Since the academy manages multiple trainers, when clicking an empty cell:
- If a trainer filter is already selected (not "all"), use that trainer automatically
- If "all trainers" is selected, the `AddSlotDialog` will require the academy owner to pick a trainer -- we'll pre-filter the lessons based on the selected trainer

**4. Wire up the dialogs**

Import and render:
- `SlotTypeChoiceDialog` -- asks "Single slot or Cyclus?"
- `AddSlotDialog` -- for creating individual slots (with trainer ID)
- `BulkCreateSheet` -- for creating recurring slots

After slot creation, call `fetchSlots()` to refresh the calendar.

**5. Add header buttons**

Add "Slot Toevoegen" (Add Slot) and "Cyclus Dupliceren" (Duplicate Cyclus) buttons to the header bar alongside the existing "Cyclus Aanmaken" button, matching the trainer calendar header.

### Technical Details

**File: `src/pages/academy/AcademyCalendar.tsx`**

New state variables:
```typescript
const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
const [addSlotOpen, setAddSlotOpen] = useState(false);
const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
const [defaultSlotDate, setDefaultSlotDate] = useState<Date>();
const [defaultSlotTime, setDefaultSlotTime] = useState<string>();
const [selectedSlotTrainerId, setSelectedSlotTrainerId] = useState<string | null>(null);
```

Cell click handler:
```typescript
const handleCellClick = (day: Date, hour: number) => {
  setDefaultSlotDate(day);
  setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
  // Use filtered trainer if one is selected, otherwise first trainer
  const trainerToUse = selectedTrainerId !== "all" ? selectedTrainerId : null;
  setSelectedSlotTrainerId(trainerToUse);
  setSlotTypeChoiceOpen(true);
};
```

Desktop grid cell update -- add to empty, non-past cells:
```typescript
className={cn(
  "border-l p-1 min-h-[48px] group relative",
  isToday(day) && "bg-primary/5",
  isPast && "bg-muted/20",
  !isPast && slotsInCell.length === 0 && "cursor-pointer hover:bg-muted/50"
)}
onClick={() => {
  if (!isPast && slotsInCell.length === 0) handleCellClick(day, hour);
}}
```

Plus icon overlay on hover (matching trainer calendar):
```tsx
{!isPast && slotsInCell.length === 0 && (
  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
    <div className="bg-primary/10 rounded-md p-2">
      <Plus className="h-4 w-4 text-primary" />
    </div>
  </div>
)}
```

New imports:
```typescript
import { SlotTypeChoiceDialog } from "@/components/trainer/SlotTypeChoiceDialog";
import { AddSlotDialog, BulkCreateSheet } from "@/components/trainer/AddSlotDialog";
import { DuplicateCyclusDialog } from "@/components/trainer/DuplicateCyclusDialog";
```

Render dialogs at the bottom, passing the appropriate trainer ID and filtered lessons.
