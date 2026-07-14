# Component pattern registry

Purpose: the canonical "which component do I use for X" lookup. Before writing any UI markup, find your pattern here and reach for the ONE component named. Do not hand-roll an alternative.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

## How to use this doc

1. Find your pattern in the table below → use the **Component** named, import from the path shown.
2. If two roles (trainer / academy / club / admin / player) need the same thing, it lives in ONE shared component under `src/components/<feature>/`; role pages are thin wrappers that inject IDs / query keys / labels via props. See [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) for the role-isolation rule (CI-enforced, suppressions baseline is **0**).
3. Deep guidance already exists — this registry indexes it, it does not repeat it:
   - [`UI_COMPONENT_STANDARDS.md`](./UI_COMPONENT_STANDARDS.md) — the props/slot/label-injection pattern + the worked invoice examples (read this before extracting anything shared).
   - [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) — color tokens, typography, spacing, CSS-var rule (never hardcode hex).
   - [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) — layers + role isolation.
   - [`audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md`](./audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md) — the reuse scorecard.
   - [`COMPONENT_REUSE_AUDIT.md`](./COMPONENT_REUSE_AUDIT.md) — the extend-don't-abstract plan.
   - Open duplication → [`technical-debt/COMPONENT_REUSE_BACKLOG.md`](./technical-debt/COMPONENT_REUSE_BACKLOG.md).

Global rules (from DESIGN_SYSTEM): colors via CSS-var tailwind classes only (no hex literals); `lucide-react` icons only (stroke 1.75); full-page routes over modals for complex flows; no `staleTime: Infinity`. A raw `<Input type="date">` is **blocked by lint** — use `DateInputField`.

## The registry

| Pattern | Use THIS component | Import from |
| --- | --- | --- |
| Page shell (width/padding) | `AppPage` | `@/components/ui/app-page` |
| Page header (title + desc + actions) | `PageHeader` | `@/components/ui/page-header` |
| List/table **page** chrome + full-page loading | `ListPageShell` | `@/components/ui/list-page-shell` |
| Loading→error→empty→content switch (list body) | `ListPageState` | `@/components/ui/list-page-shell` |
| Full-page initial-load spinner | `FullPageLoader` | `@/components/ui/page-spinner` |
| Table (card-wrapped, scrollable, mobile slot) | `DataTableCard` + `Table` | `@/components/ui/data-table`, `@/components/ui/table` |
| Generic typed table | `DataTable<T>` | `@/components/ui/data-table-generic` |
| Search + filter row above a table | `TableToolbar` | `@/components/ui/table-toolbar` |
| Sortable `<th>` | `SortableTableHead` (+ `useTableSort`) | `@/components/ui/sortable-table-head`, `@/hooks/useTableSort` |
| Pagination (windowed pager) | `ListPagination` | `@/components/ui/list-pagination` |
| Stat / KPI tile | `StatTile` | `@/components/ui/stat-tile` |
| Empty / no-results state | `EmptyState` (`variant='trainer'` for dashboard look) | `@/components/ui/empty-state` |
| List loading skeleton | `ListPageSkeleton` | `@/components/ui/list-page-skeleton` |
| Error state (query) | `QueryErrorState` | `@/components/ui/QueryErrorState` |
| Destructive confirm dialog | `ConfirmDialog` (alias `ConfirmDeleteDialog`) | `@/components/ui/confirm-dialog` |
| Date input (native) | `DateInputField` | `@/components/ui/date-input-field` |
| Date picker (popover) | `Calendar` in `Popover` | `@/components/ui/calendar`, `@/components/ui/popover` |
| Badge / status chip | `Badge` (semantic `variant`) | `@/components/ui/badge` |
| Invoice status chip | `InvoiceStatusBadge` / `InvoiceListStatusBadge` | `@/components/invoices/` |
| Invoice line-items editor | `InvoiceLineItemsEditor` | `@/components/invoices/InvoiceLineItemsEditor` |
| Invoice totals (subtotal/VAT/total) | `InvoiceTotalsSummary` (math in `@/lib/invoiceFormTotals`) | `@/components/invoices/InvoiceTotalsSummary` |
| Invoice list (desktop table / stat tiles) | `InvoiceListTable` / `InvoiceStatTiles` | `@/components/invoices/` |
| Invoice settings card | role wrapper over `InvoiceSettingsCardBase` | `@/components/invoices/InvoiceSettingsCardBase` |
| Player detail card | `PlayerDetailsCard` (neutral) | `@/components/players/PlayerDetailsCard` |
| Player remove card | `PlayerRemoveCard` (neutral) | `@/components/players/PlayerRemoveCard` |
| Player list rows | `mapPlayersOverviewRow` + `usePlayersOverview` | `@/lib/playersOverview`, `@/components/players/` |
| Column-visibility menu | `useVisibleColumns` + `PlayerColumnsMenu` | `@/components/players/` |
| Cycle card | `CycleCard` | `@/components/cycles/CycleCard` |
| Cycle detail (sessions/players/roster) | `CycleDetailView` | `@/components/cycles/CycleDetailView` |
| Cycle create/edit form | `CycleForm` | `@/components/cycles/CycleForm` |
| Booking / slot list | `SlotList` | `@/components/booking/SlotList` |
| Availability calendar / picker | `AvailabilityCalendar` / `AvailabilityPicker` | `@/components/booking/` |
| Rich-text editor | `RichTextEditor` / `MiniRichTextEditor` | `@/components/ui/` |
| Consent (rich text + checkbox) | `RichTextConsent` | `@/components/ui/rich-text-consent` |
| Nav shell / sidebar | `Sidebar` primitives + role `*Layout` | `@/components/ui/sidebar`, `@/components/{academy,trainer,club}/…Layout` |

