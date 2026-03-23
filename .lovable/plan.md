

# Actually Send Invoices via Email When Clicking "Send"

## Current State
The "Send" button (both single and bulk "Alle concepten versturen") only updates the invoice status to `sent` — no email is actually delivered. The invoice has `guest_player_id` (links to `guest_players` table which has an `email` field) and `player_id` (links to a registered profile).

## Plan

### 1. Create `send-invoice-email` edge function
A new edge function that:
- Takes `invoiceId` as input
- Fetches the invoice + related guest player or registered player email
- Fetches academy/trainer business details for branding
- Generates the public invoice link (`/nl/academies/{slug}/pay/{public_token}`)
- Sends a branded email via Resend with invoice summary (number, amount, due date) and a "View & Pay Invoice" CTA button linking to the public invoice page
- Returns `{ success: true, email: "..." }` or `{ success: false, error: "no_email" }` if no email found

### 2. Update `handleSendInvoice` in both components
**Files: `src/components/trainer/InvoiceList.tsx` + `src/pages/academy/AcademyInvoices.tsx`**

When the send button is clicked:
1. Call `send-invoice-email` edge function with the invoiceId
2. If response returns `no_email` → show a dialog prompting the trainer to enter an email address for this player
3. If email is provided → save it to the `guest_players` record and retry sending
4. If email exists and send succeeds → mark as sent (status update) and show success toast with the email it was sent to
5. If email send fails for other reasons → still mark as sent but warn that email couldn't be delivered

### 3. Add "Enter email" dialog
**File: `src/components/trainer/InvoiceEmailDialog.tsx`** (new)

A simple dialog that appears when no email is found:
- Shows player name
- Input field for email
- "Save & Send" button
- Updates the `guest_players.email` field and triggers the send

### 4. Bulk send handling
**File: `src/pages/academy/AcademyInvoices.tsx`**

The "Send all drafts" button:
- Calls the edge function for each draft invoice
- Collects results: sent count, no-email count, failed count
- Shows summary toast: "Sent 40 invoices. 5 players have no email address."
- Still marks all as sent regardless (matching current behavior)

### Files
- `supabase/functions/send-invoice-email/index.ts` — New edge function
- `src/components/trainer/InvoiceEmailDialog.tsx` — New dialog component
- `src/components/trainer/InvoiceList.tsx` — Update send flow
- `src/pages/academy/AcademyInvoices.tsx` — Update send flow + bulk send

