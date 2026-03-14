

# Show Success Message on Registration Confirmation Page

## Problem
The cycle settings form has a "Success Message" field (shown in image-298), but the registration success page (image-297) doesn't display it properly. Currently the code at line 339 uses an either/or approach: if `success_message` exists, it replaces the default content including the "What happens next?" steps. The custom message should appear **above** the steps, not replace them.

## Changes

### `src/components/cycles/CycleApplicationForm.tsx` (lines 332-370)
Restructure the success state to always show:
1. The check icon + title
2. **Custom success message** (if configured) — rendered in a styled card similar to `WelcomeMessageCard`, with `whitespace-pre-line`
3. The default subtitle text ("Thank you for your application...")
4. The "What happens next?" steps — always visible
5. The back button

This is a small change — remove the ternary that swaps content, and instead conditionally render the custom message block before the steps block, keeping both visible.

### Files
- `src/components/cycles/CycleApplicationForm.tsx` — ~15 lines changed in the success render block

