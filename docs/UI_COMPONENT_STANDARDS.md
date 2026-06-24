# UI component standards

Rules for building and changing UI in this app. The goal is that a feature shared by more than one
role (trainer / academy / club / admin / player) lives in **one** component, and role pages are
thin wrappers that inject role context (IDs, query keys, nav targets, role-specific labels).

This document was introduced with **Slice 1** of the frontend reuse-hardening sprint (the invoice
form). Treat the invoice form as the worked example of the pattern below.

## TL;DR for anyone (human or AI) editing a page

1. **Reach for a shared primitive before writing markup.** The list below covers most layout needs.
2. **If trainer AND academy (or any two roles) need the same thing, it goes in a shared component** —
   not copied into each role's page. Put it under `src/components/<feature>/` and have each role
   page render it with props.
3. **Never duplicate money/total math inline.** Use the shared helpers in `src/lib/`.
4. **Don't fork a component just to change a label or an ID.** Inject those via props.

## Shared primitives (use these, don't reinvent)

| Primitive | Location | Use for |
| --- | --- | --- |
| `AppPage` | `@/components/ui/app-page` | Standard page shell / width / padding |
| `PageHeader` | `@/components/ui/page-header` | Page title + description + actions row |
| `DataTableCard` | `@/components/ui/data-table` | Card-wrapped scrollable table (+ `compactDataTableClass`) |
| `TableToolbar` | `@/components/ui/table-toolbar` | Search + filter row above a table |
| `SortableTableHead` | `@/components/ui/sortable-table-head` | Clickable sortable `<th>` (pairs with `useTableSort`) |
| `useTableSort` | `@/hooks/useTableSort` | Sort key + direction state for tables |
| `EmptyState` | `@/components/ui/empty-state` | Empty-list / no-results placeholder |
| `ListPageSkeleton` | `@/components/ui/list-page-skeleton` | Loading skeleton for list pages |
| `ListPageShell` | `@/components/ui/list-page-shell` | List/table **page** chrome: `AppPage` + `PageHeader` + full-page loading |
| `ListPageState` | `@/components/ui/list-page-shell` | Loading / error / empty / content switch for a list body |
| `ListPagination` | `@/components/ui/list-pagination` | Page navigation for paginated lists |
| `StatTile` | `@/components/ui/stat-tile` | Dashboard metric tile |
| `Calendar` | `@/components/ui/calendar` | Date picking |

> `SortableTableHead` was moved from `components/admin/` to `components/ui/` in this slice — it is a
> role-neutral primitive (already used by academy/trainer/cycle pages), not an admin-only one.

## How to build a list/table page

Every list/table page (academy, trainer, club, player, admin) has the same shape. Compose it from the
shared primitives — don't re-wire the page chrome or the loading/empty/error states by hand.
**Academy pages are the reference pattern** (e.g. `AcademyTrainers`).

```tsx
<ListPageShell
  title={t('trainers.title')}
  description={t('trainers.description')}
  actions={<CreateButton />}
  headerAfter={<p className="mt-2 text-xs text-muted-foreground">{hint}</p>}  // optional sub-header line
  isLoading={isLoading}                                                       // → full-page skeleton
>
  <TableToolbar searchValue={q} onSearchChange={setQ}>{filters}</TableToolbar>

  <ListPageState
    isEmpty={rows.length === 0}
    error={error}
    empty={<EmptyState icon={Users} title={t('empty')} description={t('emptyDescription')} />}
  >
    <DataTableCard mobile={<MobileCards rows={rows} />}>
      <Table className={compactDataTableClass}>
        <TableHeader>
          <SortableTableHead sortKey="name" currentSortKey={sort.key} currentDirection={sort.direction} onSort={handleSort}>
            {t('name')}
          </SortableTableHead>
          {/* … */}
        </TableHeader>
        <TableBody>{rows.map(renderRow)}</TableBody>
      </Table>
    </DataTableCard>
    <ListPagination page={page} pageCount={pageCount} onPageChange={setPage} />
  </ListPageState>
</ListPageShell>
```

Rules of thumb:
- **`ListPageShell`** owns the page chrome (`AppPage` + `PageHeader`) and the *full-page* loading
  skeleton. Use `isLoading` for "skeleton replaces the whole page"; if the header should stay visible
  while only the table loads, leave `isLoading` off and wrap just the body in `<ListPageState isLoading>`.
  `headerAfter` keeps a hint/sub-header tight under the title.
- **`ListPageState`** standardizes the body's data states with a fixed precedence:
  **loading → error → empty → content**. Pass the page's own `<EmptyState/>` as `empty` (stays
  on-brand and pixel-identical). It works inside a `<TabsContent>` too — one per tab.
