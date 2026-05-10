## Goal

Take the clean header + toolbar pattern we landed on the Players page and reuse it on every list/table screen. Two outcomes: (1) consistent UX across Players, Registrations, Invoices, etc., and (2) less duplicated layout code per page.

## The Players pattern (target)

```text
[Title    N items]                         [Secondary action] [Primary action]
[Tabs]                                                     [Optional view toggle]
[ Search 🔍 ] [Filter] [Filter] [Filter]                [Columns ⌄] [Extras]
[ ── table / cards ── ]
```

Three rules:
1. **Header row**: page title + count on the left, action buttons on the right (no separate description card, no separate "Action Buttons" row).
2. **Tabs row**: status tabs only. Optional right-aligned view toggle (List/Schedule).
3. **Toolbar row**: search input is always first (left), then filters in a wrap row, then trailing slot (Columns dropdown, CSV button).

## Approach

Two small shared components in `src/components/ui/`:

- **`PageHeader`** — title, optional subtitle, item count, right-side action slot.
- **`TableToolbar`** — search input prop + filter children + trailing slot. Handles wrap + spacing.

Both are pure presentational, no data fetching. They wrap existing primitives (`Input`, `Button`, etc.) and standardise spacing (`gap-2`, `flex-wrap`, search `min-w-[200px] max-w-sm`).

Page-level changes are mostly: delete duplicated layout JSX, swap in `<PageHeader …>` and `<TableToolbar search={…}>{filters}</TableToolbar>`. Stats cards, bulk-action bars, tables themselves stay unchanged.

## Pages in scope (this iteration)

1. **`src/pages/academy/AcademyInvoices.tsx`**
   - Replace header block (lines 600–607), action button row (643–652), and the toolbar inside the Tabs block (708–772) with `PageHeader` + `TableToolbar`.
   - Keep the stats card grid and the bulk-action sticky bar.
   - Move "New invoice" into the header's action slot (matches Players' "Add player").

2. **`src/pages/trainer/TrainerInvoices.tsx`** — same treatment, parity with academy.

3. **`src/pages/academy/AcademyIntakeRequests.tsx`** ("Registrations")
   - Replace header (235–242) with `PageHeader`.
   - Move "Add registration" + "CSV" buttons into header's action slot.
   - Keep `ProposalWorkflowSteps` between header and tabs.
   - Tabs row keeps the right-side List/Schedule toggle.
   - Add a `TableToolbar` row with search (filter by player name) + cycle/status filters that already exist further down.

4. **`src/pages/TrainerIntakeRequests.tsx`** — same treatment.

## Pages out of scope this round (call out, don't touch yet)

These also have tables but each has bespoke quirks; doing them in a follow-up keeps the diff reviewable:

- `AcademyWaitingList.tsx`, `TrainerWaitingList.tsx`
- `AcademyTrainers.tsx`
- `ClubPlayers.tsx`, `ClubCycles.tsx`
- `AcademyCycles.tsx` (already close to the pattern after recent change)
- Admin pages (`AdminUsers`, `AdminTrainers`, `AdminPricing`, `AdminPlayerRatings`)

Once `PageHeader` + `TableToolbar` are in, converting each is a 5-minute swap.

## Component shape

```tsx
// PageHeader
<PageHeader
  title={t('invoices.title')}
  count={invoices.length}
  countLabel={{ one: 'invoice', other: 'invoices' }}
  description={t('invoices.description')}  // optional, hidden on small screens
  actions={
    <>
      <Button variant="outline" size="sm">…</Button>
      <Button size="sm">…</Button>
    </>
  }
/>

// TableToolbar
<TableToolbar
  searchPlaceholder={t('invoices.searchPlaceholder')}
  searchValue={searchQuery}
  onSearchChange={setSearchQuery}
  trailing={<ColumnsDropdown />}  // optional right-side slot
>
  <Select …/>  {/* trainer */}
  <Select …/>  {/* location */}
  <Select …/>  {/* status */}
</TableToolbar>
```

## Refactor wins

- Each page loses ~20–40 lines of layout JSX.
- Single place to tweak spacing, mobile wrap behaviour, search width.
- Future pages get the standard header/toolbar for free.

## Out of scope

- Table internals (columns, sorting, row rendering).
- Stats cards, bulk-action bars, mutations.
- Mobile card-vs-table switch logic.
- Admin and Club pages (queued for the next pass).
