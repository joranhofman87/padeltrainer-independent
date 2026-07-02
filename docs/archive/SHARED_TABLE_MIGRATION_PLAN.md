# Shared Table Component + Right-Click "Open in New Tab" — Audit & Migration Plan

Status: **Plan / not started.** Audited 2026-06-30 (HEAD on `main` after PR #256). Read-only audit
across all 22 table-bearing files + the shared primitives + routing. This is the corrected plan after
an adversarial review pass — three design claims were wrong/under-specified and are fixed below.

Goal (owner): (A) consolidate the app's many tables onto **one shared, configurable table component**
so we don't maintain divergent versions, and (B) let users **right-click / middle-click / Cmd-click a
row to open it in a new tab**. Hard constraint: **nothing may break** — migrate incrementally, one table
per PR, each behind a green `vitest run`.

---

## 1. Verdict

**Proceed — but build NEW, compose the existing primitives, and migrate behind green tests one table
per PR.** The architecture is sound. Three things **must change before writing the engine** (details in
§6):

- **(A11y — blocking)** Don't standardise sortable headers "down" to today's `SortableTableHead` — it's a
  click-only `<th>` with no keyboard handler / `aria-sort`. Upgrade it to a focusable, `aria-sort` header
  *first*, or we ship an accessibility regression across the invoice + player tables at once.
- **(Correctness — blocking)** Make **controlled sort the *only* sort mode** of the engine (it owns no
  `sortedData`). The player and invoice lists are sorted server-side (RPC); an internal in-memory sort
  would silently double-sort a paginated page.
- **(Rationale fix)** Drop the "SEO hydration mismatch" argument for rejecting stretched links — the app
  is a pure client SPA (`createRoot`, `src/main.tsx:85`), not `hydrateRoot`. The *correct* reasons to use
  a primary-cell link stand on their own (§5).

With those addressed, start with **Phase 0** (zero-risk, additive engine) then the **InvoiceListTable**
pilot.

---

## 2. Current state

### 2.1 Inventory — 22 tables, all hand-rolled
No real shared "DataTable" exists today. `src/components/ui/data-table.tsx` is only a **`DataTableCard`**
frame (Card + horizontal scroll + optional mobile slot + density class) — correctly presentation-only.
Each of the 22 tables hand-rolls its own rows, sort, pagination, selection, mobile cards, and empty/loading
states. The same per-row `switch(key)` body is duplicated ~150 lines in each player page.

There are **three separate "sources of truth"** per table that the engine should unify into one column model:
1. a visibility descriptor (`useVisibleColumns.ts` `ColumnDescriptor = {key,label,isDefault}` — no renderer),
2. the header JSX, and
3. the body `switch(key)`/cell markup.

The only `ColumnDef` in the repo is a *local* interface inside `IntakeRequestsTable.tsx:85`.

### 2.2 Shared primitives that already exist (reuse, don't reinvent)
- `ui/table.tsx` — shadcn `Table/TableRow/TableCell/…` (a bare `<tr>`/`<td>`; important for §5).
- `ui/data-table.tsx` — `DataTableCard` frame + `compactDataTableClass` density. **Stays the outer frame.**
- `ui/sortable-table-head.tsx` — sortable `<th>` (needs the a11y upgrade, §6).
- `ui/table-toolbar.tsx`, `ListPagination`, `useVisibleColumns` + `PlayerColumnsMenu` — clean, stay **outside**
  the engine (orthogonal chrome).
- `hooks/useTableSort.ts` — client sort hook (feeds the engine pre-sorted rows for client-sorted tables).
- `useInvoiceListSelection` → generalise to `useTableSelection<T extends {id:string}>` (single-id tables only).

### 2.3 Navigation reality (why new-tab fails today)
Most rows navigate via an **unconditional JS `onClick → navigate(...)`** (e.g.
`InvoiceListTable.tsx:121`, `CyclesTable.tsx:303`) — the browser can't open those in a new tab, and there
is **no modifier gating anywhere** in the table code, so **Cmd/Ctrl-click is silently swallowed today** on
invoices and cycles. A few tables already do it right with an in-cell `<Link>` (players:
`TrainerPlayers.tsx:497`, `AcademyPlayers.tsx:648`) — and those **already support new-tab**.

---

## 3. Design decision 1 — a new `DataTable<T>` by composition

Add **`src/components/ui/data-table-generic.tsx`** exporting `DataTable<T>` + `ColumnDef<T>` + `RowLink<T>`
that **composes** `DataTableCard` + `Table` + `SortableTableHead`. Do **not** retrofit `DataTableCard`
(it's correctly presentation-only). The missing surface is a **column-def model**, not chrome. No new
dependency (no `@tanstack/react-table` — overkill at these row counts).

```ts
// src/components/ui/data-table-generic.tsx (sketch)
export interface ColumnDef<T> {
  key: string;                         // stable id; doubles as the visibility key
  header: ReactNode;
  sortKey?: string;                    // present => sortable; emitted to onSort (caller maps to hook OR RPC param)
  renderCell: (row: T) => ReactNode;   // folds today's per-page switch(key) into the column
  align?: 'left' | 'right' | 'center';
  className?: string;                  // td className (truncate / overflow-hidden / hidden md:table-cell …)
  headClassName?: string;
  isDefault?: boolean;                 // for column-visibility menu integration
  renderCard?: (row: T) => ReactNode;  // mobile card rendering (omit => not shown on card)
  cardLabel?: ReactNode;
}

export type RowLink<T> = { to: (row: T) => To | null };  // react-router target; null => non-navigable row

export interface DataTableProps<T extends { id: string }> {
  columns: ColumnDef<T>[];             // see §4.2 — pass columns(activeState) for tab-dependent columns
  rows: T[];
  visibleKeys?: string[];              // controlled visibility; undefined => all
  sortKey?: string | null;             // CONTROLLED sort only — engine owns NO sortedData (see §6 B)
  sortDirection?: SortDirection;
  onSort?: (key: string) => void;
  rowLink?: RowLink<T>;                // applied to the PRIMARY cell as a <Link> (see §5)
  onRowClick?: (row: T) => void;       // convenience for the dead area; modifier/middle/selection-gated (§5)
  selection?: RowSelection<T>;         // generalised useTableSelection<T extends {id}>
  renderActions?: (row: T) => ReactNode;
  mobile?: ReactNode;                  // or engine builds cards from columns' renderCard
  empty?: ReactNode;                   // engine renders when rows.length === 0 (caller picks the message — §9)
  compact?: boolean; cardTestId?: string; cardClassName?: string;
}
```

`TableToolbar`, `ListPagination`, `PlayerColumnsMenu`/`useVisibleColumns` stay **outside** the engine, exactly
as today.

---

## 4. Two API refinements the review forced

### 4.1 Controlled sort only
The engine never sorts internally. Callers pass **pre-sorted rows** + `sortKey`/`onSort`. Client-sorted
admin tables feed `useTableSort.sortedData`; server-sorted lists (players RPC `get_players_overview`,
invoices) map `onSort(key)` to an RPC param. (See §6 B — this is blocking.)

### 4.2 Columns as a function of state (tab-dependent columns)
A static `ColumnDef[]` can't express `InvoiceListTable`'s **paid-vs-due** column (header label + cell +
sortKey all swap on `activeTab`, `InvoiceListTable.tsx:135`), nor `ProposalOverview`/`AcademyReports`
conditional columns. The contract is therefore **`columns: ColumnDef<T>[]` computed by the caller from
its state** (e.g. `const columns = useMemo(() => buildColumns(activeTab), [activeTab])`). The engine takes
the array as-is; it must **not** assume columns are static. This avoids bolting render-hacks onto a rigid array.

---

## 5. Design decision 2 — right-click "open in new tab" = **primary-cell `<Link>`**, not a stretched row

Use a **react-router `<Link>` on the primary (first) column's cell** — the pattern the player pages already
ship — **not** a full-row stretched `<a>` overlay. `<Link>` natively handles Cmd/Ctrl/middle/right-click →
real browser "open in new tab" for free; the accessible name comes from the primary cell text (player name /
invoice number / cycle name).

Why **not** a stretched row link (verified against source):
1. `TableRow` is a bare `<tr>` (`table.tsx:33`). An `<a>` can't be a direct child of `<tr>` — invalid HTML
   the browser hoists out of the table. A stretched link would need a positioned `<td>` with an `inset-0`
   child (unreliable across engines) or converting rows to div/grid markup (loses table/`<th>` semantics).
2. **Every navigable row already contains an interactive cell** a row overlay would fight: invoices have a
   checkbox + actions cell (both `e.stopPropagation()`, `InvoiceListTable.tsx:122,152`); cycles have a
   `DropdownMenu` actions trigger; players already nest a `<Link>` in the name cell. A stretched `<a>` over
   the name cell would **double-nest anchors** (invalid).

   *(The earlier "SEO hydration" reason was wrong — app is `createRoot` client-only. The two reasons above
   stand on their own.)*

**Mechanism:**
- Primary cell content wrapped in `<Link to={rowLink.to(row)}>`. Interactive cells (selection, actions) are
  separate `<td>`s keeping their own `e.stopPropagation()` — they never sit under the link, so the existing
  contracts (`InvoiceListTable.tsx:122,152`, `CyclesTable.tsx:340`) are preserved verbatim.
- **Whole-row click stays** as a convenience for the row's dead area, but **gated**:
  `if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;` *and* bail when
  `window.getSelection()?.toString()` is non-empty (so a text-drag-select doesn't navigate). This **fixes
  the current bug** where row `onClick` swallows Cmd-click.
- **`rowLink.to` is a caller-supplied builder**, never hardcoded: the same `CyclesTable` resolves to
  different URLs per consumer (academy `…/registrations/:id` vs club `…/registrations/:id/edit`);
  `AcademyCyclusOverview`'s 3-way (`cycles/:id` | `slot/:id` | `registrations?cycle=`) lives in its own
  builder; a row with no destination returns `null`. **`/app/*` routes are not lang-prefixed** — the builder
  must not prepend `i18n.language` (only public/branded surfaces need that).

**Known caveat to set with the owner — new-tab is per-primary-cell, not whole-row.** Only the primary cell
is a real anchor, so right-clicking the *amount* or *status* cell gives no "open in new tab". Mitigation:
style the whole primary column as the obvious link affordance. (A true stretched link is reserved for tables
with zero interactive cells — none currently qualify.)

**Entities with no per-row route at all** (no new-tab possible without building a route — out of scope here):
intake/registration requests (open a Sheet), proposals, rebook rows, club players, admin trainers/clubs/
academies/locations, waiting-list, email-campaign rows.

---

## 6. Blocking pre-requisites (do these inside Phase 0)

- **(A) Upgrade `SortableTableHead` a11y before retiring the player `SortableHeader`.** Today
  `SortableTableHead` (`sortable-table-head.tsx:24`) puts `onClick` on the `<th>` with no `role`/`tabIndex`/
  keyboard handler / `aria-sort`; the player-variant `SortableHeader` (`usePlayerSort.tsx:113`) is a real
  focusable `<button>` with an aria-label. Standardising "down" makes all sortable headers mouse-only and
  screen-reader-silent → an a11y regression on invoices + players simultaneously. **First** upgrade
  `SortableTableHead` to render a focusable inner control + `aria-sort` + keyboard activation (add a test),
  *then* the migration can retire `SortableHeader`.
- **(B) Engine sort is controlled-only** (no internal `sortedData`). Add a test with a server-sorted fixture
  whose rows are deliberately out of key order, asserting the engine renders them **as given**.
- **(C)** Remove the SSR/hydration justification from any design notes (§5 reasons are the real ones).

---

## 7. Feasibility matrix

| Table | Fit | Effort | New-tab | Notes |
|---|---|---|---|---|
| `InvoiceListTable` | **clean** | med | **easy** `/app/{role}/invoices/:id/edit` | Already the typed-table template (generic `<T>`, selection hook, `renderActions`, `onRowClick`). **Pilot.** Behavioral test already locks selection/sort/actions/row-click. |
| `TrainerPlayers` | **clean** | med | **easy** (name-cell `<Link>` already works) | Server-sorted RPC → controlled sort. Visibility via `useVisibleColumns`/`PlayerColumnsMenu`. Mobile cards from `renderCard`. Rewrite `trainerPlayersTableLayout.test.ts`. |
| `AcademyPlayers` | **clean** | high | **easy** (g_/p_ route already works) | Same engine + bulk-action toolbar/Dialog (~150 LOC, stays in parent) + extra trainer column. Rewrite `academyPlayersTableLayout.test.ts` + `AcademyPlayers.visibility.test.ts`. |
| `CyclesTable` | adaptable | med | needs-href (per-consumer URL) | Hand-rolled `SortField`/`SortableHeader` → engine sort; actions `DropdownMenu` → `renderActions`; `rowLink.to` per consumer. |
| `AcademyTrainers` | adaptable | high | needs-href `/app/academy/trainers/:id` | Convert name `navigate`→`<Link>`. Inline visibility `Switch` (optimistic) is the risk. Has real `DataTableCard` mobile variant. |
| `AcademyCyclusOverview` | adaptable | high | needs-href (3-way builder) | Already uses `useTableSort`+`SortableTableHead`. Has selection+bulk, sessionStorage filters, client-aggregation fallback, parallel mobile list. **Late wave;** verify new-tab cold-load (§9). |
| `AdminLocations` | adaptable | high | n/a (no route; dialog edit) | Has sort+filters+inline toggle+CSV. Body-only migration; no new-tab payoff. Cleanup wave only. |
| `AdminBlog` | adaptable | low | n/a (external links) | 47 LOC; clean drop onto engine for consistency. Optional. |
| `IntakeRequestsTable` | special-case | high | n/a (opens a Sheet) | `useTableSort`+`SortableTableHead` already, but bespoke localStorage column-versioning + mutating suggestion popovers + sticky-left cell. Body+sort only, **last**, or leave bespoke. |
| `CycleDetailView` (sessions) | special-case | med | needs-href `slot/:id` | Inline Pencil/Trash, dual desktop/mobile render, entangled in a 1190-line component. **Leave bespoke** (extract first if ever). |
| `WaitingListTable` | special-case | high | n/a (non-navigable) | Stateful controller (self-fetch/filter/mutate). Extract a hook first or leave-as-is. |
| `AcademyRebookManage` | leave-as-is | high | n/a (inline expand) | Two-level (group+player) selection — not a row-navigable grid. Bespoke. |
| `ProposalOverviewPage` | leave-as-is | high | n/a | N tables-in-Accordion, grouped Map, conditional column. Bespoke. |
| `EmailCampaignTab` | leave-as-is | med | n/a (loads composer state) | Three different-schema tables by sub-tab. Bespoke. |
| `RebookReviewTable` | leave-as-is | low | n/a | Index-keyed wizard preview + ack checkbox. Not a grid. |
| `AcademyTrainerHours` | leave-as-is | med | n/a | Needs a totals `tfoot` + colSpan — escape hatches only this one would need. Bespoke. |
| `AcademyReportsTab` | leave-as-is | high | n/a | 3 aggregate column-sets, per-cell conditional color. Bespoke. |
| `AcademyDashboard` (4 previews) | leave-as-is | med | n/a (card-level "View all") | Tiny read-only previews → a thin `SummaryTable`, not the full engine. Optional. |
| `PlayerDashboard` (4 minis) | leave-as-is | med | n/a | Heterogeneous summaries. Optional `SummaryTable`. |
| `ClubPlayers` | leave-as-is | low | n/a (no route) | Different model, dialog CRUD, non-navigable. Optional cleanup. |
| `AdminBlogSources` / `AdminBlogTopics` | leave-as-is | low | n/a | 33–40 LOC read-only / CRUD-lite. Low value. |

**Clean (3): Invoices, TrainerPlayers, AcademyPlayers · Adaptable (5): CyclesTable, AcademyTrainers,
AcademyCyclusOverview, AdminLocations, AdminBlog · Leave-as-is / special (14).** The "leave-as-is" list is
deliberate — forcing those onto a shared engine adds opt-out props without removing logic (over-abstraction).

---

## 8. Phased rollout (one table per PR; full `vitest run` between every PR; never `--admin` past a real red build)

- **Phase 0 — Engine + RowLink + a11y pre-reqs (ZERO consumer changes, additive).**
  Build `data-table-generic.tsx` (composing `DataTableCard`/`Table`/`SortableTableHead`); generalise
  `useInvoiceListSelection` → `useTableSelection<T extends {id}>`; do the **(A) a11y upgrade** to
  `SortableTableHead` and **(B) controlled-sort-only** contract. Write NEW behavioral tests: N rows render,
  primary cell is an `<a href>`, plain Cmd/middle-click does **not** call `onRowClick`, text-drag does not
  navigate, checkbox/actions `stopPropagation`, sortable header emits key + is keyboard-operable + exposes
  `aria-sort`, server-sorted fixture renders as-given, `empty` slot. Nothing imports it yet → **risk: zero.**

- **Phase 1 — Pilot: `InvoiceListTable`.** Re-express its 9 columns as `ColumnDef[]`; thread selection/sort/
  `renderActions`; add `rowLink.to(row) => /app/{role}/invoices/:id/edit`; **keep BOTH** the primary-cell
  `<Link>` **and** the gated `<tr>` `onClick` (the existing test clicks the non-link "Alice" cell — that
  assertion must keep passing). Parents' mobile lists / `ListPagination` / `TableToolbar` / bulk bar untouched.
  Express the **paid-vs-due** column via `buildColumns(activeTab)` (§4.2). **Risk: low**; gate =
  `InvoiceListTable.test.tsx` (+ new assertions) + `/verify` both invoice pages. Rollback = revert one file.

- **Phase 2 — Pilot twin: `TrainerPlayers` then `AcademyPlayers`.** Proves the hardest cases the invoice
  pilot doesn't: **server-driven controlled sort**, **column-visibility**, **derived mobile cards**, and
  **already-working in-cell-Link new-tab** (preserved, not invented). Deletes the duplicated ~150-line
  `switch(key)` in each. **Rewrite** the 3 source-string layout tests to assert the new contract (column defs
  + DataTable props + Link path). **Risk: medium** — budgeted test rewrites; keep sort controlled (no
  double-sort); preserve sticky header + compact density + mobile flush class.

- **Phase 3 — Wave A: adaptable navigable tables** (`CyclesTable`, `AcademyTrainers`, `AcademyCyclusOverview`),
  one per PR, each gaining real new-tab where a route exists. Convert `navigate()` rows → `rowLink.to`
  builders (per-consumer / 3-way); keep inline `Switch` / bulk / sessionStorage data layers in the pages.
  **Risk: medium** — per-consumer URL divergence; optimistic inline Switch; cyclus 3-way **cold-load** (§9).

- **Phase 4 — Wave B (optional) + explicit leave-as-is.** Optionally migrate the small admin/dashboard
  read-only tables to a thin `SummaryTable` for chrome consistency (add a `footerRow` escape hatch only if
  `AcademyTrainerHours` is ever migrated). **Formally stop** at the special/bespoke list in §7 — don't let a
  "cleanup wave" creep into them.

---

## 9. Risks & mitigations (from adversarial review)

- **A11y sort regression (HIGH)** — see §6 (A). Blocking pre-req, not a sign-off item.
- **Double-sort on RPC-paginated lists (MED)** — controlled-sort-only + out-of-order fixture test (§6 B).
- **Invoice pilot row-click contract (MED)** — keep both primary `<Link>` and gated `<tr>` `onClick`; the
  existing test clicks a non-link cell, so the row handler must survive. Add the 3 new assertions in §8 P0.
- **New-tab asymmetry (MED)** — only the primary cell is an anchor; set owner expectation + style the primary
  column as the link affordance (§5 caveat).
- **Text-drag navigation (MED, pre-existing)** — add the `getSelection()`-empty guard to the row `onClick`.
- **AcademyCyclusOverview cold-load (MED)** — its `registrations?cycle=` target may depend on sessionStorage /
  client aggregation that only exists after an in-app navigate. Verify each of the 3 destinations renders on a
  **cold** new-tab load; if not, make that row `to() => null` or fix the cold path before enabling new-tab.
- **Empty vs filtered-empty (LOW)** — `CyclesTable` distinguishes "no cycles" from "no results" (`colSpan=7`).
  The caller computes which `empty` message to pass; add a test for both.
- **Selection keying (LOW)** — `useTableSelection<T extends {id:string}>` is for single-id tables only
  (invoices/players). Two-level selection (`AcademyRebookManage`, cyclus group/slot ids) stays bespoke.

---

## 10. Test impact (budget ~5 rewrites)
- **Rewrite (source-string layout tests, will break):** `trainerPlayersTableLayout.test.ts`,
  `academyPlayersTableLayout.test.ts`, `AcademyPlayers.visibility.test.ts`, plus any `invoiceListSharedScaffold`
  / `adminListUiPhase1` / `operationalListUiPhase2` substring guards that assert literal markup.
- **Keep (behavioral):** `data-table.test.tsx`, `InvoiceListTable.test.tsx` (extend, don't replace),
  `list-pagination`, `useVisibleColumns`.
- **New:** the Phase-0 engine behavioral suite + a keyboard/`aria-sort` test for the upgraded header.

---

## 11. Open decisions for the owner
1. **New-tab affordance** — accept "only the primary cell opens in a new tab" (with the whole primary column
   styled as the link), or invest in a CSS pseudo-stretched single-`<td>` link for the dead area?
2. **Header visual change** — retiring the player `SortableHeader` for the upgraded `SortableTableHead`
   slightly changes the sort header's look. Confirm that's acceptable (after the a11y upgrade).
3. **Scope of "consolidation"** — is the goal the **8 navigable/clean+adaptable** tables (highest value), or
   also the **read-only cleanup wave** (chrome consistency, no new-tab payoff)? Recommend the former first.
