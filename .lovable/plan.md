

# Add "Update Details" Option on Public Invoice Page

## Current State
The public invoice page shows `invoice.playerName` in the "To" section with no way to edit. Logged-in players can edit billing details (business name, address, BTW number) from their player dashboard, but there's no path from the public invoice page.

## Approach
Add a subtle, non-intrusive link below the player name. Behavior depends on auth state:
- **Logged in** (and invoice belongs to them): Show an inline edit dialog for business name, address, and BTW number — same fields as `PlayerInvoicesTab`
- **Not logged in**: Show a small prompt encouraging sign-up/login to manage invoice details, with a link to auth page

The payment button remains the dominant CTA. The "update details" is secondary — just a small text link.

## Changes

### 1. Update `PublicInvoicePay.tsx`
- Import `useAuth` hook to check login state
- Add the invoice's `player_id` and `player_business_name`, `player_address`, `player_btw_number` to the data returned from the edge function
- In the "To" section, below the player name, show existing business details if present
- Add a small "Update your details" text link:
  - If logged in & user matches `player_id` → opens an edit dialog (reuse the same fields as PlayerInvoicesTab: business name, address, BTW)
  - If not logged in → navigates to `/app/auth` with a return URL
- After saving, refresh the invoice data so changes are visible immediately

### 2. Update `get-public-invoice` edge function
- Add `player_id`, `player_business_name`, `player_address`, `player_btw_number` to the select query
- Include these in the response so the frontend can display them and check ownership

### 3. Add edit dialog component (inline in PublicInvoicePay or extracted)
- Simple dialog with 3 fields: business name, address, BTW number
- On save: call supabase to update the invoice record directly (with auth check — player must be the invoice's `player_id`)
- Show toast on success, refresh invoice data

### Files
- `supabase/functions/get-public-invoice/index.ts` — Add player billing fields to response
- `src/pages/PublicInvoicePay.tsx` — Add auth check, "Update details" link, edit dialog

