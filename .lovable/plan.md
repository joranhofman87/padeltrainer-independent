

# Fix: Delete-user function doesn't clean up cycles

## Problem
When a user is deleted via the admin `delete-user` edge function, their **cycles** (registrations/events) are not cleaned up. This leaves orphaned cycle records with `status: open` that still appear on location pages.

The "Voorjaar 2026" cycle (`fc800a92...`) is an example — its owner trainer profile is gone but the cycle persists.

## Fix

Two changes needed:

### 1. Clean up the orphaned cycle now
Delete the specific orphaned cycle `fc800a92-c340-4135-a07e-b07108c56da6` and its related `intake_requests` via a database migration.

### 2. Update `delete-user` edge function
Add cycle cleanup to the trainer and academy/club deletion sections:

- **Trainer block** (after getting `trainerProfile.id`): Delete `intake_requests` where `cycle_id` matches any cycle owned by this trainer, then delete cycles where `owner_type = 'trainer'` and `owner_id = trainerProfile.id`.
- **Before deleting profiles**: Also delete cycles where `owner_type = 'club'` or `owner_type = 'academy'` owned by any club/academy profiles this user created (already handled via `created_by: null` updates, but cycles remain).

### Files changed
- `supabase/functions/delete-user/index.ts` — add cycle + intake_requests cleanup
- 1 database migration — remove the orphaned "Voorjaar 2026" cycle

