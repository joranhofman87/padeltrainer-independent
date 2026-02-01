

# Fix Mispositioned "No Slots Planned" Message

## Problem
The "Geen slots gepland deze week" (No slots planned this week) empty state message is incorrectly positioned. It overlaps with the calendar header row (day columns) instead of being properly centered within the calendar grid area.

## Root Cause
In `TrainerCalendarGrid.tsx` lines 269-276, the empty state uses `absolute inset-0` positioning, but:
1. It's a child of the `min-w-[800px]` container, not the `relative` Time Grid div
2. There's no `relative` positioning on the parent container
3. The `inset-0` causes it to position relative to the nearest positioned ancestor, which may be further up the DOM

## Solution
Move the empty state message to be positioned relative to the Time Grid container, and adjust the positioning so it appears centered within the time slot area (below the header row).

## Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/trainer/TrainerCalendarGrid.tsx` | Modify | Fix empty state positioning to be relative to the time grid |

## Implementation Details

### Current Code (lines 210-277):

```tsx
{/* Time Grid */}
<div className="relative">
  {HOURS.map((hour) => (
    // ... hour rows
  ))}
</div>

{/* Empty State - WRONG: outside relative container */}
{slots.length === 0 && (
  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
    <div className="text-center text-muted-foreground p-8 bg-background/80 rounded-lg">
      {t("calendar.noSlotsThisWeek")}
    </div>
  </div>
)}
```

### Fixed Code:

```tsx
{/* Time Grid */}
<div className="relative">
  {HOURS.map((hour) => (
    // ... hour rows
  ))}
  
  {/* Empty State - CORRECT: inside relative container */}
  {slots.length === 0 && (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="text-center text-muted-foreground p-8 bg-background/80 rounded-lg">
        {t("calendar.noSlotsThisWeek")}
      </div>
    </div>
  )}
</div>
```

## Visual Before vs After

**Before (broken):**
```
+----------------------------------+
| [Header Row with Days]           |
|   Mon  T[MESSAGE OVERLAPS]  Thu  |  ← Message overlaps header
|    26   27     28           29   |
+----------------------------------+
| 08:00 |    |    |    |    |      |
| 09:00 |    |    |    |    |      |
```

**After (fixed):**
```
+----------------------------------+
| [Header Row with Days]           |
|   Mon   Tue   Wed   Thu   Fri    |
|    26    27    28    29    30    |
+----------------------------------+
| 08:00 |    |    |    |    |      |
| 09:00 |  [No slots this week]    |  ← Message centered in grid
| 10:00 |    |    |    |    |      |
```

## File Changes

**`src/components/trainer/TrainerCalendarGrid.tsx`**
- Move the empty state `{slots.length === 0 && ...}` block (lines 269-276) to be **inside** the Time Grid `<div className="relative">` container (before its closing `</div>` at line 267)

