

## Simplify Registration Cards on Trainer & Location Pages

All three public-facing registration components currently show full inline details (description, `CycleDetailDisplay`, and even an inline application form). The academy version is about to be simplified -- the same treatment needs to apply to trainer and location pages.

### Components to Update

**1. `src/components/trainer/TrainerOpenCycles.tsx`**
- Remove inline `cycle.description` rendering (line 121-123)
- Remove `<CycleDetailDisplay>` (line 124)
- Remove the entire `Collapsible` pattern with inline `CycleApplicationForm` (lines 102-198)
- Replace with a simple card showing: name, date range, deadline
- Add "More info" / "Apply" buttons that navigate to the existing generic registration page: `register/:cycleId` (using `getMarketingPath`)
- Remove unused imports: `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger`, `CycleApplicationForm`, `CycleDetailDisplay`, `Alert`, `ChevronDown`, `ChevronUp`

**2. `src/components/club/LocationOpenCycles.tsx`**
- Same treatment: remove inline description, `CycleDetailDisplay`, and `Collapsible` + `CycleApplicationForm`
- Replace with compact cards with "More info" / "Apply" buttons
- For club-owned cycles, navigate to `clubs/:slug/register/:cycleId`; for trainer-owned cycles, navigate to `register/:cycleId`
- Remove the trainer-fetching logic (lines 53-84) since the application form is no longer inline
- Remove unused imports

**3. `src/components/academy/AcademyOpenCycles.tsx`** (the approved but not-yet-implemented change)
- Remove `cycle.description` (line 145-147) and `<CycleDetailDisplay>` (line 148)
- Add "More info" button alongside the existing "Apply" button, both navigating to `academies/:slug/register/:cycleId`

### Navigation Pattern
- Academy cycles → `academies/:slug/register/:cycleId` (branded page, already exists)
- Club cycles → `clubs/:slug/register/:cycleId` (branded page, already exists)
- Trainer cycles → `register/:cycleId` (generic page, already exists)

All detail pages already render the full description, `CycleDetailDisplay`, and application form -- no changes needed there.