- **Sorting**: `useTableSort` + `SortableTableHead` for client-side sort; for server-paged lists drive
  sort via RPC params (see the invoice list scaffold) and keep `SortableTableHead` wired to that state.
- **Pagination**: render `ListPagination` inside the ready branch of `ListPageState` so it disappears
  with loading/empty.
- **Mobile**: pass a card list to `DataTableCard`'s `mobile` slot (`flushOnMobileCardClass()` for the
  full-width surface); desktop `<table>` and mobile cards render from the same row data.

Keep page-specific bits (data fetching, columns, filters, bulk actions, dialogs) in the page — the
shell standardizes the *frame*, not the contents.

## Shared invoice form (the worked example)

The trainer and academy create/edit invoice pages were ~97% identical. The duplicated parts are now
shared; each page keeps only what is genuinely role-specific.

| Concern | Where it lives |
| --- | --- |
| Line-items editor (desktop grid + mobile cards, add/remove/update, preset slot) | `@/components/invoices/InvoiceLineItemsEditor` |
| Subtotal / VAT / total display + "prices include VAT" toggle | `@/components/invoices/InvoiceTotalsSummary` |
| VAT / subtotal / total math | `@/lib/invoiceFormTotals` (`computeCreateInvoiceTotals`, `computeEditInvoiceTotals`) |
| Line-item shape | `InvoiceFormLineItem` from `@/lib/invoiceFormTotals` |
| Customer / receiver section | `@/components/invoices/InvoiceCustomerSection` (existing) |

What each role page still owns (do **not** merge these): the receiver/owner context source
(`useAuth` vs `useAcademyContext`), the INSERT/UPDATE payload field (`trainer_id` vs
`academy_profile_id`), React-Query invalidation keys, navigation paths, academy-only behaviour
(sync-to-bookings, cancel / mark-paid reason modals, status-history card), status-lock validation,
and the per-role i18n label namespace (`invoiceForm.*` vs `invoiceEdit.*`).

## Shared invoice list scaffold (slices 2–3)

The trainer + academy invoice LIST pages (`TrainerInvoices`, `AcademyInvoices`) were near-identical.
The shared scaffold below was extracted across two slices; each page keeps its own data fetching,
summary RPCs, status enums, tab partition, filters, mobile card list, and bulk actions.

| Concern | Where it lives |
| --- | --- |
| Header-sort affordance + paid-tab default + header-key → RPC sort mapping | `@/components/invoices/useInvoiceListSort` (`useInvoiceListSort`, `mapInvoiceSortKeyToRpc`) |
| Page-scoped row selection (Set + toggles + `selectedInvoices`) | `@/components/invoices/useInvoiceListSelection` |
| Windowed pager (first/last + ±2 window + ellipsis, clamps internally) | `@/components/ui/list-pagination` (`ListPagination`) — domain-neutral; also used by the player lists. Optional `className` (invoices pass `mt-4`). |
| Page-count math | `invoiceListPageCount` in `@/lib/invoicesList` |
| 3-up KPI stat-tile row (values injected as props; never owns a query) | `@/components/invoices/InvoiceStatTiles` |
| Status badge (server `computed_status` + canonical `InvoiceStatusBadge` + audit tooltip) | `@/components/invoices/InvoiceListStatusBadge` |
| Desktop table (9 cols; role actions via a `renderActions` slot) | `@/components/invoices/InvoiceListTable` |

