-- Data Cleanup Migration: Remove orphaned test data
-- Step 1: Delete bookings associated with past availability slots
DELETE FROM bookings 
WHERE slot_id IN (
  SELECT id FROM availability_slots WHERE end_time < now()
);

-- Step 2: Delete past availability slots
DELETE FROM availability_slots 
WHERE end_time < now();

-- Step 3: Delete orphaned auth users (no profiles, no roles)
-- User: dfaaf@kljdsalkjadsf.com
DELETE FROM auth.users WHERE id = '84f870ae-db4f-4513-95ea-578d91301c65';

-- User: ljdskaslfs@club.com  
DELETE FROM auth.users WHERE id = 'efcf1556-0d73-4a5d-8d3c-40f0f8ebe2ec';