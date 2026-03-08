

# Add Event Type to Cycles (One-Day / Multi-Day Events)

## What We're Building
A new "Event" cycle type alongside the existing "Registration" and "Cyclus" types. Events are one-off or multi-day activities (e.g., "Kids Day", "Summer Camp 3 days") with flexible payment options including a new "pay at location" (cash) option and a combination mode where the player chooses.

## Database Changes

### 1. Update `cycles` table
- Add `'event'` as a valid `type` value (currently `'registration' | 'cyclus'`)
- No new columns needed — existing `start_date`, `end_date`, `total_price`, `settings` JSON are sufficient

### 2. Extend `CycleSettings` (stored in `settings` JSON column)
Add new payment-related fields:
- `payment_methods`: `('online' | 'cash' | 'both')[]` — which payment options are available for this event
- `event_dates`: `string[]` — specific dates for multi-day events (optional, for display purposes)
- `event_description`: rich text for event details

No migration needed for the JSON settings column — it's schemaless. We only need a migration to allow `'event'` in the `type` column (if there's a check constraint) or it may already be a text column.

## UI Changes

### 3. Trainer Cycles Page (`TrainerCycles.tsx`)
- Add a button/tab or option to create an "Event" alongside the existing "Create Registration" button

### 4. Academy Cycles Page (`AcademyCycles.tsx`)
- Same: add Event creation option

### 5. CycleForm Updates
- When `formType === 'event'`:
  - Show event name (required), description (rich text optional)
  - Show start date + end date pickers (not weeks-based — direct date range)
  - Show enrollment deadline
  - Show location picker
  - Show total price field (single price, not per-session)
  - Show **Payment Method** selector with 3 options:
    - **Pay online** — player pays via Mollie at registration
    - **Pay at location** — player pays cash on arrival (no online payment)
    - **Both** — player chooses at registration time
  - Show max participants
  - Show level requirement (rating system)
  - Hide cyclus-specific fields: start/end time, number of weeks, price per session, allow single booking, extra costs

### 6. CycleCard / CyclesTable
- Display event type with distinct styling (e.g., different icon or badge)
- Show payment method info

### 7. Public-Facing Event Registration
- Update `AcademyOpenCycles` and trainer public pages to show events
- When payment method is "both", show a choice to the player in `CycleApplicationForm`
- When "online", redirect to Mollie payment
- When "cash", just confirm registration (no payment flow)

### 8. Payment Tracking
- For online payments: use existing Mollie booking flow — create a booking with `payment_status: 'pending'` and redirect to Mollie
- For cash payments: create a booking with `payment_status: 'pay_at_location'` — trainer can later mark as paid
- Add `'pay_at_location'` as a new payment status concept in the bookings/display layer

## Data Flow
```text
Trainer creates Event → sets name, dates, price, payment methods
                      → status: draft → open
Player sees Event    → clicks Apply
                      → if payment_methods = 'online': redirect to Mollie
                      → if payment_methods = 'cash': confirm registration, no payment
                      → if payment_methods = 'both': player picks online or cash
Trainer dashboard    → sees registrations with payment status
```

## Files to Change
| File | Change |
|------|--------|
| DB migration | Allow `'event'` in cycles type column (if constrained) |
| `src/lib/cycles.ts` | Add `'event'` to Cycle type, extend CycleSettings interface |
| `src/components/cycles/CycleForm.tsx` | Add event-specific form layout with payment method selector |
| `src/pages/TrainerCycles.tsx` | Add "Create Event" button |
| `src/pages/academy/AcademyCycles.tsx` | Add "Create Event" button |
| `src/components/cycles/CycleCard.tsx` | Show event badge and payment info |
| `src/components/cycles/CyclesTable.tsx` | Show event type in table |
| `src/components/academy/AcademyOpenCycles.tsx` | Display events to players with payment choice |
| `src/components/cycles/CycleApplicationForm.tsx` | Add payment method selection for "both" mode |

