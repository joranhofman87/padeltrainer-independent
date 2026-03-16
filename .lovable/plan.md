

## Multi-Cyclus Options for Registrations

### What we're building

Allow trainers/academies to define multiple cyclus packages (e.g., 5 lessons, 10 lessons, 15 lessons) on a single registration. Players see a pricing table showing lesson type, price per lesson, and total price per package, and select their preferred package when applying.

### Current state

- The `price_table` field on `cycles` already stores an array of `{ label, price }` rows — a flat list for display only.
- The `CycleSettings` type has no concept of cyclus options/packages.
- The `intake_requests` table has `sessions_per_week` (number) but no field for a selected package/cyclus option.
- The player application form (`CycleApplicationForm`) has a `sessions_per_week` dropdown (1-7×) but no package selector.

### Data model changes

**No database migration needed.** We'll use the existing JSON fields:

1. **`CycleSettings`** — add a new `cyclus_options` array:
   ```ts
   interface CyclusOption {
     label: string;           // e.g. "Cyclus 5 lessen"
     number_of_sessions: number; // e.g. 5
     price_per_session: number;  // e.g. 25.00
     total_price: number;        // e.g. 125.00
   }
   ```
   Stored inside `settings.cyclus_options` on the `cycles` table (JSON field — no migration).

2. **Intake requests** — store the player's selected option in the existing `notes` or better, in a new JSON-compatible approach. Since `intake_requests` has no JSON settings column, we'll store the selected option ID/label in the existing `preferred_duration_minutes` field repurposed, OR more cleanly: add `selected_cyclus_option` to the notes as structured prefix, OR use a small migration to add a `metadata` JSONB column to `intake_requests`.

   **Recommended**: Add a `metadata` JSONB column to `intake_requests` to store `{ selected_cyclus_option: { label, number_of_sessions, price_per_session, total_price } }`. This is clean and future-proof.

### Changes

#### 1. Database migration
- Add `metadata JSONB DEFAULT '{}'` column to `intake_requests` table.

#### 2. `src/lib/cycles.ts`
- Add `CyclusOption` interface.
- Add `cyclus_options?: CyclusOption[]` to `CycleSettings`.
- Add `metadata?: Record<string, unknown>` to `IntakeRequest` and `IntakeRequestInput`.

#### 3. `src/components/cycles/CycleForm.tsx` (Trainer/Academy form)
- In the registration section, add a **"Cyclus Options"** builder (only shown when `formType === 'registration'`).
- UI: repeating rows with fields: Label, Number of sessions, Price per session (auto-calculates total).
- Add/remove option buttons similar to existing `extraCosts` and `priceTable` patterns.
- Store in `settings.cyclus_options`.
- **Auto-generate `price_table`** from cyclus options so the existing `CycleDetailDisplay` price table shows the right data (lesson type × package matrix).

#### 4. `src/components/cycles/CycleDetailDisplay.tsx` (Player-facing display)
- Enhance the price table to show columns: Lesson type | Price per lesson | Total price per cyclus.
- If `cyclus_options` exist, render a richer table instead of the simple label/price rows.

#### 5. `src/components/cycles/CycleApplicationForm.tsx` (Player application)
- When `cycle.settings.cyclus_options` has entries, show a **package selector** (radio cards or select) where the player picks their preferred cyclus (5/10/15 lessons).
- Store the selection in the form and submit it as `metadata.selected_cyclus_option`.
- Update both the logged-in and guest submit flows to include `metadata`.

#### 6. `supabase/functions/submit-guest-intake/index.ts`
- Accept and pass through the `metadata` field.

#### 7. Intake request display (trainer dashboard)
- Where intake requests are listed, show the selected cyclus option if present in metadata.

#### 8. Dutch translations
- Add keys for "Cyclus opties", "Aantal lessen", "Prijs per les", "Totaalprijs", "Kies je cyclus", etc.

### Summary of files to modify
- **Migration**: Add `metadata` JSONB column to `intake_requests`
- `src/lib/cycles.ts` — types
- `src/components/cycles/CycleForm.tsx` — cyclus options builder
- `src/components/cycles/CycleDetailDisplay.tsx` — enhanced price table
- `src/components/cycles/CycleApplicationForm.tsx` — package selector
- `supabase/functions/submit-guest-intake/index.ts` — pass metadata
- `src/i18n/locales/nl/cycles.json` — translations
- Intake request display components — show selected option

