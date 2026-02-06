
# Add "Disconnect Mollie" Button to Admin Panel

## Problem

When a trainer or academy gets stuck in a Mollie connection loop (e.g., the callback fails), the admin currently has no way to reset their Mollie state. The only fix is manual database edits.

## Solution

Add a "Disconnect Mollie" section to the **Settings** tab of both the Trainer and Academy edit dialogs in the admin panel. This will allow admins to clear the Mollie connection data so the user can start fresh.

## What Gets Cleared

**For Trainers:**
- Delete the row in `trainer_mollie_accounts` (contains access tokens, org ID)
- Set `mollie_customer_id` to `null` on `trainer_profiles`

**For Academies:**
- Delete the row in `academy_mollie_accounts` (contains access tokens, org ID)
- Set `mollie_customer_id` to `null` on `academy_profiles`

## Technical Changes

### 1. `src/components/admin/TrainerEditDialog.tsx`

- On dialog open, fetch Mollie account status from `trainer_mollie_accounts` for this trainer
- Add a "Mollie Connection" section in the Settings tab showing:
  - Connection status (Connected / Not connected)
  - Mollie organization ID (if connected)
  - A red "Disconnect Mollie" button with confirmation dialog
- The disconnect handler will:
  1. Delete from `trainer_mollie_accounts` where `trainer_id = trainer.id`
  2. Update `trainer_profiles` set `mollie_customer_id = null` where `id = trainer.id`
  3. Show success toast

### 2. `src/components/admin/AcademyEditDialog.tsx`

- Same pattern: fetch from `academy_mollie_accounts`, show status, add disconnect button
- The disconnect handler will:
  1. Delete from `academy_mollie_accounts` where `academy_profile_id = academy.id`
  2. Update `academy_profiles` set `mollie_customer_id = null` where `id = academy.id`
  3. Show success toast

## UI Preview

In the Settings tab, below the existing settings, a new bordered section will appear:

```text
+-----------------------------------------------+
| Mollie Connection                              |
| Status: Connected                              |
| Org ID: org_xxxxx                              |
|                                                |
| [Disconnect Mollie]  (red destructive button)  |
+-----------------------------------------------+
```

If not connected, it will simply show "Not connected" with no button.

## Summary

| File | Change |
|------|--------|
| `src/components/admin/TrainerEditDialog.tsx` | Add Mollie status display and disconnect button in Settings tab |
| `src/components/admin/AcademyEditDialog.tsx` | Add Mollie status display and disconnect button in Settings tab |

No database migrations needed -- we're using existing tables and columns.
