

## Bundle Cyclus Bookings and Spots on Dashboard

### What changes

**Recent Bookings** tables (trainer + academy): Currently show individual booking rows. Will be enhanced to include the cyclus name and payment status, and group cyclus bookings into a single summary row per player-per-cyclus.

**Upcoming Open Spots** tables (trainer + academy): Currently show individual slot rows. Will group slots belonging to the same cyclus into a single summary row showing the cyclus name, number of sessions, and date range.

### Updated columns

**Recent Bookings table:**
| Player | Cyclus | Date | Payment |
|--------|--------|------|---------|
| John | Summer Training | 05 Feb | paid |
| Jane | — | 03 Feb | pending |

- Player name (from profiles or guest_players)
- Cyclus name (from availability_slots.cyclus_name, or "—" for standalone)
- Date (created_at)
- Payment status badge (paid/pending/unpaid)

**Upcoming Open Spots table:**
| Name | Sessions | Next session |
|------|----------|-------------|
| Summer Training | 8 sessions | Mon 10 Feb 09:00 |
| — | 1 session | Wed 12 Feb 14:00 |

- Cyclus name (or "Single session" for standalone slots)
- Number of upcoming sessions
- Next session date/time

### Technical details

**File: `src/pages/TrainerDashboard.tsx`**

1. **Bookings query** (line 76-86): Add `cyclus_name` to the `availability_slots` select:
   ```
   availability_slots!inner (trainer_id, start_time, cyclus_name)
   ```

2. **Bookings rendering** (lines 337-378): Update table columns to 4: Player, Cyclus, Date, Payment. Show `availability_slots.cyclus_name` and `payment_status` badge.

3. **Upcoming Slots query** (lines 99-107): Also fetch `cyclus_id` in the select.

4. **Upcoming Slots rendering** (lines 420-460): After fetching, group slots by `cyclus_id`. Standalone slots (no cyclus_id) remain individual rows. Cyclus slots are collapsed into one row per cyclus showing: name, session count, and next session datetime.

**File: `src/pages/academy/AcademyDashboard.tsx`**

Same changes applied:
1. **Bookings query** (line 88-98): Add `cyclus_name` to availability_slots select.
2. **Bookings rendering** (lines 287-328): 4 columns: Player, Cyclus, Date, Payment.
3. **Upcoming Slots query** (lines 113-120): Add `cyclus_id` to select.
4. **Upcoming Slots rendering** (lines 370-410): Group by cyclus_id, show summary rows for cycles.

**Grouping logic for upcoming slots** (applied in both files after fetching):
```
// Group by cyclus_id
const grouped = [];
const cyclusMap = new Map();
for (const slot of slots) {
  if (slot.cyclus_id) {
    if (!cyclusMap.has(slot.cyclus_id)) {
      cyclusMap.set(slot.cyclus_id, { ...slot, sessionCount: 1 });
      grouped.push(cyclusMap.get(slot.cyclus_id));
    } else {
      cyclusMap.get(slot.cyclus_id).sessionCount++;
    }
  } else {
    grouped.push({ ...slot, sessionCount: 1 });
  }
}
```

### No i18n changes needed
Existing keys cover all new labels (payment status values are already used elsewhere).

