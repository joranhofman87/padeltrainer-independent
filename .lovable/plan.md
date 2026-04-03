

# Inline the Generate Wizard into Step 3

## Problem
Step 3 (Generate) currently shows a button that opens a popup dialog. This is inconsistent with steps 1-2 which show content inline, and adds an unnecessary click.

## Approach
Refactor `GenerateProposalsWizard` to support an `inline` mode that renders its 3 sub-steps (Schedule/Trainers, Scoring Weights, Additional Criteria) directly on the page inside a Card — no Dialog wrapper. The "Generate" button at the top follows the same pattern as step 2's "Continue to Generate" button.

## Changes

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Add an `inline?: boolean` prop
- When `inline={true}`: render content inside a `Card` instead of `Dialog/DialogContent`
  - Sub-steps (1-3) shown as horizontal tabs or a simple stepper within the card
  - Back/Next navigation at the bottom of the card (same as now, just not in a dialog footer)
  - The final "Generate" button stays at the bottom of the last sub-step
- When `inline={false}` (default): keep current Dialog behavior for backward compatibility
- Remove `open`/`onOpenChange` requirement when inline (they become optional)

### `src/pages/academy/AcademyCycleDetail.tsx`
- In the `activeStep === 'generate'` block, replace the "open wizard" button with `<GenerateProposalsWizard inline cycle={cycle} ... />`
- Remove `showWizard` state and the Dialog-based wizard render
- The wizard renders directly on the page, showing sub-step 1 immediately
- When proposals already exist, keep the current "already generated" UI with reset/review buttons above the inline wizard

## Result
- Step 3 shows the wizard content directly on the page — no popup
- Consistent with steps 1 and 2 (content inline, action buttons visible)
- One fewer click to configure and generate proposals
- The 3 internal wizard steps (trainers, weights, criteria) still navigate with Back/Next within the card

## Files

| File | Change |
|------|--------|
| `src/components/cycles/GenerateProposalsWizard.tsx` | Add `inline` prop, render Card instead of Dialog when true |
| `src/pages/academy/AcademyCycleDetail.tsx` | Replace wizard button + dialog with inline wizard render |

