## Problem
Bulk email send loops sequentially over all invoices (57 calls × ~1s each). The dialog shows only a spinner, blocks closing, and gives no progress feedback — feels stuck.

## Solution
Add live progress feedback and let the user close the dialog while sending continues in the background.

### Changes to `src/components/invoices/BulkInvoiceEmailDialog.tsx`

1. **Track progress state**
   - Add `progress` state: `{ current: number, total: number, sent: number, noEmail: number, failed: number }`
   - Update after each invoice completes inside the existing loop.

2. **Progress UI (replaces the spinner button content while sending)**
   - Show a `Progress` bar (shadcn `@/components/ui/progress`) with `value = current/total * 100`.
   - Show text: "Sending {current} of {total}… ({sent} sent, {noEmail} no email, {failed} failed)".
   - Show an info line: "You can safely close this window — sending continues in the background."

3. **Allow closing during send**
   - Remove the `!sending` guard on `onOpenChange` and the Cancel button so the user can dismiss.
   - When the dialog closes mid-send, fire a sonner `toast.loading(id, …)` that updates with progress, then resolves to `toast.success` when done. Use a stable toast id so updates replace the same toast.
   - Detach the send loop from the dialog lifecycle: kick it off in `handleSend`, but don't `await` it before allowing close. Use a ref to ensure only one bulk send runs at a time.

4. **Final toast**
   - Keep the existing summary toast on completion (sent / no email / failed counts).
   - Call `onSent()` to refresh the invoice list when done.

5. **Concurrency (small win, optional)**
   - Process invoices with limited concurrency (e.g. 3 at a time) using a simple promise pool, so 57 emails finish in ~1/3 the time without overloading the edge function.

### No backend changes
The `send-invoice-email` edge function already handles single invoices correctly. This is purely a UX fix on the client.

### Out of scope
- No queue-based architecture or background worker (overkill for ~50–100 invoices).
- No changes to the email content, language, or auto-population logic.