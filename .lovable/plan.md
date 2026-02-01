

# Update Trainer Dashboard: Remove Obsolete Cards & Embed Full Calendar

## Overview
Simplify the trainer dashboard by removing the redundant quick action cards and replacing the mini-calendar widget with the full-featured calendar from `/trainer/calendar`. This makes the agenda and slot creation the central focus for trainers.

## Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/pages/TrainerDashboard.tsx` | Modify | Remove quick action cards; embed full calendar with all dialogs |
| `src/components/trainer/DashboardCalendar.tsx` | Delete | No longer needed (replaced by inline full calendar) |

## Current Dashboard Structure

```text
+-----------------------------------+
| Trial Banner (conditional)        |
+-----------------------------------+
| Setup Checklist (conditional)     |
+-----------------------------------+
| Stats Cards (5 cards row)         |  <- KEEP
+-----------------------------------+
| Quick Action Cards (5 cards)      |  <- REMOVE
| - My Lessons                      |
| - My Calendar                     |
| - Bookings                        |
| - My Profile                      |
| - Registration Cycles             |
+-----------------------------------+
| DashboardCalendar (mini widget)   |  <- REPLACE
+-----------------------------------+
```

## New Dashboard Structure

```text
+-----------------------------------+
| Trial Banner (conditional)        |
+-----------------------------------+
| Setup Checklist (conditional)     |
+-----------------------------------+
| Stats Cards (5 cards row)         |
+-----------------------------------+
| Full Calendar Section             |
| +-------------------------------+ |
| | Action Bar                    | |
| | [+Slot] [Duplicate] [Cyclus]  | |
| +-------------------------------+ |
| | Controls Card                 | |
| | Nav | Date Range | View Toggle| |
| | Legend (available/pending/etc)| |
| +-------------------------------+ |
| | Calendar Grid Card            | |
| | TrainerCalendarGrid component | |
| +-------------------------------+ |
+-----------------------------------+
| All Dialogs (same as calendar pg) |
+-----------------------------------+
```

## Implementation Details

### 1. Remove Quick Action Cards

Delete lines 396-491 (the entire `grid md:grid-cols-2 lg:grid-cols-5` block with 5 navigation cards):
- My Lessons
- My Calendar  
- Bookings
- My Profile
- Registration Cycles

These are now accessible from the sidebar.

### 2. Replace DashboardCalendar with Full Calendar

Import and integrate the same components used in `TrainerCalendar.tsx`:

```tsx
// New imports
import { TrainerCalendarGrid } from "@/components/trainer/TrainerCalendarGrid";
import { SlotWithBookings, BookedPlayer } from "@/components/trainer/CalendarSlotCard";
import { AddSlotDialog, BulkCreateSheet } from "@/components/trainer/AddSlotDialog";
import { SlotTypeChoiceDialog } from "@/components/trainer/SlotTypeChoiceDialog";
import { BookForPlayerDialog } from "@/components/trainer/BookForPlayerDialog";
import { DuplicateCyclusDialog } from "@/components/trainer/DuplicateCyclusDialog";
import { DeleteSlotDialog } from "@/components/trainer/DeleteSlotDialog";
import { EditBookingDialog } from "@/components/trainer/EditBookingDialog";
```

### 3. Add Calendar State Management

Add all the calendar-related state variables:

```tsx
// View and navigation
const [view, setView] = useState<"day" | "week" | "month">("week");
const [currentDate, setCurrentDate] = useState(new Date());
const [calendarSlots, setCalendarSlots] = useState<SlotWithBookings[]>([]);
const [calendarLoading, setCalendarLoading] = useState(true);
const [lessons, setLessons] = useState<Lesson[]>([]);
const [settings, setSettings] = useState<ScheduleSettings>({...});

// Dialog states
const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
const [addSlotOpen, setAddSlotOpen] = useState(false);
const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
const [duplicateCyclusOpen, setDuplicateCyclusOpen] = useState(false);
const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
const [editBookingOpen, setEditBookingOpen] = useState(false);
// ... selected slot, booking to edit, etc.
```

### 4. Calendar Data Fetching

Add `fetchCalendarSlots()` function that:
- Fetches slots with lessons, bookings, player info, and location names
- Calculates date range based on view (day/week/month)
- Transforms data to `SlotWithBookings[]` format

### 5. Calendar UI Section

Replace the `<DashboardCalendar>` component with:

