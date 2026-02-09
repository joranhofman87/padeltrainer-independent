
## Payment Tracking and Payment Reminders for Manually Added Players

### Overview
Three connected features:
1. Show payment status indicators on calendar slot cards so trainers can see at a glance who has paid
2. Add a dedicated "Unpaid Bookings" section on the trainer dashboard with clear overview of outstanding payments
3. Allow trainers to send payment reminder emails to players (individually and in bulk)

### 1. Payment Status on Calendar Slot Cards

**File: `src/components/trainer/CalendarSlotCard.tsx`**

Currently, each booked player row shows a green checkmark (confirmed) or yellow clock (pending booking status), but there is no payment indicator.

Changes:
- Add a small payment icon next to each player name: a green Euro icon if `payment_status === 'paid'`, or a red/orange Euro icon if unpaid
- This requires the `BookedPlayer` interface to include `payment_status`
- Update the interface and pass `payment_status` through from the dashboard query

**File: `src/pages/TrainerDashboard.tsx`**

- Update the bookings query (line ~178) to also select `payment_status` from bookings
- Pass `payment_status` through to `BookedPlayer` objects in the aggregation logic (~line 216)

**File: `src/components/trainer/CalendarSlotCard.tsx`**

- Add `paymentStatus?: string` to the `BookedPlayer` interface
- Show a small Euro badge (green for paid, orange for pending) next to each player name

### 2. Unpaid Bookings Overview on Dashboard

**New file: `src/components/trainer/UnpaidBookingsCard.tsx`**

A card component that:
- Fetches all bookings where `payment_status` is `'pending'` for the trainer's slots
- Groups them by cycle (if applicable) or lists individually
- Shows: player name, session date/time, amount owed, cycle name
- Includes a count badge in the header (e.g., "12 unpaid")
- Has a "Mark as Paid" button per row
- Has a "Send Reminder" button per row
- Has a "Select All" checkbox + "Send Bulk Reminder" button
- Shows total outstanding amount

**File: `src/pages/TrainerDashboard.tsx`**

- Import and render `UnpaidBookingsCard` between the stats cards and the calendar section
- Pass `trainerId` as prop

### 3. Payment Reminder Emails

**File: `src/lib/email.ts`**

- Add `"payment_reminder"` to the `EmailType` union
- Add relevant fields to `EmailData` (invoiceUrl, totalAmount, dueDate)

**File: `supabase/functions/send-email/index.ts`**

- Add `"payment_reminder"` to the `EmailRequest` type union
- Add a new email template case for `payment_reminder` that includes:
  - Player name, trainer name
  - List of unpaid sessions (dates/times)
  - Total amount owed
  - A friendly but clear "please arrange payment" message

**File: `src/components/trainer/UnpaidBookingsCard.tsx`**

- "Send Reminder" per booking: calls `sendEmail("payment_reminder", playerEmail, { ... })`
- "Send Bulk Reminder" groups all selected bookings by player, then sends one email per player with all their unpaid sessions listed
- Shows loading state while sending
- Toast confirmation after sending
- Tracks last reminder sent date (stored as `reminder_sent_at` on the booking -- requires a small DB migration)

### 4. Database Migration

Add a `reminder_sent_at` column to the `bookings` table so trainers can see when a reminder was last sent:

```sql
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
```

This lets the UI show "Last reminded: 3 days ago" and prevents spamming.

### 5. Translations

**`src/i18n/locales/en/trainer.json`** -- add under a new `unpaidBookings` key:
- `title`: "Unpaid Bookings"
- `noUnpaid`: "All payments collected!"
- `totalOutstanding`: "Total outstanding"
- `sendReminder`: "Send Reminder"
- `sendBulkReminder`: "Send Reminders"
- `markPaid`: "Mark Paid"
- `selectAll`: "Select all"
- `reminderSent`: "Reminder sent"
- `lastReminder`: "Last reminder"
- `reminderSentSuccess`: "Payment reminder sent successfully"
- `bulkReminderSentSuccess`: "Payment reminders sent to {{count}} players"

**`src/i18n/locales/nl/trainer.json`** -- Dutch equivalents:
- `title`: "Openstaande betalingen"
- `noUnpaid`: "Alle betalingen ontvangen!"
- `totalOutstanding`: "Totaal openstaand"
- `sendReminder`: "Herinnering sturen"
- `sendBulkReminder`: "Herinneringen sturen"
- `markPaid`: "Markeer als betaald"
- `selectAll`: "Alles selecteren"
- `reminderSent`: "Herinnering verstuurd"
- `lastReminder`: "Laatste herinnering"
- `reminderSentSuccess`: "Betalingsherinnering succesvol verstuurd"
- `bulkReminderSentSuccess`: "Betalingsherinneringen verstuurd naar {{count}} spelers"

### 6. Academy Dashboard

**File: `src/pages/academy/AcademyDashboard.tsx`**

- Import and render the same `UnpaidBookingsCard` component
- The component will accept an optional `academyId` prop to query bookings for all trainers under the academy

### Summary of files

| File | Change |
|------|--------|
| `src/components/trainer/CalendarSlotCard.tsx` | Add payment status to BookedPlayer, show Euro icon |
| `src/pages/TrainerDashboard.tsx` | Fetch payment_status in bookings query, pass to players, render UnpaidBookingsCard |
| `src/components/trainer/UnpaidBookingsCard.tsx` | **New** -- unpaid overview with mark paid + send reminder (single and bulk) |
| `src/lib/email.ts` | Add `payment_reminder` email type |
| `supabase/functions/send-email/index.ts` | Add payment_reminder email template |
| `src/i18n/locales/en/trainer.json` | Add unpaidBookings translations |
| `src/i18n/locales/nl/trainer.json` | Add unpaidBookings translations |
| `src/pages/academy/AcademyDashboard.tsx` | Render UnpaidBookingsCard for academy |
| DB migration | Add `reminder_sent_at` column to bookings |
