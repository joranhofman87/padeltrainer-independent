

# Move Edit/Delete Buttons Above the Cards

## Problem
The Edit and Delete buttons sit in the top header bar next to the back arrow, making them easy to miss. The user wants them placed prominently above the detail cards.

## Change

### `src/pages/academy/AcademySlotDetail.tsx`

1. **Remove** the Edit/Delete buttons from the header bar (lines 508-523)
2. **Add** them as a row between the header and the cards grid (inside `<main>`, above the `grid` div around line 527-528):

```tsx
<main className="container mx-auto px-4 py-6">
  {!isEditing && (
    <div className="flex items-center justify-end gap-2 max-w-4xl mb-4">
      <Button variant="outline" className="gap-1.5" onClick={startEditing}>
        <Pencil className="h-4 w-4" />
        {tTrainer('calendar.editSlot', 'Edit')}
      </Button>
      <Button
        variant="outline"
        className="gap-1.5 text-destructive hover:text-destructive"
        onClick={() => { setDeleteCyclus(false); setDeleteOpen(true); }}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )}
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
    ...
  </div>
</main>
```

This places the buttons right-aligned above the Details and Players cards, making them immediately visible.

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademySlotDetail.tsx` | Move Edit/Delete buttons from header to above the card grid |

