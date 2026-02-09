

## Plan: Individual Booking Toggle + Extra Costs + Cycle Grouping on Profile

### Overview
Three connected changes:
1. Add an "Allow individual lesson booking" toggle to the cyclus creation form (default OFF)
2. Add an "Extra recurring costs" section where trainers can add line items (e.g., court rental)
3. On the trainer's public profile, group cycle slots into a single summary card when individual booking is disabled

### 1. CycleForm - New Fields (`src/components/cycles/CycleForm.tsx`)

**Allow individual booking toggle:**
- Add a Switch field inside the pricing section (only visible for cyclus, not registration)
- Default: OFF (players must book the entire cycle)
- Saved to `settings.allow_single_booking`

**Extra recurring costs:**
- Add a dynamic list below the pricing section
- Each row: text description input + price input + remove button
- "Add cost" button to add rows
- Managed as local state (array of `{ description: string, price: number }`)
- Saved to `settings.extra_costs`
- Auto-updates total price calculation: `total = (price_per_session * weeks) + (sum of extra cost prices * weeks)`
- When editing, loads existing values from `cycle.settings`

### 2. CycleSettings Type (`src/lib/cycles.ts`)

Add two new optional fields to the `CycleSettings` interface:
```
allow_single_booking?: boolean;
extra_costs?: { description: string; price: number }[];
```

No database migration needed -- both stored in existing JSONB `settings` column.

### 3. TrainerOpenSlots - Cycle Grouping (`src/components/trainer/TrainerOpenSlots.tsx`)

After fetching and processing available slots:
- **Partition** slots into:
  - Individual slots: no `cyclus_id` OR `allow_single_booking === true`
  - Cycle groups: have `cyclus_id` AND `allow_single_booking === false`
- **Render cycle groups** as summary cards showing:
  - Cycle name
  - Date range (first to last session)
  - Session count (e.g., "9 sessions")
  - Day and time pattern (e.g., "Mon 09:00 - 10:00")
  - Location
  - Minimum spots left across all sessions
  - Total price (price_per_session x session count)
- Cycle cards rendered above individual day-grouped slots
- Individual slots continue as day-grouped rows (unchanged)
- Badge count updated to reflect cycles as single units

### 4. Invoice Extra Costs (`supabase/functions/auto-create-invoice/index.ts`)

When building line items for a booking that belongs to a cycle:
- Fetch the cycle's settings via `cyclus_id` from the slot
- If `settings.extra_costs` exists, add each as a separate invoice line item
- Each extra cost line: description from settings, quantity 1, unit_price from settings

### 5. Translations

**English (`src/i18n/locales/en/cycles.json`)** - add to `form`:
- `allowSingleBooking`: "Allow individual lesson booking"
- `allowSingleBookingHelp`: "When off, players must book the entire cycle"
- `extraCosts`: "Extra Costs"
- `extraCostsHelp`: "Add recurring costs like court rental that appear as separate invoice lines"
- `addCost`: "Add cost"
- `costDescription`: "Description"
- `costPrice`: "Price"
- `sessions`: "sessions"

**Dutch (`src/i18n/locales/nl/cycles.json`)** - add to `form`:
- `allowSingleBooking`: "Individuele les boeking toestaan"
- `allowSingleBookingHelp`: "Indien uit, moeten spelers de hele cyclus boeken"
- `extraCosts`: "Extra Kosten"
- `extraCostsHelp`: "Voeg terugkerende kosten toe zoals baanhuur die als aparte factuurregel verschijnen"
- `addCost`: "Kosten toevoegen"
- `costDescription`: "Omschrijving"
- `costPrice`: "Prijs"
- `sessions`: "sessies"

### Files Modified
1. `src/lib/cycles.ts` - Add fields to CycleSettings interface
2. `src/components/cycles/CycleForm.tsx` - Add toggle + extra costs UI + save to settings
3. `src/components/trainer/TrainerOpenSlots.tsx` - Group cycle slots into summary cards
4. `supabase/functions/auto-create-invoice/index.ts` - Add extra cost line items
5. `src/i18n/locales/en/cycles.json` - English translations
6. `src/i18n/locales/nl/cycles.json` - Dutch translations

### No database migration required
All new data stored in existing JSONB `settings` column on `cycles` table.

