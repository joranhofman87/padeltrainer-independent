

# Replace Create Tab Content: CycleForm → BulkCreateSheet (inline)

## Problem
The "Create" tab currently embeds the `CycleForm` (registration/intake form). The user wants it to show the BulkCreateSheet content (training cyclus creator with slots, pricing, players) instead — the same UI that's currently in the drawer/sheet.

## Approach
Extract the inner content of `BulkCreateSheet` into a standalone component (`BulkCreateContent`) that can render either inside a Sheet or inline on a page. Then use it directly in the Create tab, removing the CycleForm.

## Changes

| File | Change |
|------|--------|
| `src/components/trainer/AddSlotDialog.tsx` | Refactor: extract all the form content (lines ~1006-1740) from inside `<SheetContent>` into a new `BulkCreateContent` component. `BulkCreateSheet` becomes a thin wrapper that renders `<Sheet><SheetContent><BulkCreateContent /></SheetContent></Sheet>`. Export `BulkCreateContent` separately. |
| `src/pages/academy/AcademyCalendar.tsx` | Replace the Create tab content: remove the `CycleForm` + registration/event toggle, render `<BulkCreateContent>` inline instead. Remove `createFormType` state. Remove the `CycleForm` import. Keep the existing `BulkCreateSheet` dialog for other entry points (e.g. manage tab's "+ New" button) or remove it if no longer needed. Pass the same props that the sheet currently receives (trainerId, locations, trainers, academyId, onSlotsCreated callback that refreshes and switches to overview). |

## Detail

### BulkCreateContent props
Same as current `BulkCreateSheetProps` minus `open` and `onOpenChange`:
- `trainerId`, `defaultDate`, `defaultTime`, `defaultDuration`, `defaultWeeks`
- `onSlotsCreated`, `availableLocations`, `availableTrainers`
- `prefillFromCyclusId`, `academyId`

### Create tab rendering
```tsx
<TabsContent value="create" className="mt-4">
  <div className="max-w-lg">
    <BulkCreateContent
      trainerId={selectedSlotTrainerId}
      defaultDuration={60}
      defaultWeeks={8}
      onSlotsCreated={handleSlotsCreated}
      availableLocations={locations}
      availableTrainers={trainers.map(t => ({ id: t.id, name: t.name }))}
      academyId={activeAcademy?.id}
    />
  </div>
</TabsContent>
```

### BulkCreateSheet becomes a wrapper
```tsx
export function BulkCreateSheet({ open, onOpenChange, ...contentProps }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full h-full sm:w-auto sm:h-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>...</SheetHeader>
        <BulkCreateContent {...contentProps} />
      </SheetContent>
    </Sheet>
  );
}
```

This keeps the Sheet version working for the Trainer calendar while giving the Academy Create tab the same form inline.

