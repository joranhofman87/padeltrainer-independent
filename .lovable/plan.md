

# Fix "Booking Failed" - Foreign Key Mismatch in create-mollie-payment

## Problem

The `create-mollie-payment` edge function sets `player_id` to the **auth user ID** (`user.id`), but the `bookings` table has a foreign key constraint `bookings_player_id_fkey` referencing `profiles.id` -- which is a **separate UUID** from the auth user ID.

For the user `joran@getreditus.com`:
- Auth user ID: `d3f3ced7-25bf-4ae6-a2f1-820da140355e`
- Profile ID: `9938e067-30e1-4ec3-b896-68322fb02c57`

The insert fails because there's no `profiles` row with `id = d3f3ced7...`.

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

Before inserting the booking, look up the player's `profiles.id` from their auth user ID:

```typescript
// After user authentication, before the booking insert:
const { data: playerProfile, error: profileError } = await supabase
  .from("profiles")
  .select("id")
  .eq("user_id", user.id)
  .single();

if (profileError || !playerProfile) {
  throw new Error("Player profile not found");
}
```

Then change line 172 from:
```typescript
player_id: user.id,
```
to:
```typescript
player_id: playerProfile.id,
```

Also update the metadata on line 199 to use the correct profile ID for consistency.

This is a one-line data fix plus a profile lookup -- no schema changes needed.
