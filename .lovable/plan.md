# Persist Player Billing Details Across Invoices

## Current behavior
When a recipient edits their billing details on the public invoice page (business name, address, BTW number), the edge function `update-public-invoice-details` writes **only** to that one `invoices` row (`player_business_name`, `player_address`, `player_btw_number`). Nothing is saved back to the player's profile, so the next invoice starts blank again and they have to re-enter the same info.

## Goal
Remember billing details so:
1. Future invoices to the same player are pre-filled with their saved business name / address / BTW number.
2. Registered players see and can edit these in their account settings (already partially supported — `profiles` has `billing_business_name`, `billing_address`, `billing_btw_number`).
3. Guest players (no account) still get their details remembered for repeat invoicing.

## Plan

### 1. Persist on edit (edge function)
Update `supabase/functions/update-public-invoice-details/index.ts`:
- After updating the invoice row, also update the linked recipient:
  - If `invoice.player_id` is set → update `profiles.billing_business_name / billing_address / billing_btw_number`.
  - Else if `invoice.guest_player_id` is set → update the equivalent fields on `guest_players`.
- Only overwrite when the user actually submitted a value (don't blank out existing saved data with empty fields unless they explicitly cleared it — match the dialog's behavior).

### 2. Add billing columns to guest_players (migration)
`guest_players` currently has no billing fields. Add:
- `billing_business_name text`
- `billing_address text`
- `billing_btw_number text`

### 3. Pre-fill new invoices (invoice creation)
Where invoices are generated (e.g. `create-invoice`, `generate-cycle-invoices`, bulk invoicing flows), when populating `player_business_name / player_address / player_btw_number` on the new invoice row, fall back to the player's stored billing fields:
- For `player_id` → read from `profiles.billing_*`.
- For `guest_player_id` → read from `guest_players.billing_*`.

I will scan the invoice-creation edge functions and add the lookup in each spot that currently leaves these fields null.

### 4. Pre-fill the edit dialog
On `PublicInvoicePay.tsx`, when the user opens "Factuurgegevens aanpassen" and the invoice fields are empty, fall back to the saved profile/guest billing fields returned by `get-public-invoice` (extend that function's response if needed) so the form is pre-populated.

## Out of scope
- A new "Billing settings" UI page for players (the data is now there; surfacing it in account settings can be a follow-up).
- Touching organization-side (academy/trainer) billing settings — those are unrelated.

## Open question
Should an edit on one invoice **always** overwrite the saved profile defaults, or only when there are no saved defaults yet? Recommended default: **always overwrite** (most recent edit wins) so a player who moves only has to update once. Confirm or tell me otherwise.