## Pattern notes

### Tables & list pages
Compose from `ListPageShell` → `TableToolbar` → `ListPageState` → `DataTableCard`/`Table` → `ListPagination`. The full worked scaffold is in [`UI_COMPONENT_STANDARDS.md` §"How to build a list/table page"](./UI_COMPONENT_STANDARDS.md) — do not re-wire page chrome or the loading/empty/error ternary by hand. `AcademyTrainers` is the reference page.

```tsx
<ListPageShell title={t('title')} actions={<CreateBtn />} isLoading={isLoading}>
  <TableToolbar searchValue={q} onSearchChange={setQ}>{filters}</TableToolbar>
  <ListPageState isEmpty={rows.length === 0} error={error} empty={<EmptyState … />}>
    <DataTableCard mobile={<MobileCards rows={rows} />}><Table>…</Table></DataTableCard>
    <ListPagination page={page} pageCount={pageCount} onPageChange={setPage} />
  </ListPageState>
</ListPageShell>
```
Mobile: pass a card list to `DataTableCard`'s `mobile` slot; desktop `<table>` + mobile cards render from the same row data. A11y: `SortableTableHead` renders a real `<button>` in the `<th>`; keep sort state in `useTableSort`.

### Page headers & stat cards
`PageHeader` = title + description + right-aligned actions. `StatTile` is presentation-only — it never owns a query; inject `value`/`loading` as props (`@/components/ui/stat-tile.tsx:5`). Use `highlight` for the accented brand-500 left border, `onClick` to make it a button (renders as `<button>` for a11y).

```tsx
<StatTile label={t('unpaid')} value={fmt(total)} icon={AlertCircle} loading={isLoading} onClick={goUnpaid} />
```

### Empty / loading / error states
One `EmptyState` — `variant='default'` or `variant='trainer'` (the old `DashboardEmptyState` was folded in; do not reintroduce it). Full-page initial load → `FullPageLoader` (`@/components/ui/page-spinner.tsx`), scoped to whole-page load ONLY (not per-section or button spinners — those stay bespoke, e.g. the Mollie-callback card). Query error → `QueryErrorState`. Inside a list, the loading/error/empty precedence is owned by `ListPageState`.

```tsx
<EmptyState icon={Users} title={t('empty')} description={t('emptyDescription')} />
```

### Dialogs & forms
Destructive/confirm → `ConfirmDialog` (`@/components/ui/confirm-dialog.tsx:15`); the `ConfirmDeleteDialog` name is a re-export alias. It is controlled ("caller owns close, stays open while loading") — do NOT hand-roll `AlertDialogContent` for a title/description/confirm/cancel dialog. Forms: 6 pages use the react-hook-form `Form` trio (`@/components/ui/form`); most use plain `<Label>` + inputs — do not force a `FormField` wrapper (over-abstraction trap, see the reuse audit). There is **no** `FormDialog` shell yet — see the backlog.

