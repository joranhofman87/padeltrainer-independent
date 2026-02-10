

## Add "Mark as Paid" Option to Slot and Cyclus Creation

### Overview
Allow trainers and academies to mark bookings as already paid when creating slots or training cycles with players. This is for cases where payment was handled outside the platform (cash, bank transfer, etc.). These bookings will be visually distinguished from Mollie-processed payments throughout the dashboard.

### Database Changes

Add a `paid_externally` boolean column (default `false`) to the `bookings` table. This allows the system to differentiate between payments processed through the platform (Mollie) and payments handled outside.

```sql
ALTER TABLE public.bookings ADD COLUMN paid_externally boolean DEFAULT false;
```

### UI Changes

**1. BulkCreateSheet (Training Cycle creation) -- `src/components/trainer/AddSlotDialog.tsx`**

- Add `markAsPaid` boolean to the `BulkSlotConfig` interface (default `false`)
- Add a checkbox at the bottom of each slot config (near the existing "Mark as private" checkbox): "Mark bookings as paid (payment handled externally)"
- Only show this checkbox when `addPlayers` is enabled and at least one player is selected
- When generating bookings, set `payment_status: "paid"`, `paid_at: now()`, and `paid_externally: true` instead of `payment_status: "pending"`

**2. DuplicateCyclusDialog -- `src/components/trainer/DuplicateCyclusDialog.tsx`**

- Add a `markAsPaid` checkbox when `includeExistingPlayers` is enabled
- When creating duplicated bookings with this flag, set `payment_status: "paid"`, `paid_at: now()`, `paid_externally: true`

**3. Dashboard Display Differentiation**

Update payment status badges in the following locations to show "Paid (external)" instead of just "Paid" when `paid_externally` is true:
- `src/pages/TrainerEarnings.tsx` -- earnings history and pending payments lists
- `src/pages/academy/AcademyDashboard.tsx` -- recent bookings table
- `src/components/trainer/UnpaidBookingsCard.tsx` -- exclude externally-paid bookings from unpaid list
- `src/components/trainer/EditBookingDialog.tsx` -- show indicator when viewing externally-paid booking

### Translation Keys (EN and NL, `trainer` namespace)

- `calendar.markAsPaid` -- "Mark as paid"
- `calendar.markAsPaidHint` -- "Payment was handled outside the platform (e.g. cash, bank transfer)"
- `bookings.paidExternally` -- "Paid (external)"

### Technical Details

- The `BulkSlotConfig` interface gets a new `markAsPaid: boolean` field (default `false`)
- The checkbox only appears conditionally when players are being added to the slot/cyclus
- When `markAsPaid` is true, the booking insert uses `payment_status: "paid"`, `paid_at: new Date().toISOString()`, `paid_externally: true`
- The `paid_externally` flag is purely informational -- it does not change any payment processing logic
- Existing payment status select in EditBookingDialog continues to work as before; when manually marking as paid there, `paid_externally` remains false (since it is a platform action)