Each page still owns: the `useTrainer/AcademyInvoices` RPC call + its scope params, the scoreboard
summary reads (trainer's single unscoped summary vs academy's filtered fan-out with `isError`
fallback — **do not** unify the value source; pass values into `InvoiceStatTiles` as props), the
status-filter `<Select>` enums, the tab partition (academy's `unpaid|paid|cancelled` + cancelled-tab
status nulling), the trainer/location filters, the per-row **actions cell** (`ShareDropdown` /
forward button / `getPaymentUrl` — injected via `InvoiceListTable`'s `renderActions`), the **mobile
card list** (trainer uses `space-y-3` cards, academy a flush `divide-y` list — intentionally
divergent, so the shared table is desktop-only), every bulk handler, query keys, and nav. The
page-reset and selection-clear effects also stay in each page because their dependency arrays are
page-specific (academy clears on trainer/location filter changes; trainer's selection-clear keys on
`sort`/`sortDir`).

> **Slice 3 note — the one deliberate visible change.** Adopting `InvoiceListStatusBadge` on the
> trainer list was a behaviour change: the trainer page previously hand-rolled its badge from raw
> `status`/`sent_at`/`due_date` and ignored `computed_status`. The server `computed_status` CASE is
> byte-identical to that old classification, so the *status shown is unchanged* — only the styling
> (now the canonical `InvoiceStatusBadge` variants) and the new hover audit-tooltip differ, bringing
> the trainer list in line with academy. This was an explicit, pre-approved change, not a silent one.

### How role labels and slots are injected

- **Labels:** components take a `labels` object of plain strings (and small formatter callbacks,
  e.g. `formatMobileTotal`). The page resolves its own i18n keys and passes the strings in. This is
  why one component serves both the `invoiceForm.*` and `invoiceEdit.*` namespaces.
- **Render slots:** role-configured children (e.g. the `ExtraCostPresetPicker`, which needs
  `trainerId` vs `academyProfileId`) are passed as a render prop that receives a callback from the
  shared component (`presetPicker={(addPreset) => <ExtraCostPresetPicker … onSelect={addPreset} />}`).
- **Variant props:** small behavioural differences are optional props, not forks. The edit form's
  inline-editable global VAT rate is `InvoiceTotalsSummary`'s `singleRate={{ editable: … }}`; the
  create form passes `singleRate={{ label: … }}` for a read-only line.

### Money math is behaviour-preserving — keep it that way

`computeCreateInvoiceTotals` / `computeEditInvoiceTotals` were extracted **verbatim** from the
forms' previous inline math and are pinned by `src/lib/invoiceFormTotals.test.ts`. They are
deliberately **not** routed through `calculateVatTotals` (`src/lib/invoiceCalc.ts`): that helper
computes the single-rate VAT from the aggregate (`subtotal × rate`) whereas the create form sums per
line, which diverges by up to a cent at float half-cent boundaries (e.g. €130.50 @ 21% excl.).
Aligning the forms onto `calculateVatTotals` is a separate, independently-verified change on a money
path — not a free refactor. If you touch this math, the characterization test must stay green.

## When you add a new shared component

- Co-locate a focused test (`*.test.tsx`) — render + the key interactions. See
  `InvoiceLineItemsEditor.test.tsx`.
- Add a source-assertion test if multiple pages must keep using it, so a future edit can't silently
  re-inline one role. See `src/test/invoiceFormSharedComponents.test.ts`.
- Keep i18n out of the shared component when it serves multiple namespaces — inject label strings.
- No new `any`; follow the existing eslint suppressions baseline (it only shrinks).

## Documented follow-ups (not in this slice)

These are the next reuse targets, intentionally deferred to keep each slice safe and small:

- **Invoice list — remaining shared pieces** (slices 2–3 did the sort/selection/pagination wiring,
  stat tiles, status badge, and the desktop table): adopting `DataTableCard` / `EmptyState` /
  `ListPageSkeleton` (each a deliberate visual change, not a like-for-like swap); unifying the
  intentionally-divergent mobile card lists; and sharing the bulk mutation handlers + the sticky bulk
  bar (a separate, money-mutating slice that needs its own careful test pass).
- **Player list reuse (trainer + academy only).** A scoping pass found the win is *medium, not big*,
  and spans only two of the three pages — trainer + academy already share the whole data-fetch stack
  (`playersOverview.ts`); **club is a genuinely different surface** (flat `club_players` table, client
  sort, no pagination, inline CRUD) and must be left alone. **Done (trainer + academy both adopted):**
  the shared `ListPagination`; `mapPlayersOverviewRow(row, opts)` + unified `UnifiedPlayer` type in
  `playersOverview.ts` (the old per-page `trainer_notes`/`academy_notes` field — both sourced from
  `row.academy_notes` — was unified to `internal_notes`); and `useVisibleColumns(allColumns,
  defaultColumns, storageKey)` + `PlayerColumnsMenu` under `src/components/players/` (the
  column-visibility state + best-effort localStorage persistence + the "Columns" dropdown). Each page
  keeps its own `ColumnKey` union, `ALL_COLUMNS` descriptors (the table header reads them) and
  `storageKey`. Do **not** generalize `useInvoiceListSelection` for academy's bulk selection — its
  `Map`-with-payload model that survives server pagination is incompatible, and it is the sole
  consumer. What's left is genuinely role-specific (cell-renderer switch, filter bar) and not worth
  forcing into a shared component.
- **Shared date-picker field** (due-date popover/calendar is repeated across forms).
- **Shared scheduling / calendar components** (agenda day/week views).
- **Consolidate near-duplicate primitives:** `PageHeader` vs `TrainerPageHeader`; `EmptyState` vs
  `DashboardEmptyState` (a candidate to fold into `EmptyState variant="trainer"`).
- **Move remaining role-neutral components out of `trainer/` and `admin/` folders** into `ui/` or a
  `components/features/` area.
- **Align the Deno-side (edge function) registration pricing** onto the same shared math model
  (separate runtime boundary — needs its own verification).
