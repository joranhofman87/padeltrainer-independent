

# Add Extra Costs to Academy Open Slots

## Problem
The open slots section only shows `price_per_session` and `total_price` from the database. Extra costs (stored as JSON array `[{description, price}]` on `availability_slots.extra_costs`) are not fetched or displayed.

## Changes in `src/components/academy/AcademyPublicOpenSlots.tsx`

### 1. Data
- Add `extra_costs` to the `availability_slots` select query
- Add `extra_costs: { description: string; price: number }[]` to `SlotData` interface
- Map `extra_costs` from slot data (parse JSON, default to `[]`)

### 2. UI — Price section (right side of each slot row)
Display pricing as a small breakdown:
- **Session price**: `€X.XX /session` (existing)
- **Each extra cost**: listed below as `+ €X.XX description` in smaller muted text
- **Total per session**: session + sum of extra costs, shown as bold total when extras exist
- **Cyclus total**: for cyclus slots, show `Total: €X.XX` (number of sessions × per-session total)

Example rendering:
```
€15.00 /session
+ €5.00 Ball costs
+ €10.00 Court rental
―――――――
€30.00 /session total
Total: €300.00 (cyclus)
```

### Files
- `src/components/academy/AcademyPublicOpenSlots.tsx` — query, interface, and UI updates

