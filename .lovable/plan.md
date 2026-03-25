

# Extra Cost Presets with Per-Item VAT Rate

## What this does
1. Trainers/academies can save **extra cost presets** in their settings (e.g. "Ball costs — €5.00 — 21% BTW", "Court rental — €10.00 — 0% BTW")
2. When creating a cycle or slot, toggling on extra costs shows a **preset picker** to quickly add saved costs
3. Each extra cost carries its own `vat_rate`, so session prices and extra costs can have different tax rates
4. Invoicing calculates VAT per line item group instead of a single flat rate

## Technical changes

### 1. Database: New `extra_cost_presets` table
```sql
CREATE TABLE public.extra_cost_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid REFERENCES trainer_profiles(id) ON DELETE CASCADE,
  academy_profile_id uuid REFERENCES academy_profiles(id) ON DELETE CASCADE,
  description text NOT NULL,
  price numeric NOT NULL DEFAULT 0,
  vat_rate numeric NOT NULL DEFAULT 21,
  type text NOT NULL DEFAULT 'per_session', -- 'per_session' | 'one_time'
  created_at timestamptz DEFAULT now(),
  CONSTRAINT owner_check CHECK (
    (trainer_id IS NOT NULL AND academy_profile_id IS NULL) OR
    (trainer_id IS NULL AND academy_profile_id IS NOT NULL)
  )
);
-- RLS: owner can CRUD their own presets
```

### 2. Update `ExtraCost` interface (`src/lib/cycles.ts`)
Add `vat_rate?: number` to the existing `ExtraCost` interface. This field is stored on each extra cost in `availability_slots.extra_costs` JSON and cycle settings.

### 3. Settings UI: Manage presets
Add a new **"Extra kosten presets"** card to `TrainerBookingSettings.tsx` (and equivalent academy settings):
- List existing presets with description, price, VAT %, and type
- Add/edit/delete presets inline
- Each preset has: description, price (€), VAT rate (%), type (per session / one-time)

### 4. CycleForm & AddSlotDialog: Preset picker
When the "Extra costs" section is active, show a **"Kies uit presets"** button that opens a dropdown/popover listing saved presets. Selecting a preset auto-fills a new extra cost row with the preset's description, price, VAT rate, and type. Users can still manually add custom costs.

Add a VAT % input field to each extra cost row (next to the price field), defaulting to the trainer's global VAT rate.

### 5. Invoice creation: Per-line-item VAT calculation
Update `auto-create-invoice/index.ts`:
- Each line item gets an optional `vat_rate` field
- Session line items use the slot's global VAT rate (existing behavior)
- Extra cost line items use their own `vat_rate` from the extra cost data
- Calculate VAT as sum of per-line-item VAT amounts instead of one flat rate
- Store a `vat_breakdown` (JSON) on the invoice for multi-rate display
- Keep `vat_rate` field as the primary/session rate for backward compatibility

### 6. Invoice PDF & Edit dialog
Update `generate-invoice` to show VAT breakdown when multiple rates exist (e.g. "BTW 21%: €X.XX / BTW 0%: €Y.YY"). Update `EditInvoiceDialog` to show per-line-item VAT rate.

## Files to modify

| File | Change |
|------|--------|
| Migration SQL | Create `extra_cost_presets` table with RLS |
| `src/lib/cycles.ts` | Add `vat_rate` to `ExtraCost` interface |
| `src/pages/TrainerBookingSettings.tsx` | Add preset management card |
| `src/components/cycles/CycleForm.tsx` | Preset picker + VAT % per extra cost row |
| `src/components/trainer/AddSlotDialog.tsx` | Preset picker + VAT % per extra cost row |
| `supabase/functions/auto-create-invoice/index.ts` | Per-line-item VAT calculation |
| `supabase/functions/generate-invoice/index.ts` | Multi-rate VAT display in PDF |
| `src/components/invoices/EditInvoiceDialog.tsx` | Per-line-item VAT rate editing |
| `src/pages/TrainerScheduleOverview.tsx` | Pass VAT rate in extra cost editing |

