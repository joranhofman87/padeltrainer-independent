# Slots / Cycles data-health checks (read-only)

Run these **read-only** queries in the Supabase SQL editor (production, project `ficwbdrzefmblkbkomzw`)
before the slots/cycles cleanup. They size the problems the cleanup must fix; none of them mutate
data. Capture the row counts — they gate Phase 1 (orphan repair) and serve as the before/after
data-preservation baseline.

Background: `availability_slots.cyclus_id` has no foreign key to `cycles.id` (only an index), so a
slot can point at a `cycles` row that doesn't exist → an **orphan slot group** that the academy
overview renders as a "cycle". These checks find those + related date/price mismatches.

## 1. Orphan recurring slot groups (a `cyclus_id` with no matching `cycles` row)
```sql
select
  s.cyclus_id,
  min(s.cyclus_name) as cyclus_name,
  count(*) as slots,
  min(s.start_time) as first_slot,
  max(s.start_time) as last_slot,
  count(b.id) filter (where b.status <> 'cancelled') as active_bookings
from public.availability_slots s
left join public.cycles c on c.id = s.cyclus_id
left join public.bookings b on b.slot_id = s.id
where s.cyclus_id is not null
  and c.id is null
group by s.cyclus_id
order by active_bookings desc, slots desc;
```
→ Each row is an orphan group to backfill into a real `cycles(type='cyclus')` row (Phase 1).
`active_bookings > 0` means real players are attached — repair, never delete.

## 2. Slots outside their cycle's date range
```sql
select
  c.id, c.name, c.type, c.start_date, c.end_date,
  count(s.id) as out_of_range_slots
from public.cycles c
join public.availability_slots s on s.cyclus_id = c.id
where c.start_date is not null
  and c.end_date is not null
  and (s.start_time::date < c.start_date or s.start_time::date > c.end_date)
group by c.id, c.name, c.type, c.start_date, c.end_date
order by out_of_range_slots desc;
```

## 3. Training cycles whose stored dates ≠ their actual first/last session
```sql
select
  c.id, c.name, c.type, c.status, c.start_date, c.end_date,
  min(s.start_time)::date as actual_first_slot,
  max(s.start_time)::date as actual_last_slot,
  count(s.id) as slots
from public.cycles c
left join public.availability_slots s on s.cyclus_id = c.id
where c.type = 'cyclus'
group by c.id, c.name, c.type, c.status, c.start_date, c.end_date
having c.start_date is distinct from min(s.start_time)::date
    or c.end_date is distinct from max(s.start_time)::date
order by actual_last_slot desc nulls last;
```
→ Feeds the Phase 1 date-normalization (cycle dates = first/last actual session).

## 4. Registration cycles that already have slots / bookings
```sql
select
  c.id, c.name, c.status,
  count(distinct ir.id) as intake_requests,
  count(distinct s.id) as slots,
  count(distinct b.id) filter (where b.status <> 'cancelled') as active_bookings
from public.cycles c
left join public.intake_requests ir on ir.cycle_id = c.id
left join public.availability_slots s on s.cyclus_id = c.id
left join public.bookings b on b.slot_id = s.id
where c.type = 'registration'
group by c.id, c.name, c.status
having count(distinct s.id) > 0 or count(distinct b.id) > 0
order by active_bookings desc, slots desc;
```
→ These are registrations that have been finalized into real sessions; in Phase 2 their booked
sessions re-point to a real `cycles(type='cyclus')` row (the registration stays the intake campaign).

## Data-preservation baseline (capture before any migration)
```sql
select
  (select count(*) from public.cycles)              as cycles,
  (select count(*) from public.intake_requests)     as intake_requests,
  (select count(*) from public.availability_slots)  as availability_slots,
  (select count(*) from public.bookings)            as bookings,
  (select count(*) from public.invoices)            as invoices;
```
→ After each migration phase these counts must be **≥** the baseline (non-destructive rule).
