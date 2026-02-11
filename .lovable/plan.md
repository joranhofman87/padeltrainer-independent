

## Fix Extra Costs Not Adding to Total Price

### Problem
The auto-calculation on line 225 of `CycleForm.tsx` combines extra costs INTO the `total_price` field, which makes the "Total cyclus price" field show the combined amount. The user wants the pricing to work as a breakdown:

- **Price per session**: trainer hourly rate x duration (e.g. 75)
- **Total cyclus price**: price per session x number of weeks (e.g. 75 x 10 = 750)
- **Extra costs per session**: sum of extra cost lines (e.g. 25)
- **Total extra costs**: extra cost per session x weeks (e.g. 25 x 10 = 250)
- **Grand total**: total cyclus price + total extra costs (e.g. 750 + 250 = 1000)

Currently the extra costs are baked into `total_price`, so there's no visible breakdown.

### Changes

**File: `src/components/cycles/CycleForm.tsx`**

1. **Line 224-225** -- Remove extra costs from `total_price` calculation:
   ```
   const totalPrice = Math.round(pricePerSession * watchedWeeks * 100) / 100;
   ```
   (Remove `extraCostPerSession` from this line)

2. **After the total_price field (around line 725)** -- Add a summary showing the breakdown when extra costs exist:
   - Extra costs per session total
   - Total extra costs (per session x weeks)
   - Grand total (total_price + total extra costs)

   This will be a read-only display block (not editable fields), shown only when there are extra costs with prices > 0.

### Technical detail

- `price_per_session` stays as is (trainer rate x duration)
- `total_price` reverts to `pricePerSession * weeks` only
- A new computed summary section shows the combined total
- The `extra_costs` are already saved in `settings.extra_costs` on the cycle, so downstream invoice generation can use them independently
