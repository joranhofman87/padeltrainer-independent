# Component reuse backlog

Purpose: ranked list of duplicated UI patterns (role-specific reimplementations that should use ONE shared component) still open as of this date. Pick from the top; each item says small-safe vs large and names the target shared component. This is a backlog, not a refactor — nothing here is done yet.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

## How to read this

- Full rationale + phased rollout is in [`../COMPONENT_REUSE_AUDIT.md`](../COMPONENT_REUSE_AUDIT.md) (the "extend, don't abstract" plan) and [`../audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md`](../audits/FRONTEND_COMPONENT_ARCHITECTURE_AUDIT.md) (the reuse scorecard). This doc is the current, deduped, ranked view — it supersedes those where counts drift.
- **Re-grep counts before starting a wave** — several drift over time. The counts below were spot-checked 2026-07-02.
- **Rule for every item:** extend an existing primitive where one exists; share the presentational leaf, keep derivation/business rules at the call site. Co-locate a contract test. Never fork a component to change a label or an ID — inject via props. See [`../UI_COMPONENT_STANDARDS.md`](../UI_COMPONENT_STANDARDS.md).

## Already shipped — do NOT re-propose

- **Player detail/remove card extraction (was P0.2).** `players/PlayerDetailsCard` (333 LOC) + `players/PlayerRemoveCard` (142) are the neutral source; `Trainer*`/`Academy*` are now thin 43–59 LOC wrappers importing them. The silent cross-role divergence hazard is closed.
- **`DashboardEmptyState` → `EmptyState variant='trainer'`** (merged; component deleted).
- **Role-isolation eslint baseline = 0** (no cross-role imports; suppressions file has zero `no-restricted-imports` entries).
- **`FullPageLoader` exists** (`ui/page-spinner.tsx`) — but the sweep is only ~3/26 done, see P1-2.
- **`ConfirmDialog` exists** (`ui/confirm-dialog.tsx`, alias `ConfirmDeleteDialog`) — but the sweep is ~12/49 done, see P0-1.
- DataTable for invoices/players/cycles/trainers; invoice form+list reuse; player-list layer; `InvoiceSettingsCardBase` role wrappers; `DateInputField` (raw `<input type=date>` lint-blocked).

---

## P0 — biggest lever / real safety, do first

### P0-1 · Sweep `AlertDialogContent` hand-rolls onto `ConfirmDialog` — LARGE
The generalized `ConfirmDialog` already ships, but **49 files still hand-roll `AlertDialogContent`** while only 12 import `ConfirmDialog`. Collapsing the byte-identical destructive clones into ~7-prop calls is the single biggest LOC lever (several hundred lines) and removes hand-mixed markup on money flows (voids/deletes).
- Refs: `PlayerRemoveCard` (literal clone), the ~6 admin delete dialogs, `ClubPlayers`/`ClubTournaments`, `IntakeRequestDetailSheet`, `EditInvoiceDialog`, the two InvoiceList void/delete dialogs, the 3 byte-identical "Reset all proposals?" dialogs.
- Target: `@/components/ui/confirm-dialog` (`ConfirmDialog`).
- **Small-safe per file, large in aggregate.** ⚠️ Money flows: pin a contract test for the `onConfirm`/loading/close contract BEFORE the sweep; a mis-wired handler silently breaks a delete/void. Phase 1 = the ~26 byte-identical destructive clones only. Leave type-to-confirm sites (`AdminUsers`, `DeleteAccountDialog`) and non-fitting dialogs (`DeleteSlotDialog`, `UpdateAffectedInvoicesDialog`, EmailCampaign preview) bespoke.

---

## P1 — high value, low-medium risk

### P1-1 · Shared `CycleStatusBadge` (+ `CycleTypeBadge`) — SMALL-SAFE
No shared cycle-status badge exists. Status is hand-rolled with raw color literals (`bg-green-500/10`, `bg-orange-500/10`) in `CyclesTable` + `AcademyCycleDetail`, and `CycleDetailView` is missing its status color entirely.
- Target: new `@/components/cycles/CycleStatusBadge` (+ `CycleTypeBadge`) on semantic `ui/badge` variants.
- Small, near-zero-risk, deletes color literals. ⚠️ **Owner-visible**: it flips closed orange→`warning` and gives `CycleDetailView` new color — gate behind a screenshot/sign-off, do not auto-merge.

