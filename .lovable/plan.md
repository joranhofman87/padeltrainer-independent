

# Fix Academy Registration Share Link

## Problem
The "Registratielink Delen" button in the academy cycles table generates `padeltrainer.ai/nl/register/{id}` instead of `padeltrainer.ai/nl/academies/{slug}/register/{id}`. This is because `AcademyCycles.tsx` doesn't pass the `ownerSlug` prop to `CyclesTable`.

## Fix

**File: `src/pages/academy/AcademyCycles.tsx`** — Add `ownerSlug={activeAcademy?.slug}` to the `CyclesTable` component (line 121):

```tsx
<CyclesTable
  cycles={cycles}
  locations={locations}
  onEdit={(c) => navigate(`/app/academy/cycles/${c.id}/edit`)}
  onDuplicate={(c) => navigate(`/app/academy/cycles/new?type=registration&duplicateFrom=${c.id}`)}
  onDeleted={fetchCycles}
  ownerType="academy"
  ownerSlug={activeAcademy?.slug}
/>
```

The existing `handleCopyLink` logic in `CyclesTable.tsx` already handles the academy path correctly (`academies/${ownerSlug}/register/${cycle.id}`) — it just wasn't receiving the slug.

### Files
- `src/pages/academy/AcademyCycles.tsx` — 1 line addition

