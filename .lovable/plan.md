

# Redesign: Steps-First Navigation for Registration Detail Page

## Problem
The current page uses 4 tabs (Registrations, Proposals, Settings, Waiting List) with workflow steps hidden inside the Proposals tab. Non-technical users don't know what to do next. The tabs feel disconnected from the actual workflow — trainers must figure out which tab to click and when.

## Approach
Replace tabs with the **workflow steps as primary navigation**. The numbered steps are always visible at the top, acting as both progress indicator AND navigation. Clicking a step shows its content below. Settings and Waiting List become secondary actions (gear icon in the header, link in sidebar) since they're not part of the core flow.

## The Flow (5 steps)

```text
 ① Registrations    ② Review Links    ③ Generate    ④ Review & Edit    ⑤ Approve & Book
     [active]           [upcoming]       [upcoming]     [upcoming]          [upcoming]
```

1. **Registrations** — The existing table (status filters, search, CSV, add manual). This is step 1 because the trainer first needs to see who signed up. Description: "77 registrations"
2. **Review Links** — The `PreGenerationReview` component. Description: "3 actions pending" or "All clear"
3. **Generate** — The `GenerateProposalsWizard` inline content. Description: "77 new requests"
4. **Review & Edit** — The `ProposalScheduleGrid` with drag-and-drop. Description: "12 proposals"
5. **Approve & Book** — The overview/approval flow. Description: "0 confirmed"

Each step is clickable (navigates to that content). Completed steps show a checkmark. The active step is highlighted. Users can go back to any completed step.

## Secondary navigation
- **Settings**: Move to a gear icon button in the page header (next to the share link button). Opens a sheet/drawer or navigates to `?view=settings`
- **Waiting List**: Keep as a small link/button in the header or remove from this page entirely (it's accessible from the sidebar)

## Implementation

### `src/components/cycles/ProposalWorkflowSteps.tsx`
Refactor into the primary navigation component:
- Each step becomes clickable (`onClick` callback with step identifier)
- Add connecting lines between steps (horizontal on desktop, vertical on mobile)
- Steps: `registrations`, `review-links`, `generate`, `review-edit`, `approve`
- New prop: `activeStep: string` — which step's content is currently shown
- New prop: `onStepClick: (step: string) => void`
- Allow clicking completed or active steps (not upcoming ones)

### `src/pages/academy/AcademyCycleDetail.tsx`
- Remove `Tabs`/`TabsList`/`TabsContent` structure
- Replace with: workflow steps at top, then conditional content rendering based on `activeStep` (stored in URL as `?step=registrations`)
- Step 1 content: existing registrations table + filters
- Step 2 content: `PreGenerationReview`
- Step 3 content: `GenerateProposalsWizard` inline
- Step 4 content: `ProposalScheduleGrid`
- Step 5 content: overview/approval actions
- Settings: add a gear icon button in header that opens `CycleForm` in a Sheet
- Waiting List: small text link in header or omit (still reachable from sidebar list)

### Step status logic
- **Registrations**: always accessible; completed once there are registrations
- **Review Links**: accessible once registrations exist; completed when no pending actions
- **Generate**: accessible once links are reviewed (or no pending); completed once proposals exist
- **Review & Edit**: accessible once proposals are generated; completed when user continues
- **Approve & Book**: accessible from review step; completed when confirmed

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalWorkflowSteps.tsx` | Refactor: clickable steps, `activeStep`/`onStepClick` props, connecting lines |
| `src/pages/academy/AcademyCycleDetail.tsx` | Replace Tabs with step-based content rendering, move Settings to header Sheet |

