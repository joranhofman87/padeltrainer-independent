

# Players Can View Their Invoices

## What Changes

Players will be able to see invoices sent to them by trainers, download them, and update their billing details (address, BTW number) on the invoice.

## Changes Required

### 1. Database: Link invoices to players and add RLS

Currently, trainers create invoices but never set the `player_id` field -- only `player_name` is stored as plain text. We need to:

- Add a **SELECT RLS policy** on the `invoices` table so players can read invoices where `player_id` matches their profile ID
- Add an **UPDATE RLS policy** so players can update only their billing fields (`player_address`, `player_btw_number`) on their own invoices

### 2. Backend: Set `player_id` when creating invoices

Update the `CreateInvoiceDialog` to look up the player's profile ID from the booking and include it when inserting the invoice. This links the invoice to the player's account so they can see it.

For bookings with a registered player (`bookings.player_id`), the invoice will be linked. Guest player invoices remain trainer-only.

### 3. Frontend: Add "Invoices" tab to PlayerBookings page

Add a third tab ("Invoices") to the existing `PlayerBookings.tsx` page that shows:

- List of invoices addressed to the player (filtered by `player_id`)
- Invoice number, date, amount, status (draft/sent/paid/overdue)
- Download button to get the invoice HTML/PDF
- An "Edit billing details" button that opens a small dialog where the player can fill in their address and BTW number -- these get saved directly to the invoice record

### 4. Files to change

| File | Change |
|------|--------|
| **Database migration** | Add SELECT + UPDATE RLS policies for players on `invoices` table |
| `src/components/trainer/CreateInvoiceDialog.tsx` | Set `player_id` from booking data when creating invoice |
| `src/pages/PlayerBookings.tsx` | Add "Invoices" tab with invoice list, download, and billing detail editing |

## Technical Details

**New RLS policies on `invoices`:**

```text
SELECT: player_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
UPDATE: player_id = (SELECT id FROM profiles WHERE user_id = auth.uid())
        -- restricted to columns: player_address, player_btw_number
```

Since Postgres RLS can't restrict which columns are updated, the UPDATE policy will allow updates only when the row belongs to the player. The frontend will only send `player_address` and `player_btw_number` fields.

**CreateInvoiceDialog changes:**
- Accept an optional `playerId` prop (from the booking's `player_id`)
- Include `player_id` in the insert call when available

**PlayerBookings "Invoices" tab:**
- Query `invoices` where `player_id = profile.id`, ordered by date
- Show status badges matching the trainer's view (Concept, Verzonden, Betaald, Verlopen)
- Download button calls the `generate-invoice` edge function or opens `pdf_url`
- Inline editable fields for address and BTW number with save button

