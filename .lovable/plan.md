
# Fix Invoice PDF Download + Auto-Mark Mollie Invoices as Paid

## Three Issues Identified

### Issue 1: Invoice download opens raw HTML instead of PDF
The `generate-invoice` function stores an `.html` file in storage and returns a signed URL to it. When opened, the browser renders it as an HTML page. There is no actual PDF conversion happening.

**Fix**: Instead of opening the signed URL directly (which points to an `.html` file), the download handler should use the HTML content returned by the edge function and trigger a browser-side print-to-PDF. The simplest robust approach: open the HTML in a new window with a `window.print()` auto-trigger, which lets the user "Save as PDF" via the browser print dialog. Alternatively, use the returned HTML content to create a Blob and trigger a proper download.

The cleanest fix: modify `handleDownload` to fetch the HTML from the edge function response, open it in a new tab, and auto-trigger `window.print()` so the user can save as PDF. This avoids needing a server-side PDF library.

### Issue 2: Mollie-paid invoices show as "sent" instead of "paid"
When a Mollie payment succeeds, the webhook calls `auto-create-invoice` which creates the invoice with `status: 'sent'`. But it never updates the invoice to `status: 'paid'` even though the payment is already completed.

**Fix**: In the `auto-create-invoice` edge function, detect when the booking's `payment_status` is already `'paid'` (Mollie flow) and create the invoice directly with `status: 'paid'` and `paid_at` set.

### Issue 3: Player invoice download returns 403
The screenshot shows a 403 from `generate-invoice`. Looking at the current code, the auth check already allows both trainer and player (`invoice.player_id === user.id`). However, the `profiles` table query in `auto-create-invoice` uses `.eq('id', playerId)` but `player_id` on bookings is a `user_id` (UUID from auth), while `profiles.id` might be the table's own primary key vs `profiles.user_id`. Need to verify this lookup is correct -- if `player_id` is a `user_id`, the query should use `.eq('user_id', playerId)`.

**Fix**: Ensure the player ID comparison in `generate-invoice` correctly matches. The `invoice.player_id` stores the user's auth UUID, and the edge function compares it with `user.id` from the auth token -- this should work. The 403 may be caused by a stale deployment. Will redeploy the function.

---

## Changes

### 1. `generate-invoice/index.ts` -- Return HTML for client-side PDF
No changes needed to the function itself -- it already returns `html` in the response body.

### 2. `InvoiceList.tsx` + `PlayerInvoicesTab.tsx` -- Fix download to render PDF
Update `handleDownload` in both components to:
- Call `generate-invoice` to get the HTML
- Open a new window, write the HTML into it
- Auto-trigger `window.print()` so the user can save as PDF
- This gives a proper PDF experience without raw HTML display

### 3. `auto-create-invoice/index.ts` -- Mark Mollie invoices as paid
When the booking's `payment_status === 'paid'`, create the invoice with:
- `status: 'paid'`  
- `paid_at: new Date().toISOString()`

This ensures Mollie-paid bookings show the correct invoice status immediately.

### 4. Redeploy `generate-invoice`
Ensure the latest version (with player auth fix) is deployed, resolving the 403 for players.

---

## Technical Summary

| File | Change |
|------|--------|
| `supabase/functions/auto-create-invoice/index.ts` | Check booking payment_status; if already 'paid', create invoice as paid |
| `src/components/trainer/InvoiceList.tsx` | Update handleDownload to open HTML in new window with print dialog |
| `src/components/player/PlayerInvoicesTab.tsx` | Same download fix as InvoiceList |
| `supabase/functions/generate-invoice/index.ts` | Redeploy (no code change needed) |
