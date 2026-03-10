

## Fix: Academy-owned cycles on club pages get generic (unbranded) URLs

### Root Cause
The cycle `4b9e4093-72bc-4415-9918-abb1efb27d3c` has `owner_type: 'academy'` (not `'club'`). The `LocationOpenCycles` component only handles the `club` case in `getRegisterPath` — academy-owned cycles fall through to the generic `/register/:id` path.

### Solution
Update `LocationOpenCycles` to also generate branded URLs for academy-owned cycles.

**`src/components/club/LocationOpenCycles.tsx`:**
1. After fetching cycles, fetch the slug for any academy-owned cycles by querying `academy_profiles` for their `owner_id`s.
2. Store a map of `owner_id → slug` in state.
3. In `getRegisterPath`, add a branch for `owner_type === 'academy'`:
   ```
   if (cycle.owner_type === 'club' && clubSlug)
     → clubs/${clubSlug}/register/${cycle.id}
   if (cycle.owner_type === 'academy' && academySlugs[cycle.owner_id])
     → academies/${slug}/register/${cycle.id}
   else
     → register/${cycle.id}
   ```

### Files to change
- `src/components/club/LocationOpenCycles.tsx` — add academy slug lookup + branded path generation

