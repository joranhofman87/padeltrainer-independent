


# Split Payment for Cycles & Slots

## What it does
Adds a "split payment" toggle to cycle settings and individual slots. When enabled, the **full total** (session prices + all extra costs) is divided equally among booked players. Each player receives their own invoice showing their share.

**Example**: Cyclus total = €300 (sessions) + €50 (ball costs) + €20 (court fee) = €370. With 4 players → each gets an invoice for €92.50, with line items showing their proportional share.

---

## Changes

### 1. Database migration
- Add `split_payment boolean DEFAULT false` to `availability_slots`

### 2. CycleSettings interface (`src/lib/cycles.ts`)
- Add `split_payment?: boolean` to `CycleSettings`

### 3. CycleForm UI (`src/components/cycles/CycleForm.tsx`)
- Add toggle in payment section: "Split betaling over spelers"
- Help text: "Total price (including extra costs) is divided equally among all registered players. Each player receives an individual invoice."
- Store in `settings.split_payment`

### 4. Slot creation (`src/components/trainer/AddSlotDialog.tsx`)
- Propagate cycle's `split_payment` to generated slots
- Add standalone toggle for non-cycle slots

### 5. Invoice logic (`supabase/functions/auto-create-invoice/index.ts`)
- Accept optional `splitAmongPlayers` count in the request body
- When provided, divide each line item's `unit_price` by that count
- Session line: `€X.XX /session (1/N van totaal)`
- Extra cost lines: same division, same suffix
- Result: each player's invoice total = (session total + extra costs total) / N

### 6. Auto-invoice-cycles (`supabase/functions/auto-invoice-cycles/index.ts`)
- Read `split_payment` from cycle settings
- If enabled, count total unique players across all bookings in the cycle
- Pass `splitAmongPlayers: playerCount` to `auto-create-invoice` for each player

### 7. Booking/payment flow (`src/pages/BookLesson.tsx`)
- When `split_payment` is active on slot, calculate per-player share for Mollie checkout
- Share = (session price + extra costs) / number of confirmed players

### 8. Public display (`AcademyPublicOpenSlots.tsx`, `TrainerOpenSlots.tsx`)
- When `split_payment` is true, show: "Prijs wordt verdeeld over alle deelnemers"
- If `max_participants` known: show indicative per-player price

---

# Extra Cost Presets with Per-Item VAT Rate

## What it does
1. Trainers/academies can save **extra cost presets** in their settings (e.g. "Ball costs — €5.00 — 21% BTW", "Court rental — €10.00 — 0% BTW")
2. When creating a cycle or slot, toggling on extra costs shows a **preset picker** to quickly add saved costs
3. Each extra cost carries its own `vat_rate`, so session prices and extra costs can have different tax rates
4. Invoicing calculates VAT per line item group instead of a single flat rate

## Completed Changes

### 1. Database
- Created `extra_cost_presets` table with RLS policies for trainer/academy ownership
- Added `vat_breakdown` JSONB column to `invoices` table

### 2. ExtraCost interface (`src/lib/cycles.ts`)
- Added `vat_rate?: number` field

### 3. Settings UI (`src/components/settings/ExtraCostPresetsCard.tsx`)
- CRUD card for managing presets (description, price, VAT %, type)
- Added to `TrainerBookingSettings.tsx`

### 4. Preset Picker (`src/components/settings/ExtraCostPresetPicker.tsx`)
- Dropdown component for quick preset selection
- Integrated in CycleForm and AddSlotDialog (BulkCreateSheet)

### 5. CycleForm & AddSlotDialog
- Added VAT % input per extra cost row
- Added preset picker button alongside "Add cost"

### 6. Invoice creation (`auto-create-invoice`)
- Extra cost line items now carry their own `vat_rate`
- Multi-rate VAT calculation with `vat_breakdown` stored on invoice
- Falls back to single-rate when all items share the same rate

### 7. Invoice PDF (`generate-invoice`)
- Shows per-rate VAT breakdown when multiple rates exist

### 8. Edit Invoice Dialog
- Per-line-item VAT rate editing
- Auto-calculated VAT breakdown display
