# Frontend component-architecture audit (maintainability & cross-role consistency)

> Read-only audit of the frontend component system, to answer: **is the app easy to maintain and
> consistent across roles, and is it safe against an AI/dev patching one role while breaking another?**
> Method: 5 independent verifiers checked the reuse/coupling claims against the actual code; a skeptical
> synthesis re-verified the headline numbers (the eslint baseline, primitive adoption counts). Date:
> 2026-06-27. No production changes were made.

See also: [`../FRONTEND_ARCHITECTURE.md`](../FRONTEND_ARCHITECTURE.md) (layers + role isolation + the
consolidation roadmap), [`../UI_COMPONENT_STANDARDS.md`](../UI_COMPONENT_STANDARDS.md) (shared primitives
+ the props/slot pattern).

## Executive summary

**The frontend is in fundamentally good shape — no architecture crisis.** The role-isolation sprint did
the hard part: the ESLint role-isolation guardrail is CI-enforced with a small frozen baseline (10
violations across 6 files), and the exemplar shared patterns are real and adopted at scale
(`InvoiceSettingsCardBase` role wrappers, the shared invoice list, the shared player-list layer,
`@/lib/slotTypes`). What remains is **two genuine cross-role divergence hazards** (the real AI-safety
risk) plus a pile of **cheap cosmetic duplication** (boilerplate that's annoying but cannot cause silent
cross-role breakage).

The most important finding is one the generic audit prompt **missed**: two near-identical role copies of
an editable, money-adjacent player form (`TrainerPlayerDetailsCard` ≈ `AcademyPlayerDetailsCard`) that the
guardrail **cannot catch** — because each sits in its own role folder, eslint sees no cross-role import.
An edit to one silently diverges the other. That, not the `ListPageShell` adoption gap, is the real
"fix one role, break another" footgun.

## Component reuse scorecard

| Pattern | Canonical shared component | Adoption | Duplication hotspot | Priority |
|---|---|---|---|---|
| Page layout | `ui/app-page.tsx` (`AppPage`) | solid (~26 importers) | — | ok |
| Page header | `ui/page-header.tsx` (`PageHeader`) | partial (13/30) | `trainer/shell/TrainerPageHeader` is a legit **branded** wrapper, not a dup | P2 |
| List/table pages | `ui/list-page-shell.tsx` (`ListPageShell` + `ListPageState`) | **gap (1/30)** | 13 pages hand-roll AppPage + header + state ternary | P1 |
| Table card | `ui/data-table.tsx` (`DataTableCard`) | partial (8/30) | 22 pages roll own Card+table | P2 |
| Table toolbar | `ui/table-toolbar.tsx` | partial (10/30) | 20 pages roll own search row | P2 |
| Empty state | `ui/empty-state.tsx` (`EmptyState`, has `variant='trainer'`) | partial | **`trainer/dashboard/DashboardEmptyState` is a true dup (7 consumers)** | **P0** |
| Loading/error/empty switch | `ListPageState` | **gap (1/30)** | 29 pages = nested ternaries | P1 |
| Pagination | `ui/list-pagination.tsx` | partial | adopted in invoice/player lists | P2 |
| Slot/booking dialogs | `components/slots/DeleteSlotDialog` ✅ moved | partial | `trainer/{AddSlotDialog,BookForPlayerDialog,InlineBookPlayer,InlineEditBooking}` imported by academy/club | P1 |
| Cycle form | `components/cycles/CycleForm.tsx` (2476 LOC) | solid (single canonical) | cohesive, **not** a dup — leave | ok |
| Date picker (popover) | `ui/calendar.tsx` (24 sites) | partial | 24× duplicated `<Popover><Calendar/>`; no `DatePickerPopover` wrapper | P2 |
| Date input (native) | **none** | gap | 12 files use raw `<input type=date>` | P1 |
| Calendar grid | `trainer/TrainerCalendarGrid` (de-facto shared, props-injected) | partial | imported by `club/ClubCalendar.tsx:29` | P1 |
| Slot card | **none neutral** | **gap** | 3 variants: `trainer/CalendarSlotCard` (419), `trainer/DayViewSlotCard` (366), academy `SlotCard` in `AcademyDayGrid` | P2 |
| Invoice list | `components/invoices/{InvoiceListTable,InvoiceStatTiles,InvoiceListStatusBadge}` | **solid** | adopted academy+trainer | ok |
| Invoice form/settings | `components/invoices/InvoiceSettingsCardBase` (role wrappers inject config) | **solid** | exemplar pattern — keep | ok |
| Player list | `components/players/` (`mapPlayersOverviewRow`, `usePlayersOverview`) | **solid** | list layer shared | ok |
| Player **detail** cards | **none** | **gap** | `trainer/TrainerPlayerDetailsCard` (307) ≈ `academy/AcademyPlayerDetailsCard` (320), 95% identical; same for the two `PlayerRemoveCard` (181 each) | **P0** |
| Stat tile | `ui/stat-tile.tsx` | solid | `DashboardStatTile` = harmless 1-line alias | ok |