```tsx
<ConfirmDialog open={open} onOpenChange={setOpen} title={t('delete.title')}
  description={t('delete.desc')} onConfirm={handleDelete} loading={isDeleting} />
```

### Badges / status chips
Use `Badge` with a semantic `variant` (`default | secondary | destructive | outline`, `@/components/ui/badge.tsx:10`) — never raw `bg-green-500/10` literals. Invoice status has canonical helpers (`InvoiceStatusBadge`, status→variant map at `@/components/invoices/InvoiceStatusBadge.tsx:18`). Cycle status has **no** shared badge yet (hand-rolled in `CyclesTable`, `AcademyCycleDetail`, `CycleDetailView`) — see the backlog. Payment-badge *derivation* (timing/booking/invoice rules) is deliberately bespoke — do not templatize it.

### Date pickers & calendars
Native date → `DateInputField` (raw `<Input type="date">` is lint-blocked). Popover date-picker → `Calendar` inside `Popover` (24 sites hand-wire this pair; no `DatePickerPopover` wrapper exists — backlog). Calendar grids are role-specific (`TrainerCalendarGrid`, de-facto shared and props-injected; academy `AcademyDayGrid`); do not build a new grid.

### Invoice / player / booking cards
Invoice: use the extracted `invoices/` family (line-items editor, totals summary, list table, stat tiles, status badges, `InvoiceSettingsCardBase`). Never duplicate money/total math inline — it lives in `@/lib/invoiceFormTotals` and is characterization-pinned (see [`UI_COMPONENT_STANDARDS.md` §"Money math"](./UI_COMPONENT_STANDARDS.md)). Player detail/remove: use the **neutral** `players/PlayerDetailsCard` + `players/PlayerRemoveCard`; `Trainer*`/`Academy*` variants are thin wrappers injecting `onSave`/`onRemove`/`showPhone` — never fork them. Booking/slot: `SlotList`, `AvailabilityCalendar`; the three slot-card variants are not yet unified (backlog `SlotCardBase`).

### Nav / shell / mobile layouts
Each role has its own `*Layout` + `*Sidebar` + `*Navigation` (branded, role-scoped — kept split on purpose; see `academySidebarNav.ts` for the nav-item source). Built on the shared `ui/sidebar` primitive. `AppPage` provides the responsive content width (`max-w-7xl`, wider than raw `container` — mind this when migrating). Mobile: layouts are mobile-first per DESIGN_SYSTEM; tables degrade to `DataTableCard` mobile card slots; `AcademyLayout.mobile.test.tsx` pins the mobile shell.

## Where NOT to create a custom alternative

- No new page-chrome ternary → `ListPageShell` + `ListPageState`.
- No new `min-h-screen … Loader2` block → `FullPageLoader`.
- No new `AlertDialogContent` for a standard confirm → `ConfirmDialog`.
- No new `get*Badge` helper with raw color literals → `Badge` variant (or the invoice badge family).
- No raw `<input type="date">` → `DateInputField` (lint-enforced).
- No copied player detail/remove form in a role folder → neutral `players/` component + wrapper.
- No inline invoice/VAT math → `@/lib/invoiceFormTotals`.
- Do NOT build grand abstractions (`FormField`, `EntityCombobox`) — the reuse audit flags these as over-abstraction traps. Share the presentational leaf, keep business rules at the call site.

## Copy / share a link

| Pattern | Component / hook | Import | Notes |
|---|---|---|---|
| Copy a URL to clipboard | `useCopyToClipboard()` | `@/hooks/useCopyToClipboard` | The ONE clipboard implementation (secure-context guard + `execCommand` fallback). Use inside dropdown items / custom buttons. Do NOT hand-roll `navigator.clipboard.writeText` — it silently throws off-HTTPS. |
| A standalone "copy link" button | `<CopyLinkButton url=… />` | `@/components/ui/CopyLinkButton` | Built on the hook; Check-state + toast baked in. |
| A registration form's share URL | `shareUrlForRegistration(...)` | `@/lib/cycleRegistrationUrl` | The single source that picks the branded `/s/<code>` short link vs the long URL. See [`SHORT_LINKS.md`](./SHORT_LINKS.md). |

Backlog: ~15 other surfaces (locations, ratings, invoice pay links, quizzes, blog) still hand-roll
`navigator.clipboard`; migrate them onto `useCopyToClipboard` incrementally.
