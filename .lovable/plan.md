

# Fix: Guest-to-Player Linking on Signup

## Root Causes

### 1. Wrong ID used in trigger (invoices)
The `link_guest_invoices_on_signup` trigger sets `invoices.player_id = NEW.user_id`, but `invoices.player_id` references `profiles(id)` (the profiles table primary key), NOT `auth.users(id)`. These are different UUIDs. The trigger should use `NEW.id` (the profiles row PK) instead of `NEW.user_id`.

### 2. Bookings are never linked
The trigger only links invoices and guest_players, but **bookings still have `guest_player_id` set and `player_id = NULL`**. The player dashboard queries `.eq('player_id', profile.id)`, so guest bookings remain invisible after signup.

## Changes

### 1. Update the `link_guest_invoices_on_signup` trigger function

Replace `NEW.user_id` with `NEW.id` for the invoice update (since `invoices.player_id` references `profiles.id`).

Add a third UPDATE to also link bookings:
```sql
UPDATE bookings b
SET player_id = NEW.id
FROM guest_players gp
WHERE b.guest_player_id = gp.id
  AND lower(gp.email) = lower(NEW.email)
  AND b.player_id IS NULL;
```

### 2. Data patch for current situation
Manually link Joran's (the player who just signed up) bookings and invoice to their profile. Need to:
- Find the profile ID for the newly signed-up player
- Update `invoices.player_id` to the correct `profiles.id`
- Update `bookings.player_id` for all bookings with matching `guest_player_id`

| File | Change |
|------|--------|
| Migration SQL | Fix `link_guest_invoices_on_signup`: use `NEW.id` instead of `NEW.user_id`, add bookings linking |
| Database (data patch) | Link existing bookings + fix invoice player_id for the signed-up player |

