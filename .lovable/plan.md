

# Keep Registrants as Guests (No Account Creation)

## Problem
Currently, `submit-guest-intake` creates a full auth user account (with random password) for every guest registration, then sends a "Set Your Password" email. This is unnecessary friction — registrants should stay as lightweight guest records until they choose to create an account.

## Approach

### 1. Database migration
- Add `guest_player_id` column (nullable UUID, FK to `guest_players`) to `intake_requests`
- Make `player_id` nullable on `intake_requests` (currently required)
- Add a CHECK constraint: at least one of `player_id` or `guest_player_id` must be set

### 2. Update `submit-guest-intake` edge function
- **Remove** the entire user creation block (lines 94-127): no more `createUser`, no random password, no waiting for profile trigger
- **Remove** the player role assignment (lines 129-135)
- **Remove** the profile update block (lines 137-150)
- **Remove** the "Complete your account" email block (lines 236-277)
- **Instead**: create/find a `guest_players` record using the submitted email, name, phone, rating, etc.
- Set `intake_requests.guest_player_id` instead of `player_id` for guest registrations
- Keep follower logic (auto-follow trainer/club/academy) using the guest_player record
- Keep the registration confirmation email (this is useful, not the password email)
- Keep Slack notification

### 3. Update `create-manual-player` edge function
- Same change: when creating a player manually, insert into `guest_players` instead of creating an auth user
- Remove the "set password" email from this flow too
- The confirmation email via `send-email` stays

### 4. Frontend — no changes needed
- `CycleApplicationForm.tsx` already handles the guest flow by calling `submit-guest-intake` and doesn't depend on a user session being created
- The success screen already works without requiring login

### 5. Account linking (existing)
- The `link_guest_invoices_on_signup` trigger already handles linking `guest_players` to real profiles when someone signs up later — this will continue to work
- When a guest later signs up, their intake requests can be linked via email match

## Technical detail: follower tables
The follower tables (`trainer_followers`, `club_followers`, `academy_followers`) reference `player_id` which points to `profiles.id`. For guest registrations we'll skip the auto-follow since there's no profile yet — the follow will happen automatically when they eventually sign up and get linked.

| File | Change |
|------|--------|
| Migration SQL | Make `intake_requests.player_id` nullable, add `guest_player_id` FK column |
| `supabase/functions/submit-guest-intake/index.ts` | Replace user creation with `guest_players` upsert; remove password email; store `guest_player_id` on intake |
| `supabase/functions/create-manual-player/index.ts` | Replace user creation with `guest_players` insert; remove password generation |

