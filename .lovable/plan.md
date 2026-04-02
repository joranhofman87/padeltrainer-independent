

# Fix Casper's missing bookings and linked data

## Root cause

Casper's `guest_players` record has **no email** (it's NULL). The `link_guest_invoices_on_signup` trigger matches by email — so when Casper created his account, nothing got linked:

| Record | Status |
|--------|--------|
| `guest_players.linked_profile_id` | NULL (not linked) |
| `guest_players.email` | NULL (no email to match) |
| 16 bookings: `player_id` | All NULL |
| 16 bookings: `guest_player_id` | Set correctly |
| `trainer_followers` | No record exists |

The player dashboard queries `bookings.player_id = profileId`, so it finds zero bookings.

## Changes

### 1. Data migration — link Casper's records

Single SQL migration to:
- Set `guest_players.linked_profile_id` to Casper's profile ID
- Set `guest_players.email` to his actual email
- Update all 16 bookings to set `player_id = profile.id`
- Insert a `trainer_followers` record linking Casper to Rene

```sql
-- Link guest player to profile
UPDATE guest_players
SET linked_profile_id = 'cd8536c5-a604-4645-a898-7ed629bcef55',
    email = 'caspermaassen2006@gmail.com'
WHERE id = 'a6926e39-f9c0-41fc-ae44-6e90a34ef73d';

-- Link bookings
UPDATE bookings
SET player_id = 'cd8536c5-a604-4645-a898-7ed629bcef55'
WHERE guest_player_id = 'a6926e39-f9c0-41fc-ae44-6e90a34ef73d'
  AND player_id IS NULL;

-- Follow trainer
INSERT INTO trainer_followers (player_id, trainer_id)
VALUES ('cd8536c5-a604-4645-a898-7ed629bcef55', 'c0497580-1e4e-4376-93d1-5b90e9d7ca1d')
ON CONFLICT DO NOTHING;
```

### 2. Improve the signup trigger — also match by linked guest_player_id

Update `link_guest_invoices_on_signup` to handle the case where a guest player has no email but was manually linked (via admin). Currently it only matches by email. Add a secondary pass that also links bookings for any `guest_players` where `linked_profile_id = NEW.id` (set by admin or other flows).

### 3. Auto-follow trainer on guest link

Update the trigger to also insert a `trainer_followers` record when linking a guest player who has a `trainer_id`, so the player automatically follows their trainer.

## Files changed

| File | Change |
|------|--------|
| DB migration | Fix Casper's data + improve trigger |

No frontend code changes needed — the player dashboard already queries by `player_id`, which will now be correctly set.

