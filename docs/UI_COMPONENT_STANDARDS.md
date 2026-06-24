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
| `StatTile` | `@/components/ui/stat-tile` | Dashboard metric tile |
| `Calendar` | `@/components/ui/calendar` | Date picking |

> `SortableTableHead` was moved from `components/admin/` to `components/ui/` in this slice — it is a
> role-neutral primitive (already used by academy/trainer/cycle pages), not an admin-only one.

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

These are the next reuse targets, intentionally deferred to keep this slice safe and small:

- **Shared invoice LIST scaffold** — the natural next slice (the `SortableTableHead` move sets it
  up): a sort-config→RPC mapping hook, pagination, bulk-selection hook, stat tiles, and a filters
  component shared by the trainer/academy invoice list pages.
- **Shared player list page** (trainer / academy / club) on the same list scaffold.
- **Shared date-picker field** (due-date popover/calendar is repeated across forms).
- **Shared scheduling / calendar components** (agenda day/week views).
- **Consolidate near-duplicate primitives:** `PageHeader` vs `TrainerPageHeader`; `EmptyState` vs
  `DashboardEmptyState` (a candidate to fold into `EmptyState variant="trainer"`).
- **Move remaining role-neutral components out of `trainer/` and `admin/` folders** into `ui/` or a
  `components/features/` area.
- **Align the Deno-side (edge function) registration pricing** onto the same shared math model
  (separate runtime boundary — needs its own verification).
