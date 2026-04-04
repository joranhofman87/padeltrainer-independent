

# Add Empty Slots Count + Separate Hours from Empty Slots

## Problem
The reports currently count **all** slots toward "Hours" — including empty ones (0 bookings). The academy needs to see how many empty slots each trainer/location has, and hours should only reflect slots that actually had players.

## Changes

### `src/components/academy/AcademyReportsTab.tsx`

**1. Update stats calculation (line 128-137)**
- Add `emptySlots`: count of slots where `booking_count === 0`
- Change `totalHours` to only sum duration of slots where `booking_count > 0`

**2. Add "Empty Slots" stat card**
- New card between "Open spots" and "Players booked" with an icon (e.g. `CalendarX2` or reuse `AlertTriangle`)
- Shows count of slots with zero bookings

**3. Update trainer rows (line 140-161)**
- Add `emptySlots` count per trainer
- Change `hours` to only sum slots with `booking_count > 0`

**4. Update location rows (line 164-186)**
- Same: add `emptySlots`, filter hours to non-empty slots only

**5. Update all three tables**
- Add "Empty" column to By Trainer and By Location tables (between Sessions and Booked)
- Overview table: add a visual indicator (red text or dash) for rows with 0 bookings

**6. Update CSV export**
- Add "Empty Slots" column to exported data

## Summary of logic change

```
hours = slots.filter(s => s.booking_count > 0)
              .reduce(sum of duration)

emptySlots = slots.filter(s => s.booking_count === 0).length
```

## File summary

| File | Change |
|------|--------|
| `src/components/academy/AcademyReportsTab.tsx` | Add empty slot counts, exclude empty slots from hours, add Empty column to tables and stat card |

