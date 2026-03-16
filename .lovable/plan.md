

# Convert Overview from Dialog to Full Page

## Why a page is better
- More room for richer data: trainer workload balance, rating spread warnings, empty slot highlights
- Mobile-friendly — no cramped dialog, natural scroll
- Fits the existing routing pattern (`/app/academy/intake-requests/overview`, `/app/trainer/intake-requests/overview`)

## What to build

### 1. New page component: `ProposalOverviewPage.tsx`
A full-page read-only overview replacing the current dialog. Sections:

**Top bar**: Back to editing button + "Approve & Book all" CTA (sticky on mobile)

**Summary cards row** (3-4 cards):
- Total slots created
- Players assigned vs total requests
- Empty slots (highlighted if high)
- Trainer workload distribution (e.g., "Patrick: 24 slots, Yari: 8 slots" — flag imbalance)

**Warnings/alerts section** (conditional):
- Empty slots count warning
- Groups with only 1 player (ideally needs 2+)
- Large rating gaps within a single slot (e.g., player rated 1 paired with player rated 4)
- Trainer with disproportionately more/fewer slots

**Per-trainer breakdown** (collapsible cards):
- Trainer avatar + name + stats badge
- Day-by-day table: time | assigned players with ratings | group size indicator
- Visual indicator for slots needing attention (empty, rating mismatch)

### 2. Routing
- Add routes: `intake-requests/overview` under both trainer and academy paths in `DomainRouter.tsx`
- Pass `scheduleSlots` data via route state (`navigate(..., { state: { slots } })`) to avoid refetching

### 3. Navigation flow
- "Continue" button in Step 3 navigates to the overview page instead of opening a dialog
- "Back to editing" on overview page navigates back
- "Approve & Book all" on overview page triggers approval then redirects back to intake-requests

### 4. Remove dialog
- Delete `ProposalOverviewPanel.tsx` dialog (replaced by page)
- Remove `showOverview` state from parent pages
- Update `ProposalWorkflowSteps` — Step 4 action navigates to overview route

### 5. Mobile optimization
- Summary cards stack vertically
- Trainer sections as collapsible accordions
- Sticky bottom bar with approve CTA

## Files to create/modify
- **Create**: `src/pages/ProposalOverviewPage.tsx`
- **Modify**: `src/components/DomainRouter.tsx` — add overview routes
- **Modify**: `src/pages/academy/AcademyIntakeRequests.tsx` — navigate instead of dialog
- **Modify**: `src/pages/TrainerIntakeRequests.tsx` — navigate instead of dialog
- **Modify**: `src/components/cycles/ProposalWorkflowSteps.tsx` — update Step 4 action
- **Delete**: `src/components/cycles/ProposalOverviewPanel.tsx`

