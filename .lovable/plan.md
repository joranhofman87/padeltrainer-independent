

## Remove Hourly Rate from Trainer Profiles

### Summary
Remove the hourly rate display from trainer profile pages, trainer listing cards, and the onboarding step where it's collected. Prices vary per club/slot, so players should see them on the slots instead.

### Changes

**1. `src/pages/TrainerProfile.tsx`**
- Remove the hourly rate quick stat (line 332)
- Remove `hourlyRate={trainer.hourly_rate}` prop from `ProfileHeroCard` (line 468)
- Remove the `Euro` import if no longer used

**2. `src/components/profiles/ProfileHeroCard.tsx`**
- Remove `hourlyRate` from props interface and usage (the `€{hourlyRate}/hour` display block around line 152-156)

**3. `src/pages/Trainers.tsx`**
- Remove `€{trainer.hourly_rate}/hr` display from both card and list views (lines ~604-606, ~727-729)
- Remove price-based sorting options (`price-low`, `price-high`) and price range filter logic (lines ~384-385, ~440-442)

**4. `src/pages/TrainersCity.tsx`**
- Remove `€{trainer.hourly_rate}/hr` display (lines ~455-458)
- Remove price-based sorting and min/max rate calculations (lines ~214-216, ~232-233)

**5. `src/components/trainer/onboarding/OnboardingStep1Profile.tsx`**
- Remove the hourly rate field entirely (the input, state, and save logic for `hourly_rate`)

### Files to edit
- `src/pages/TrainerProfile.tsx`
- `src/components/profiles/ProfileHeroCard.tsx`
- `src/pages/Trainers.tsx`
- `src/pages/TrainersCity.tsx`
- `src/components/trainer/onboarding/OnboardingStep1Profile.tsx`

### Note
The `hourly_rate` column stays in the database — it's still used internally for default pricing calculations when creating slots/cycles. We're only removing it from public-facing trainer profile displays.