```tsx
{/* Calendar Section */}
<div className="space-y-4">
  {/* Action Buttons */}
  <div className="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" onClick={() => setAddSlotOpen(true)}>
      <Plus className="h-4 w-4 mr-2" />
      {t("calendar.addSlot")}
    </Button>
    <Button variant="outline" size="sm" onClick={() => setDuplicateCyclusOpen(true)}>
      <Copy className="h-4 w-4 mr-2" />
      {t("calendar.duplicateCyclus")}
    </Button>
    <Button size="sm" onClick={() => setBulkCreateOpen(true)}>
      <Repeat className="h-4 w-4 mr-2" />
      {t("calendar.createCyclus")}
    </Button>
  </div>

  {/* Controls Card */}
  <Card>
    <CardContent className="p-4">
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        {/* Date Navigation */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={navigatePrevious}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-[120px] sm:min-w-[200px] text-center font-medium">
            {getDateRangeLabel()}
          </div>
          <Button variant="outline" size="icon" onClick={navigateNext}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={goToToday}>
            {t("calendar.today")}
          </Button>
        </div>

        {/* View Toggle */}
        <div className="flex items-center gap-1">
          <Button variant={view === "day" ? "default" : "outline"} size="sm" onClick={() => setView("day")}>
            {t("calendar.dayView")}
          </Button>
          <Button variant={view === "week" ? "default" : "outline"} size="sm" onClick={() => setView("week")}>
            {t("calendar.weekView")}
          </Button>
          <Button variant={view === "month" ? "default" : "outline"} size="sm" onClick={() => setView("month")}>
            {t("calendar.monthView")}
          </Button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-muted border" />
          <span className="text-sm">{t("calendar.available")}: {freeSlots}</span>
        </div>
        {/* ... pending, booked stats */}
      </div>
    </CardContent>
  </Card>

  {/* Calendar Grid */}
  <Card>
    <CardContent className="p-4">
      {calendarLoading ? (
        <Skeleton className="h-[500px] w-full" />
      ) : (
        <TrainerCalendarGrid
          slots={calendarSlots}
          currentDate={currentDate}
          view={view}
          onCellClick={handleCellClick}
          onBookForPlayer={handleBookForPlayer}
          onDuplicateCyclus={handleDuplicateCyclus}
          onDeleteSlot={handleDeleteSlot}
          onEditBooking={handleEditBooking}
          onToggleMarkedFull={handleToggleMarkedFull}
          onNavigatePrevious={navigatePrevious}
          onNavigateNext={navigateNext}
        />
      )}
    </CardContent>
  </Card>
</div>

{/* All Dialog Components */}
<SlotTypeChoiceDialog ... />
<AddSlotDialog ... />
<BulkCreateSheet ... />
<BookForPlayerDialog ... />
<DuplicateCyclusDialog ... />
<DeleteSlotDialog ... />
<EditBookingDialog ... />
```

### 6. Add Handler Functions

Copy all handler functions from `TrainerCalendar.tsx`:
- `handleCellClick` - Opens slot type choice dialog
- `handleChooseSingleSlot` / `handleChooseCyclus`
- `handleBookForPlayer` - Book a player into a slot
- `handleDuplicateCyclus` - Duplicate an existing cyclus
- `handleDeleteSlot` - Delete a slot
- `handleEditBooking` - Edit a booking
- `handleToggleMarkedFull` - Mark slot as private/full
- `navigatePrevious` / `navigateNext` / `goToToday`
- `getDateRangeLabel`

### 7. Clean Up DashboardCalendar

Delete `src/components/trainer/DashboardCalendar.tsx` as it's no longer used.

## Data Flow

```text
User loads /trainer (Dashboard)
    |
    v
fetchStats() + fetchSetupStatus() + fetchCalendarSlots()
    |
    v
Render: Stats Cards + Full Calendar
    |
    +---> Click cell -> SlotTypeChoiceDialog
    |         |
    |         +---> Single Slot -> AddSlotDialog
    |         +---> Cyclus -> BulkCreateSheet
    |
    +---> Click slot -> CalendarSlotCard actions
              |
              +---> Book player -> BookForPlayerDialog
              +---> Edit booking -> EditBookingDialog
              +---> Delete slot -> DeleteSlotDialog
              +---> Duplicate cyclus -> DuplicateCyclusDialog
```

## File Impact

- **Modified**: `src/pages/TrainerDashboard.tsx` (major refactor)
- **Deleted**: `src/components/trainer/DashboardCalendar.tsx`

## Result

After implementation:
- Dashboard is cleaner with just stats + full calendar
- All calendar functionality available directly on dashboard
- Trainers can add slots, create cycluses, manage bookings without leaving dashboard
- Sidebar handles all other navigation needs

