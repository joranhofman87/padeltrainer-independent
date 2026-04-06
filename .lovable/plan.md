

# Add Invoices Box to Slot Detail Page

## What it does
Below the Players card on the slot detail page, show a compact "Invoices" card listing all invoices linked to this slot (via `booking_ids`) or the parent cycle. Each row shows invoice number, player name, amount, status badge, and links to the invoice edit page.

## How it works

### Data fetching
After the slot detail loads, query the `invoices` table where `booking_ids` overlaps with the booking IDs from `detail.booked_players`. This covers both single-slot and cycle-level invoices since cycle invoices store all their booking IDs in the `booking_ids` array.

### Display
A compact card with a table-like layout:
- Invoice number (monospace, clickable link to `/app/academy/invoices/:id/edit`)
- Player name
- Amount (€)
- Status badge (reuse the same status config pattern from `PlayerInvoicesTab`)

### File changes

**`src/pages/academy/AcademySlotDetail.tsx`**
- After `fetchSlotDetail`, add a second query to fetch invoices where `booking_ids` overlaps with the slot's booking IDs
- Add an "Invoices" Card below the Players card in the right column
- Each invoice row is a clickable link using `navigate()` to the edit page
- Show status badges (Draft, Sent, Paid, Overdue, Cancelled) with appropriate colors
- If no invoices exist, show a simple "No invoices" message

No new files or migrations needed — this is purely a UI addition reading existing data.

## Technical details

```typescript
// Fetch invoices linked to this slot's bookings
const bookingIds = detail.booked_players.map(p => p.bookingId);
const { data: slotInvoices } = await supabase
  .from('invoices')
  .select('id, invoice_number, player_name, total, status, due_date, paid_at')
  .overlaps('booking_ids', bookingIds);
```

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Fetch linked invoices, render Invoices card below Players |

