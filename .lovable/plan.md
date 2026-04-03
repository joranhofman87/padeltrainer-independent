

# Add Location Name to Cycle Selector Dropdowns

## Problem
Multiple registrations have the same name (e.g., "Padeltrainingen zomer 2026"), making it impossible to distinguish them in the dropdown. Each cycle has a `location` field with `name` and `city`.

## Change

### `src/components/cycles/ProposalWorkflowSteps.tsx` (line 86)
Change the SelectItem label from `{cycle.name}` to show location:
```
{cycle.name}{cycle.location?.name ? ` — ${cycle.location.name}` : ''}
```

### `src/components/cycles/AddIntakeRequestDialog.tsx` (line 336)
Same change for the cycle selector in the manual registration dialog.

Both files already receive `Cycle[]` which includes the joined `location` data. No data fetching changes needed.

