
# Reditus In-App Referral Program

## Overview

Integrate the Reditus referral widget into all app sidebars (trainer, academy, club, player) and create a webhook endpoint to automatically attach a 20% discount when a referred user signs up.

---

## Secrets Required

Two new secrets need to be added before implementation:

- **REDITUS_PRODUCT_ID** -- Your Product ID from the Reditus referral program config
- **REDITUS_PRODUCT_SECRET** -- Your Product Secret for signing JWTs (found at app.getreditus.com/saas/referral_program/config/authentication)
- **REDITUS_WEBHOOK_SECRET** -- Your webhook signing secret from Reditus for verifying `X-Signature` headers

---

## Part 1: JWT Generation Edge Function

Create `supabase/functions/reditus-referral-token/index.ts`

This function generates a JWT signed with `REDITUS_PRODUCT_SECRET` using the HS512 algorithm. The authenticated user calls it, and it returns a token containing `ProductId`, `UserId`, and `iat`.

- Requires a valid user session (checks `Authorization` header)
- Uses the `jose` library (available in Deno) to create the JWT
- Returns `{ token: "..." }`

Register in `supabase/config.toml` with `verify_jwt = false` (manual auth check inside).

---

## Part 2: Frontend Widget Loading

### New component: `src/components/ReferralWidget.tsx`

A shared component that:
1. On mount, calls the `reditus-referral-token` edge function to get a JWT
2. Calls `window.gr("loadReferralWidget", { product_id, auth_token, user_details })` with the user's email and name
3. Exposes a button handler that calls `window.referralWidget.show()`

The `product_id` will be stored as a constant since it's not secret (same one already in `index.html`: `48a566a2-eb01-4562-932d-ef6886e0282e`). However, the widget `product_id` for the referral program may differ from the tracking ID -- it comes from the Reditus referral config page. We'll use the `REDITUS_PRODUCT_ID` secret on the backend and pass it back with the token response.

### Sidebar Changes

Add a "Refer & Earn" menu item to each sidebar, positioned just above the footer/business section:

- **TrainerSidebar** -- New `SidebarMenuItem` with `Gift` icon, onClick opens referral widget modal
- **PlayerSidebar** -- Same pattern
- **AcademySidebar** -- Same pattern
- **ClubSidebar** -- Same pattern

The click handler calls `window.referralWidget.show()`. The widget initialization happens once via `ReferralWidget` component rendered inside each layout.

### Layout Integration

Add the `<ReferralWidget />` component to `TrainerLayout`, `PlayerLayout`, `AcademyLayout`, and `ClubLayout` so the widget script loads once when the user enters their dashboard. The component renders nothing visible -- it just initializes the Reditus widget on mount.

---

## Part 3: Webhook for Discount Assignment

### Webhook URL

Create `supabase/functions/reditus-referral-webhook/index.ts`

The URL to give Reditus:
```
https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/reditus-referral-webhook
```

Register in `supabase/config.toml` with `verify_jwt = false`.

### Webhook Logic

Handles the `lead.created` event from Reditus:

1. Verify the `X-Signature` header using HMAC-SHA256 with `REDITUS_WEBHOOK_SECRET`
2. Extract `lead_uid` (our user ID) and `lead_email` from the payload
3. Look up the user in `profiles` by `user_id = lead_uid` or by `email = lead_email`
4. If found, insert into `user_discounts`:
   - `user_id`: the matched user ID
   - `discount_percent`: 20
   - `duration_months`: 3 (configurable)
   - `months_remaining`: 3
   - `source`: 'referral'
   - `is_active`: true
5. If the user already has an active discount, skip (don't overwrite)
6. Return 200

This hooks into the existing `user_discounts` table and the discount system we just built -- when they subscribe, the 20% discount is automatically applied.

---

## Files to Create

| File | Purpose |
|------|---------|
| `supabase/functions/reditus-referral-token/index.ts` | JWT generation for widget auth |
| `supabase/functions/reditus-referral-webhook/index.ts` | Webhook receiver for `lead.created` |
| `src/components/ReferralWidget.tsx` | Widget initializer component |

## Files to Modify

| File | Change |
|------|--------|
| `supabase/config.toml` | Register 2 new functions with `verify_jwt = false` |
| `src/components/trainer/TrainerSidebar.tsx` | Add "Refer & Earn" menu item |
| `src/components/player/PlayerSidebar.tsx` | Add "Refer & Earn" menu item |
| `src/components/academy/AcademySidebar.tsx` | Add "Refer & Earn" menu item |
| `src/components/club/ClubSidebar.tsx` | Add "Refer & Earn" menu item |
| `src/components/trainer/TrainerLayout.tsx` | Render `<ReferralWidget />` |
| `src/components/player/PlayerLayout.tsx` | Render `<ReferralWidget />` |
| `src/components/academy/AcademyLayout.tsx` | Render `<ReferralWidget />` |
| `src/components/club/ClubLayout.tsx` | Render `<ReferralWidget />` |

---

## Implementation Order

1. Add secrets (`REDITUS_PRODUCT_ID`, `REDITUS_PRODUCT_SECRET`, `REDITUS_WEBHOOK_SECRET`)
2. Create `reditus-referral-token` edge function
3. Create `reditus-referral-webhook` edge function
4. Register both in `config.toml`
5. Create `ReferralWidget` component
6. Add "Refer & Earn" to all 4 sidebars
7. Add `<ReferralWidget />` to all 4 layouts
8. Deploy edge functions
