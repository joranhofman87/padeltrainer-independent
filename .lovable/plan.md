

## Rework: Duration Options as Player Preference

### Current state
The `CyclusOption` interface bundles label, number_of_sessions, number_of_weeks, price_per_session, and total_price into packages. The cycle has a fixed start/end date and a single `number_of_weeks` field. Players pick a full package.

### What's changing
The cycle keeps its overall timeframe (start_date → end_date). The trainer defines **which duration options** (in weeks) players can choose from — e.g. 5, 10, or 15 weeks. This is a simple list of week counts, not full packages. The existing pricing (price_per_session, total_price, price_table) stays separate.

Players see these duration options in the registration form and pick one as their **preference**. This selection is stored on the intake request and used during proposal generation.

### Changes

#### 1. `src/lib/cycles.ts` — Simplify to duration options
- Add `duration_options?: number[]` to `CycleSettings` (e.g. `[5, 10, 15]`).
- Keep `CyclusOption` and `cyclus_options` for backward compatibility but they become secondary to this simpler model.
- Add `preferred_number_of_weeks?: number` to `IntakeRequest` and `IntakeRequestInput` — stored in the `metadata` JSONB column.

#### 2. `src/components/cycles/CycleForm.tsx` — Duration options builder
- In the registration section, add a **"Duration options"** field: a simple UI where the trainer can add/remove week counts (e.g. chips or a small list with + button).
- Store as `settings.duration_options: number[]`.
- Keep the existing cyclus options builder for pricing packages — they work independently.

#### 3. `src/components/cycles/CycleApplicationForm.tsx` — Player picks duration
- When `cycle.settings.duration_options` has entries, show a selector (radio cards or select) where the player picks how many weeks they want to train.
- Store selection in `metadata.preferred_number_of_weeks`.
- This is shown in the preferences section, separate from the cyclus option (package) selector.

#### 4. `src/components/cycles/CycleDetailDisplay.tsx` — Show available durations
- Display the available duration options to players (e.g. "Available durations: 5, 10, or 15 weeks").

#### 5. `supabase/functions/generate-proposals/index.ts` — Use duration in proposals
- Fetch `metadata` from intake requests.
- When a player has `preferred_number_of_weeks`, use it to determine how many weeks of slots to assign them (instead of filling the entire cycle duration).
- Add `metadata` to the `IntakeRequest` interface in the edge function and include it in the query select.

#### 6. `supabase/functions/submit-guest-intake/index.ts` — Pass through
- Already passes `metadata` — just ensure `preferred_number_of_weeks` flows through.

#### 7. Intake request display
- Show the player's preferred duration (weeks) on the trainer's intake request detail view.

#### 8. `src/i18n/locales/nl/cycles.json` — Translations
- Add: "Duur opties", "Aantal weken", "Kies je gewenste duur", "weken", etc.

### Files to modify
- `src/lib/cycles.ts`
- `src/components/cycles/CycleForm.tsx`
- `src/components/cycles/CycleApplicationForm.tsx`
- `src/components/cycles/CycleDetailDisplay.tsx`
- `supabase/functions/generate-proposals/index.ts`
- `src/i18n/locales/nl/cycles.json`
- Intake request detail components (to display selected duration)

