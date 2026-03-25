

# Wipe Bookings, Invoices & Slots for RL Padel Performance

## Summary
Delete all bookings, invoices, and availability slots for trainer `c0497580-1e4e-4376-93d1-5b90e9d7ca1d`. **Keep guest players intact.**

## Execution order (respecting FK constraints)
1. Delete `invoices` (53 records) — `trainer_id = ...`
2. Delete `bookings` (947 records) — via `slot_id` in availability_slots for this trainer
3. Delete `availability_slots` (605 records) — `trainer_id = ...`

Three DELETE statements using the insert tool. No schema changes needed.