## Cross-role import findings (the eslint baseline — 10 violations / 6 files, confirmed)

The role-isolation guardrail (`eslint.config.js` `no-restricted-imports`) is error-level with a frozen
suppression baseline in `eslint-suppressions.json`. The remaining real couplings (academy/club importing
trainer-specific components that are actually role-neutral and should move):

| Importer | Trainer component(s) | Target neutral folder |
|---|---|---|
| `academy/AcademyPlayers.tsx:46-49` | `AddPlayerDialog`, `AddPlayerForm`, `ImportPlayersDialog` | `components/players/` |
| `academy/AcademyDashboard.tsx:27` | `UnpaidBookingsCard` | `components/dashboard/` |
| `academy/AcademyCalendar.tsx:56-57` | `BookForPlayerDialog`, `InlineEditBooking` | `components/booking/` |
| `academy/AcademyCreateSlot.tsx:6` | `AddSlotDialog` / `BulkCreateContent` | `components/slots/` |
| `academy/AcademySlotDetail.tsx:35-36` | `InlineBookPlayer`, `InlineEditBooking` | `components/booking/` |
| `club/ClubCalendar.tsx:29` | `TrainerCalendarGrid` | `components/agenda/` |

Moving these as-is (no redesign) drives the suppression count to **0**.

## Large-file findings

Verified cohesive single-feature files — **do not split for size**: `CycleForm.tsx` (2476),
`ProposalScheduleGrid.tsx` (1967), `TrainerScheduleOverview.tsx` (1922), `AddSlotDialog.tsx` (1994). Pull a
hook out (`useCycleFormDraft`, `useTrainerScheduleData`) opportunistically for clarity, not as a priority.

## AI-safety findings

The guardrail catches cross-role *imports* but **not** cross-role *copies* in separate role folders. The
two `PlayerDetailsCard`/`PlayerRemoveCard` pairs are exactly that blind spot: near-identical editable forms
that diverge silently. Extracting them to `components/players/` both removes the hazard and lets the
guardrail's intent ("one shared component") actually hold.

## Stale findings (already done — do NOT re-propose)

`InvoiceEmailDialog`, `DeleteSlotDialog`, `SlotLocationPicker`, `DashboardActivityList` were already moved
to neutral folders (this session). `DashboardStatTile` is a harmless 1-line alias. `TrainerPageHeader` is a
legitimate branded wrapper, not a merge target (only parameterize its hardcoded brand color if desired).

## Prioritized plan

**P0 — genuine cross-role divergence (the guardrail can't see these):**
- **P0.1** merge `DashboardEmptyState` → `EmptyState` (`variant='trainer'`); repoint 7 trainer consumers. Behavior-frozen.
- **P0.2** extract `PlayerDetailsCard` + `PlayerRemoveCard` → `components/players/`, injecting `onSave`/`onRemove`
  and parameterizing the one real difference (academy shows a phone field; trainer doesn't → a `showPhone`
  prop). Thin role wrappers remain. Behavior-frozen.

**P1 — high-value reuse / burn down the eslint baseline:**
- **P1.1** move the player-dialog cluster (`AddPlayerDialog`/`AddPlayerForm`/`ImportPlayersDialog`) → `components/players/` (clears 3 suppressions).
- **P1.2** move `UnpaidBookingsCard` → `components/dashboard/`, then the slot/booking cluster (`AddSlotDialog`/`BulkCreateContent` → `components/slots/`; `BookForPlayerDialog`/`InlineBookPlayer`/`InlineEditBooking` → `components/booking/`; `TrainerCalendarGrid` → `components/agenda/`) → suppressions hit **0**. One move per component.
- **P1.3** adopt `ListPageShell`+`ListPageState` on the 5 highest-traffic list pages (`AcademyInvoices`, `AcademyPlayers`, `AcademyIntakeRequests`, `AdminAcademies`, `AdminUsers`), `AcademyTrainers` as the reference. Zero visual change.
- **P1.4** one canonical `DateInputField` (`ui/`) for the 12 raw `<input type=date>` sites. **Not** behavior-frozen (a11y/format normalization) → ship behind a visual check.

**P2 — cleanup:** `SlotCardBase`; a `DatePickerPopover` wrapper for the 24 `<Popover><Calendar/>` sites;
long-tail `DataTableCard`/`PageHeader`/`TableToolbar` adoption; booking-dialog neutralization for club parity.

## Verdict

The frontend architecture is **sound and getting harder to break** — the guardrail + exemplar shared
patterns are real and working. The remaining work is two genuine divergence fixes (P0) and a
suppression-burndown + adoption sweep (P1), all small mechanical moves. The single highest-leverage first
slice is **P0.2** (the player-card extraction): tiny blast radius (2 pages), behavior-frozen, and it removes
the most dangerous live divergence in the codebase — one the eslint guardrail structurally cannot detect.
