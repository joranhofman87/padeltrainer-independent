## Goal

Make the Cycles tab table (under `/app/academy/calendar?tab=cycles`) use the same compact row density as the Players table, so rows aren't as tall.

## Reference styling (from `AcademyPlayers.tsx`)

```tsx
<Table className="[&_td]:py-1.5 [&_td]:px-3 [&_th]:py-1 [&_th]:px-3 [&_th]:h-9 text-sm">
  ...
  <TableRow className="h-8">
```

## Change

In `src/pages/academy/AcademyCyclusOverview.tsx`:

1. On the desktop `<Table>` at line ~732, add the same density classes:
   `className="[&_td]:py-1.5 [&_td]:px-3 [&_th]:py-1 [&_th]:px-3 [&_th]:h-9 text-sm"`
2. On the data `<TableRow>` at line 761, add `className="h-8 cursor-pointer hover:bg-muted/50"` (keep existing click behavior).
3. Sticky header: add `<TableHeader className="sticky top-0 bg-background z-10">` to match the players table.

No changes to columns, sorting, or data — purely visual density. Mobile cards section is untouched.

## Out of scope

- Changing column set or content
- Changes to other tabs
- Mobile card layout
