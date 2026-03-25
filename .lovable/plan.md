

# Add Extra Cost Preset Picker to Schedule Overview & Invoice Editor

## Problem
The `ExtraCostPresetPicker` component exists and works in `CycleForm` and `AddSlotDialog`, but is missing from:
1. **Schedule Overview cycle edit dialog** (`TrainerScheduleOverview.tsx`) — no preset picker, and the local `ExtraCost` type is missing `vat_rate`
2. **Edit Invoice dialog** (`EditInvoiceDialog.tsx`) — no way to add extra cost presets as new line items

## Changes

### 1. `TrainerScheduleOverview.tsx` — Add preset picker + vat_rate support

- Update local `ExtraCost` type (line 70) to include `vat_rate?: number`
- Add a separate query to fetch and store the trainer profile ID (needed for the preset picker)
- Import `ExtraCostPresetPicker`
- Add the preset picker button next to the "Add cost" button in the extra costs section (~line 1158-1174)
- Add a VAT rate input field per extra cost row (similar to how CycleForm does it)

### 2. `EditInvoiceDialog.tsx` — Add preset picker for adding line items

- Accept optional `trainerId` and `academyProfileId` props
- Import `ExtraCostPresetPicker`
- Add a "Add from presets" button next to the line items section
- When a preset is selected, append it as a new line item with `quantity: 1`, `unit_price: preset.price`, `vat_rate: preset.vat_rate`
- Add a manual "Add line" button as well (if not already present)

### 3. Update `InvoiceList.tsx` and `AcademyInvoices.tsx` — Pass owner IDs to EditInvoiceDialog

- Pass the trainer profile ID / academy profile ID to `EditInvoiceDialog` so the preset picker knows which presets to load

## Technical Details

| File | Change |
|------|--------|
| `src/pages/TrainerScheduleOverview.tsx` | Add `vat_rate` to local ExtraCost type, add trainer profile ID query, import and render `ExtraCostPresetPicker`, add VAT input per cost row |
| `src/components/invoices/EditInvoiceDialog.tsx` | Add `trainerId`/`academyProfileId` props, import and render `ExtraCostPresetPicker`, add "Add line" button |
| `src/components/trainer/InvoiceList.tsx` | Pass `trainerId` to `EditInvoiceDialog` |
| `src/pages/academy/AcademyInvoices.tsx` | Pass `academyProfileId` to `EditInvoiceDialog` |

