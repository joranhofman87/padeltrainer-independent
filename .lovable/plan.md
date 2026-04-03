

# Fix: Allow Clicking "Review Links" Step

## Problem
When the active step is "Registrations" and there are registrations, the "Review Links" step is marked as `upcoming` (line 52), making it unclickable. The trainer can't advance to step 2.

## Fix

### `src/components/cycles/ProposalWorkflowSteps.tsx`
Remove line 52 (`if (hasRegistrations && activeStep === 'registrations') return 'upcoming'`). The logic should be:
- If no registrations → `upcoming`
- If `activeStep === 'review-links'` → `active`
- If links are reviewed and we're past this step → `completed`
- Otherwise (has registrations, not yet reviewed) → `active` (clickable but not highlighted)

The corrected `review-links` case:
```typescript
case 'review-links':
  if (!hasRegistrations) return 'upcoming';
  if (linksReviewed && (hasProposals || activeStep === 'generate' || activeStep === 'review-edit' || activeStep === 'approve'))
    return 'completed';
  if (activeStep === 'review-links') return 'active';
  return linksReviewed ? 'completed' : 'active';
```

This makes step 2 clickable as soon as there are registrations, which is the correct behavior.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalWorkflowSteps.tsx` | Remove the guard that marks review-links as upcoming when on registrations step |

