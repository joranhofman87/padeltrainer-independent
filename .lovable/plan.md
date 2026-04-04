

# Backfill: Replicate Week 1 Slots & Bookings Across Full Cycle

## Summary
The "Padeltrainingen zomer 2026" cycle has 23 slots in week 1 (Apr 8-14) with 73 confirmed bookings. The cycle runs until Jul 14. We need to clone these slots and bookings for weeks 2-14 (13 additional weeks).

## What the script will do

1. **Clone 23 slots × 13 weeks = ~299 new availability_slots**
   - Same trainer, location, max_participants, cyclus_id, and all other properties
   - Shift `start_time` and `end_time` by +7, +14, ... +91 days
   - Skip if a slot already exists at that exact start_time + trainer (idempotent)

2. **Clone 73 bookings × 13 weeks = ~949 new bookings**
   - For each original booking, create a matching booking on the corresponding new weekly slot
   - Same guest_player_id, status (confirmed), payment_status (pending)

3. **Clone 73 proposed_assignments × 13 weeks = ~949 new proposed_assignments**
   - Same intake_request_id, trainer_id, confidence_score, status (confirmed)
   - Point to the new slot IDs

## Approach
- Python script using psycopg2 (pg env vars already set)
- One-time data backfill, fully idempotent
- No code changes needed — the calendar UI will automatically show all new slots

## Data verified
- Cycle ID: `1e40f602-21eb-4ef1-ae31-f1616897f4c8`
- End date: `2026-07-14`
- 23 source slots (Apr 8-14), 73 bookings, 73 assignments
- All bookings use `guest_player_id` (no `player_id`)
- All bookings are `confirmed` / `payment_status = pending`

