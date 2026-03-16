

## Convert Registration Create/Edit from Dialog to Dedicated Page

The CycleForm component (1850 lines) currently renders inside a `Dialog`. As the form has grown with price tables, columns, duration options, etc., a full page is more appropriate. We'll create dedicated pages and routes for both trainer and academy flows.

### Changes

**1. New page: `src/pages/CycleFormPage.tsx`**
- A wrapper page component that reads route params (`formType`: registration/event, `cycleId` for editing) and query params.
- Fetches the cycle data if editing (using `cycleId`).
- For **trainer**: fetches `trainerId`, `hourlyRate`, `ratingSystem`, and `locations` from `trainer_profiles` / `trainer_locations` (same logic as `TrainerCycles.tsx`).
- For **academy**: fetches trainers, locations, trainerLocationMap (same logic as `AcademyCycles.tsx`).
- Renders a refactored `CycleForm` (without Dialog wrapper) inside a standard page layout with a back button header.
- `onSuccess` navigates back to the cycles list.

**2. Refactor `src/components/cycles/CycleForm.tsx`**
- Extract the form content (everything inside `DialogContent`) into the main export, removing the `Dialog`/`DialogContent`/`DialogHeader` wrapper.
- Remove `open` and `onOpenChange` props — the component is now always rendered when the page mounts.
- Replace `DialogFooter` with a regular footer div with the same buttons.
- Add an `onCancel` prop that navigates back.
- The component remains ~1850 lines but the outer shell changes from Dialog to a card/section layout.

**3. Routes in `src/components/DomainRouter.tsx`**
- Add under trainer routes:
  - `cycles/new` → `CycleFormPage` (formType from query param `?type=registration|event`)
  - `cycles/:cycleId/edit` → `CycleFormPage`
- Add under academy routes:
  - `cycles/new` → `CycleFormPage`
  - `cycles/:cycleId/edit` → `CycleFormPage`

**4. Update `src/pages/TrainerCycles.tsx`**
- Replace `setShowCreateDialog(true)` with `navigate('/app/trainer/cycles/new?type=registration')`.
- Replace `setShowCreateEventDialog(true)` with `navigate('/app/trainer/cycles/new?type=event')`.
- Replace `setEditingCycle(c)` with `navigate(`/app/trainer/cycles/${c.id}/edit`)`.
- Remove `CycleForm` imports and dialog state.

**5. Update `src/pages/academy/AcademyCycles.tsx`**
- Same pattern: navigate to `/app/academy/cycles/new?type=registration` or `/app/academy/cycles/${c.id}/edit`.
- Remove `CycleForm` imports and dialog state.
- Keep the duplicate handler — navigate to `cycles/new?type=registration&duplicateFrom={id}`.

### Files to modify/create
- `src/components/cycles/CycleForm.tsx` — remove Dialog wrapper
- `src/pages/CycleFormPage.tsx` — new page component
- `src/components/DomainRouter.tsx` — add routes
- `src/pages/TrainerCycles.tsx` — navigate instead of dialog
- `src/pages/academy/AcademyCycles.tsx` — navigate instead of dialog

