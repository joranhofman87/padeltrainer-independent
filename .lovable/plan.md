## Goal
Let guest players download their invoice PDF (the same one the trainer/bookkeeper receives) directly from the booking success screen after paying.

## Current state
- `BookingSuccess.tsx` polls until payment is confirmed, then shows confirmation/calendar buttons but no invoice access.
- `generate-invoice` edge function returns the signed PDF URL when given an `invoiceId`.
- Guest players are not authenticated, so the existing `invoices` RLS policies (which require ownership) will block them from looking up their own invoice. We need a server-validated path keyed by `booking_id`.
- `invoices.booking_ids` is an array column linking the invoice to the paid booking.

## Plan

### 1. New edge function: `get-booking-invoice`
- Public function (no JWT required), CORS enabled.
- Input: `{ bookingId: string }`.
- Logic with service-role client:
  1. Load booking; require `payment_status = 'paid'`. If not paid → 403.
  2. Find the invoice where `booking_ids @> [bookingId]` (most recent, non-draft).
  3. If no invoice exists yet, return `{ ready: false }` so the UI can poll/retry.
  4. Otherwise call the existing `generate-invoice` function (or replicate its lookup) with the resolved `invoiceId` and return `{ ready: true, pdfUrl, invoiceNumber }`.
- This keeps RLS intact while giving guests a safe, scoped way to fetch only their own paid booking's invoice.

### 2. UI on `BookingSuccess.tsx`
- After `verified === true`, show a "Download invoice" button alongside the existing actions.
- On click: call `get-booking-invoice` with the current `bookingId`.
  - If `ready: true` → trigger a real file download of `pdfUrl` (reuse the blob/anchor pattern from `src/lib/downloadInvoicePdf.ts`).
  - If `ready: false` → toast "Invoice is still being prepared, please try again in a moment."
- Add a small helper `downloadGuestInvoice(bookingId)` in `src/lib/downloadInvoicePdf.ts` (or new file) so the logic is reusable.
- Add i18n keys (`bookingSuccess.downloadInvoice`, `bookingSuccess.invoicePending`, `bookingSuccess.invoiceFailed`) across NL/EN (and other locales as a follow-up if needed — initially copy English string).

### 3. No DB schema changes required.

## Out of scope
- Emailing the invoice to the guest (separate flow, already handled elsewhere).
- Authenticated player invoice downloads (already covered by `/app/player/bookings`).