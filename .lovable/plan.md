

# Fix "View Public Profile" Link to Use Slug

## Problem
The "See public profile" button in the trainer sidebar navigates to `/trainer/{UUID}` instead of `/trainer/{slug}`. UUID-based links are legacy and should no longer be used.

## Changes

### 1. `src/components/trainer/TrainerSidebar.tsx`
- Store the trainer's `slug` alongside `trainerProfileId` (already available from `getTrainerProfile` which selects `*`)
- Update `handleViewPublicProfile` to use the slug (falling back to the UUID if slug is somehow missing)

**Specific edits:**
- Add state: `const [trainerSlug, setTrainerSlug] = useState<string | null>(null);`
- In the fetch callback (~line 100): `setTrainerSlug(trainerProfile.slug);`
- Line 146: change `trainer/${trainerProfileId}` to `trainer/${trainerSlug || trainerProfileId}`

### 2. `src/components/trainer/onboarding/OnboardingStep4Done.tsx`
Already fetches `slug` from `trainer_profiles` and uses it correctly -- no change needed.

### 3. Deprecate UUID-based trainer profile URLs (optional, future)
The `TrainerProfile.tsx` page already supports both UUID and slug lookups. For now, keeping the fallback is fine, but all outgoing links should prefer the slug.

## Impact
- Single file change (`TrainerSidebar.tsx`), 3 lines modified
- No database or routing changes needed

