

# Constrain Player Time Selection to Trainer-Defined Windows

## Problem
When `allowedDays` is set, players can still select any time from 06:00–00:00. If the trainer says training is available 14:00–22:00, the player should only be able to pick times **within** that range (e.g. 18:00–21:00), not outside it (e.g. 23:00).

Additionally, re-toggling a day resets to hardcoded 09:00–17:00 instead of the trainer's defined window.

## Changes

### File: `src/components/cycles/DayAvailabilityPicker.tsx`

1. **Fix `toggleDay`**: When `allowedDays` is provided, re-enabling a day uses `allowedDays[day]` blocks instead of `09:00–17:00`.

2. **Constrain time dropdowns**: When `allowedDays` is set, compute the min/max allowed times for each day from the `allowedDays` blocks. Filter `TIME_OPTIONS` in the start/end `<Select>` to only show times within the allowed window (e.g. if allowed is 14:00–22:00, start dropdown shows 14:00–21:30, end dropdown shows 14:30–22:00).

3. **Constrain "Add time block"**: New blocks default to times within the allowed range. Hide the add button if the player already covers the full allowed range or there's no room for another block.

4. **Show allowed range hint**: Display a small text under each day like "Available: 14:00 – 22:00" so the player knows the window.

### Technical detail
- Helper function: `getTimeRange(day, allowedDays)` returns the earliest start and latest end from `allowedDays[day]` blocks
- Filter start options: times >= range start and < range end
- Filter end options: times > selected start and <= range end
- `toggleDay` default: use `allowedDays[day]` when available

