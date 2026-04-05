

# Warnings Section + Birth Dates on Slot Detail Page

## What changes

### 1. Database migration
Add a `dismissed_slot_warnings` table to persist which warnings have been dismissed per slot:
```sql
create table public.dismissed_slot_warnings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid references availability_slots(id) on delete cascade not null,
  warning_type text not null, -- 'rating_spread' or 'age_diff'
  dismissed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.dismissed_slot_warnings enable row level security;
-- unique constraint so same warning can't be dismissed twice
alter table public.dismissed_slot_warnings add unique (slot_id, warning_type);
```
RLS: academy managers can select/insert/delete.

### 2. `src/pages/academy/AcademySlotDetail.tsx`

**Fetch birth dates alongside bookings**
- Add `birth_date` to the profiles and guest_players select in the bookings query
- Map `birthDate` onto each `BookedPlayer` object

**Fetch academy warning thresholds**
- Query `academy_profiles` for `warning_max_rating_spread` and `warning_max_age_diff_years`

**Fetch dismissed warnings for this slot**
- Query `dismissed_slot_warnings` for this slot ID

**Show age next to each player in the player list**
- Below the rating line, show calculated age from `birthDate` (e.g. "14 yr")

**Add a Warnings card (between detail cards and players card)**
- Compute rating spread and age spread among booked players
- If thresholds are set and exceeded, and not dismissed, show an amber `Alert` with:
  - Icon: `AlertTriangle`
  - Description: e.g. "Rating spread: 3.2 points (max 2.0)" or "Age difference: 8 years (max 5)"
  - A "Dismiss" button per warning (inserts into `dismissed_slot_warnings`)
  - A link to Settings page: "Configure warning thresholds →"
- If all warnings are dismissed or none triggered, the card is hidden

### 3. Warning calculation helper
Reuse the same logic from the overview:
```typescript
function calculateAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / 31557600000);
}
```
Compute spreads, compare against thresholds, filter out dismissed types.

## File summary

| File | Change |
|------|--------|
| Migration SQL | Create `dismissed_slot_warnings` table with RLS |
| `src/pages/academy/AcademySlotDetail.tsx` | Fetch birth dates + thresholds + dismissed warnings; show age per player; add warnings section with dismiss + settings link |

