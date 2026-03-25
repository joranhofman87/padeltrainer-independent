

# Re-invoice as Split (Retroactive Split Payment)

## What it does
Adds a "Split over spelers" action button on unpaid invoices. When clicked:
1. **Edits the existing invoice** — recalculates line items divided by N players, keeping it assigned to the original player
2. **Creates new invoices** for the other players in the same cycle/slot group, each with their equal share

No credit notes needed since only paid invoices are forwarded to bookkeepers.

---

## How it works

1. From the invoice's `booking_ids`, query all bookings on the same slots to find other unique players
2. Count total unique players (N) including the original
3. Update the existing invoice: divide each line item's `unit_price` by N, add `(1/N)` suffix
4. For each other player, call `auto-create-invoice` with their booking IDs + `splitAmongPlayers: N`

---

## Changes

### 1. New Edge Function: `split-invoice`

`supabase/functions/split-invoice/index.ts`

Accepts `{ invoiceId: string }`. Logic:
- Fetch the invoice (must be unpaid: draft/sent/overdue)
- From `booking_ids`, find the slot IDs → find all confirmed bookings on those slots
- Group by player, count unique players (N)
- If N ≤ 1, return error "no other players to split with"
- **Update existing invoice**: recalculate line items (divide unit_price by N), update subtotal/vat/total, clear `pdf_url`
- **Create invoices for other players**: call `auto-create-invoice` for each other player's booking IDs with `splitAmongPlayers: N`
- Update cycle settings to mark `split_payment: true` (so future invoices auto-split)

### 2. UI: Add split button to `InvoiceList.tsx`

Add a "Split" button (icon: `Users` or `Split`) next to edit/mark-paid for unpaid invoices that have `booking_ids`. On click:
- Confirm dialog: "Weet je zeker dat je deze factuur wilt splitsen over alle spelers? De huidige factuur wordt aangepast en er worden nieuwe facturen aangemaakt voor de andere spelers."
- Call the `split-invoice` edge function
- Refresh invoice list on success

### 3. Also add to academy invoice list

Check if there's an academy-side invoice list and add the same button there.

---

## Files

| File | Change |
|------|--------|
| `supabase/functions/split-invoice/index.ts` | New edge function with split logic |
| `src/components/trainer/InvoiceList.tsx` | Add split button for unpaid invoices |
| Academy invoice list (if exists) | Same split button |

