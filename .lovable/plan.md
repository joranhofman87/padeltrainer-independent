

## Streamline Proposal Generation: Add Trainer Availability & AI Criteria

### Problem
Currently, managers must manually create availability slots before generating proposals. This is tedious and error-prone. The user wants to provide trainer availability directly in the proposal generation flow, plus a free-text field for custom rules (e.g., "kids lessons only during the day").

### Design

Replace the current two-step flow (Guard dialog → Scoring Weights dialog) with a multi-step wizard dialog that collects everything needed to generate proposals in one go.

#### Step 1: Schedule Configuration
- **Start date** — date picker, defaults to the cycle's `start_date`
- **Trainer selection** — multi-select from `applicable_trainer_ids` (pre-filled from cycle settings) or all trainers linked to the academy/trainer
- Per selected trainer:
  - **Available time windows** — reuse the existing `DayAvailabilityPicker` pattern (day + start/end in 30-min increments)
  - **Level range** — min/max rating inputs (pre-filled from `trainer_profiles.preferred_min_rating/preferred_max_rating`)

#### Step 2: Scoring Weights (existing)
- Keep current weight sliders, presets, rating spread settings

#### Step 3: Additional Criteria (new)
- **Free-text textarea** — "Enter any additional rules or criteria"
- Placeholder examples: "Kids lessons only during the day, evenings always 4 players required"
- This text gets passed to the edge function which uses AI (Lovable AI / Gemini) to interpret and apply as post-processing filters/adjustments

### Technical approach

**New component: `src/components/cycles/GenerateProposalsWizard.tsx`**
- Multi-step dialog replacing both `GenerateProposalsGuard` and `ScoringWeightsDialog` in the generate flow
- Step 1: Date + trainer availability config
- Step 2: Scoring weights (extracted from existing `ScoringWeightsDialog`)
- Step 3: Additional criteria text field
- On submit, calls the edge function with all data

**Edge function: `supabase/functions/generate-proposals/index.ts`**
- Accept new fields in request body: `trainerAvailability` (array of trainer + time windows), `startDate`, `additionalCriteria` (string)
- When `trainerAvailability` is provided, auto-create temporary `availability_slots` from the config instead of requiring pre-existing slots
- When `additionalCriteria` is provided, call Lovable AI (Gemini Flash) to parse the text into structured rules, then apply them as post-filters on scored results (e.g., enforce min participants for evening slots, restrict kids to daytime)

**Updated `src/lib/cycles.ts`**
- Extend `generateProposals` to pass the new parameters

**Updated pages: `AcademyIntakeRequests.tsx` and `TrainerIntakeRequests.tsx`**
- Replace the Guard + ScoringWeightsDialog flow with the new wizard
- Remove `GenerateProposalsGuard` usage (the wizard handles the full flow)

### Files to create/edit
1. **Create** `src/components/cycles/GenerateProposalsWizard.tsx` — multi-step wizard dialog
2. **Edit** `supabase/functions/generate-proposals/index.ts` — accept trainer availability + additional criteria, auto-create slots, AI rule parsing
3. **Edit** `src/lib/cycles.ts` — extend `generateProposals` signature
4. **Edit** `src/pages/academy/AcademyIntakeRequests.tsx` — use new wizard
5. **Edit** `src/pages/TrainerIntakeRequests.tsx` — use new wizard