### P1-2 · Finish the `FullPageLoader` sweep — SMALL-SAFE
`FullPageLoader` ships but is adopted in only ~3 files; ~26 copy-pasted `min-h-screen … Loader2` blocks remain in `src/pages` (`LocationDetail`, `CalendarSettings`, `AdminPricing`, `Locations`, `MollieCallback`, …).
- Target: `@/components/ui/page-spinner` (`FullPageLoader`).
- Scope strictly to whole-page initial load — do NOT fold per-section or button-submit spinners in.

### P1-3 · `SelectFilter` primitive — SMALL-SAFE then MEDIUM sweep
No `SelectFilter` exists; **30 files** hand-roll a `value="all"` sentinel `<Select>` filter.
- Target: new `@/components/ui/select-filter.tsx` (`value/placeholder/allLabel/options[]/onChange`, `"all"` sentinel as documented contract). Takes pre-built `options[]`; caller keeps option derivation.
- Ship the primitive (small), then sweep (medium). Keep exotic rich-item Selects inline.

### P1-4 · Waiting-list status badge + admin subscription badge — SMALL-SAFE
Identical badge logic duplicated: `WaitingListTable` + `MyWaitingListEntries` (pass i18n key prefix as prop); and 3 byte-identical `subscriptionStatusVariant` copies in `AdminAcademies`/`AdminClubs`/`AdminTrainers`.
- Target: shared helper/component per family. Admin one is zero visible change (admin-only, byte-identical) — cleanest merge in the audit.

### P1-5 · `ListPageShell` + `ListPageState` adoption on remaining list pages — MEDIUM
~13 trainer/player/club list pages still hand-roll `AppPage` + header + a loading/empty/error ternary (adoption ~1/30 for the full shell).
- Target: `@/components/ui/list-page-shell`. Anchor: migrate `TrainerInvoices` against the already-migrated `AcademyInvoices`. Zero visual change; header stays an injected slot (`TrainerPageHeader` stays split).

---

## P2 — cleanup, lower value

### P2-1 · Migrate inline search bars onto `TableToolbar` — MEDIUM
~7 pages roll their own search row instead of `TableToolbar` (`CyclesTable`, `AdminLocations`, `AdminClubs`, `AcademyCyclusOverview`, `TrainerScheduleOverview`, `AcademyRebookManage`, `EmailCampaignTab`). Do this after P1-3 so `SelectFilter` can be a `TableToolbar` child. Don't force calendar/grid (Tabs-beside-search) views into the single flex row.

### P2-2 · `SlotCardBase` — MEDIUM
Three slot-card variants: `trainer/CalendarSlotCard`, `trainer/DayViewSlotCard`, and the academy slot card in `AcademyDayGrid`. Extract a shared base only after the invoice-mobile-card shape proves out; keep the body free `children`.

### P2-3 · `DatePickerPopover` wrapper — SMALL-SAFE
24 sites hand-wire `<Popover><Calendar/></Popover>`. One thin wrapper removes the boilerplate. Pure presentational; low risk.

### P2-4 · `TIME_OPTIONS` helper — SMALL-SAFE
Byte-identical half-hour builder duplicated across `AddSlotDialog`, `ClubAddSlotDialog`, `BulkCreateContent`, generators → move to `@/lib/timeOptions.ts`. Pure helper win. Leave native `<input type=time>` sites alone.

### P2-5 · Invoice mobile card (`InvoiceMobileCard`) — MEDIUM
De-dup the invoice mobile card across `AcademyInvoices` + `TrainerInvoices`. ⚠️ The `renderActions` slot must own the whole footer row (academy always-ShareDropdown vs trainer gates on status + adds forward-to-bookkeeper); surfaces differ (flush vs bordered).

### P2-6 · `PlayerRatingField` — SMALL-SAFE
Rating-system select + skill input duplicated in `AddPlayerForm` + `EditPlayerDialog`; clean self-contained extraction (also upgrades `WaitingListForm` off its hard-coded system list).

---

## Do NOT build (over-abstraction guardrails)
`FormField` wrapper (pilot 2–3 max, never a 40-file migration), `EntityCombobox<T>`, a `FormDialog` for the 5 tab mega-editors' bodies, `TrainerPageHeader`↔`PageHeader` merge (role-branded, would need a forbidden cross-role dep). Payment-badge derivation, the agenda `getFillState` model, the `club_players` flat table layer, and the ~92 bare one-line "no items" notes are deliberately divergent — leave them.
