

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

## Files

| File | Change |
|------|--------|
| Migration SQL | Add `split_payment` to `availability_slots` |
| `src/lib/cycles.ts` | Add to `CycleSettings` interface |
| `src/components/cycles/CycleForm.tsx` | Toggle UI |
| `src/components/trainer/AddSlotDialog.tsx` | Propagate & standalone toggle |
| `supabase/functions/auto-create-invoice/index.ts` | Split calculation logic |
| `supabase/functions/auto-invoice-cycles/index.ts` | Pass player count |
| `src/pages/BookLesson.tsx` | Per-player Mollie amount |
| `src/components/academy/AcademyPublicOpenSlots.tsx` | Split indicator |
| `src/components/trainer/TrainerOpenSlots.tsx` | Split indicator |

