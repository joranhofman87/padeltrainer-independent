

# Fix Invoice Line Items: Proper Pricing Breakdown & Extra Costs

## Problem
Invoices don't clearly break down the pricing structure. The current logic:
- Shows cyclus name × number of sessions, but doesn't indicate weeks
- Extra costs (recurring) multiply by number of sessions — user expects "× number of weeks"
- Extra costs stored on `availability_slots.extra_costs` are ignored when no `cycles` record exists
- The invoice doesn't visually distinguish between session costs, one-time extras, and recurring extras

## Changes

### 1. `supabase/functions/auto-create-invoice/index.ts` — Fix line item generation

**Session line item**: Keep as-is (`cyclusName`, qty = bookings.length, unit_price = price_per_session). Add "(x weken)" to description for clarity, e.g. `"Masterclass René (10 weken)"`.

**Extra costs source**: First try `cycles.settings.extra_costs`, then fall back to `availability_slots.extra_costs` from the first slot. This ensures standalone slots with extra costs are also invoiced.

**Extra cost types**:
- `one_time`: quantity = 1, description as-is → e.g. "Ball costs"
- `per_session` (recurring): quantity = bookings.length (number of weeks/sessions), description with "(per sessie)" suffix → e.g. "Court rental (per sessie)"

### 2. `src/components/trainer/DeleteSlotDialog.tsx` — Mirror the same fix

Apply identical extra cost sourcing logic (slots fallback) and description formatting for invoice recalculation on slot deletion.

### 3. `supabase/functions/generate-invoice/index.ts` — No changes needed

The PDF/HTML renderer already correctly handles line items with description, quantity, unit_price, and amount columns. The improved descriptions will automatically show correctly.

## Summary
The fix ensures:
- Cyclus sessions show the week count in the description
- One-time extra costs show with qty=1
- Recurring extra costs show with qty=number of sessions and "(per sessie)" label
- Extra costs are sourced from slots when no cycle record exists

## Files
- `supabase/functions/auto-create-invoice/index.ts` — Better descriptions + slot fallback for extra costs
- `src/components/trainer/DeleteSlotDialog.tsx` — Same fix for recalculation

