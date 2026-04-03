

# Make Review Links Step More Obvious + Always-Visible "Continue to Generate" Button

## Problem
The Review Links step content is too small and hidden behind collapsible sections. The "Continue to Generate" button only shows after all link suggestions are resolved, and there's no clear call-to-action guiding the trainer.

## Changes

### `src/components/cycles/PreGenerationReview.tsx`
1. Add `onContinue` prop (callback to navigate to Generate step)
2. Add `hasPendingLinks` prop (boolean, true when suggestions remain)
3. Render a prominent "Continue to Generate" button at the **top** of the component, always visible:
   - When `hasPendingLinks` is true: button is disabled, tooltip/text says "Resolve all link suggestions first"
   - When false: button is enabled, primary green style
4. Remove all `Collapsible` wrappers — show link suggestions and unmatched mentions directly (no collapse/expand)
5. Keep the "All clear" green card but place it below the continue button
6. Unmatched mentions always shown (no collapsible), keeping their muted info style

### `src/pages/academy/AcademyCycleDetail.tsx`
1. Remove the separate "Continue to Generate" button block (lines 645-651)
2. Pass `onContinue={() => setActiveStep('generate')}` and `hasPendingLinks={pendingLinkActions > 0}` to `PreGenerationReview`

## Result
- Trainer lands on step 2 and immediately sees a big "Continue to Generate" button at top
- If there are pending links, the button is greyed out with explanatory text
- All suggestions and unmatched mentions are visible without clicking to expand
- Clear, guided flow: resolve items → button becomes active → click to proceed

## Files

| File | Change |
|------|--------|
| `src/components/cycles/PreGenerationReview.tsx` | Add continue button at top, remove collapsibles, add `onContinue`/`hasPendingLinks` props |
| `src/pages/academy/AcademyCycleDetail.tsx` | Pass new props, remove standalone continue button |

