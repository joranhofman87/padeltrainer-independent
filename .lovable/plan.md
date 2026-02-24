

# Payment Terms per Cycle

## What we're building
A per-cycle payment timing setting that lets trainers and academies decide **when** payment is collected for each training cycle (cyclus). Different cycles can have different payment rules.

## Payment timing options

| Option | What happens |
|--------|-------------|
| **Pay upfront** | Current behavior. Player pays at booking time (online via Mollie or immediate invoice). |
| **Invoice after X weeks** | Booking is created without payment. An invoice is automatically generated after a configurable delay (1, 2, 3, or 4 weeks after the cycle start date). |
| **Manual** | No automatic payment or invoicing. Trainer handles it outside the platform (cash, bank transfer). Bookings are marked as externally paid. This replaces the existing `mark_as_paid` checkbox. |

"Pay upfront" is the default, matching current behavior.

## How it works for users

**When creating/editing a cycle:**
A new "Payment" section appears in the cycle form (replacing the current standalone `mark_as_paid` checkbox). It shows a simple selector with three options:
- "Pay upfront" -- current default
- "Invoice after X weeks" -- with a small dropdown to pick 1/2/3/4 weeks
- "Manual (no invoicing)" -- trainer handles payment themselves

**For players:**
- **Upfront**: Same as today, they pay during booking
- **Invoice after X weeks**: They can book without paying. They see a note like "An invoice will be sent after X weeks"
- **Manual**: They can book freely. Status shows "Paid (external)" as it does today

**For automated invoicing:**
A new scheduled job checks daily for cycles where the invoice delay has elapsed (cycle start + X weeks). It then bulk-creates invoices for all confirmed bookings in those cycles that haven't been invoiced yet.

## Technical details

### 1. Data model change
Store payment timing in the existing `cycles.settings` JSON field (no migration needed):

```text
settings.payment_timing: 'upfront' | 'invoice_after_weeks' | 'manual'
settings.invoice_delay_weeks: 1 | 2 | 3 | 4  (only when payment_timing = 'invoice_after_weeks')
```

The existing `mark_as_paid` setting will be mapped: if `payment_timing` is not set, fall back to current behavior (upfront, or manual if `mark_as_paid` is true).

### 2. CycleForm changes (`src/components/cycles/CycleForm.tsx`)
- Replace the `mark_as_paid` checkbox with a "Payment timing" radio/select group
- When "Invoice after X weeks" is selected, show a small week selector (1-4)
- Save values into `settings.payment_timing` and `settings.invoice_delay_weeks`
- Backwards-compatible: existing cycles without `payment_timing` default to 'upfront' (or 'manual' if `mark_as_paid` was true)

### 3. CycleSettings type update (`src/lib/cycles.ts`)
Add to the `CycleSettings` interface:
```typescript
payment_timing?: 'upfront' | 'invoice_after_weeks' | 'manual';
invoice_delay_weeks?: number;
```

### 4. Booking flow changes (`src/pages/BookLesson.tsx`)
When a player books a cycle slot:
- **upfront**: Current flow (Mollie payment or immediate invoice)
- **invoice_after_weeks**: Skip payment step. Create booking with `payment_status: 'pending'`. Show info message about upcoming invoice
- **manual**: Skip payment. Create booking with `paid_externally: true` (current `mark_as_paid` behavior)

### 5. Scheduled invoice generation (new edge function)
Create `supabase/functions/auto-invoice-cycles/index.ts`:
- Runs daily via pg_cron
- Finds cycles where `payment_timing = 'invoice_after_weeks'` and `start_date + invoice_delay_weeks` has passed
- For each cycle, finds confirmed bookings without invoices
- Calls the existing `auto-create-invoice` logic to generate invoices
- Marks bookings as `payment_status: 'invoiced'`

### 6. UI indicators
- **CycleCard**: Show a small badge indicating payment timing (e.g., "Invoice after 2 weeks")
- **BookLesson page**: When booking a cycle with delayed invoicing, show an info alert explaining when the invoice will arrive
- **Player dashboard**: Booking card shows "Invoice pending" for not-yet-invoiced delayed bookings

### 7. Translation keys
Add keys to all 5 languages for payment timing labels and descriptions.

## Files to modify
- `src/lib/cycles.ts` -- add types
- `src/components/cycles/CycleForm.tsx` -- replace mark_as_paid with payment timing selector
- `src/components/cycles/CycleCard.tsx` -- show payment timing badge
- `src/pages/BookLesson.tsx` -- handle non-upfront payment flows
- `supabase/functions/auto-invoice-cycles/index.ts` -- new scheduled function
- Translation files (10 files across 5 languages, trainer + cycles namespaces)

## What stays the same
- Individual slot bookings (non-cycle) keep their current payment behavior
- The trainer-level `use_manual_invoicing` toggle on the earnings page is unchanged
- Mollie Connect flow is unchanged
- Existing cycles without the new setting continue to work as before (upfront)

