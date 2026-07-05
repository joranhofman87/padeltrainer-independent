# Component-Unification Audit & Plan (2026-06-30)

Goal: **less code, a more stable app, easier reuse when building new pages.** A 10-category fan-out
audit + adversarial critique, verified against HEAD `adb0b1df`. This is a **plan** (read-only audit);
nothing changed in the app.

## Verdict

**Yes, more unification is worth it — and the right posture is to EXTEND two primitives that already
exist (`ConfirmDeleteDialog`, `TableToolbar`) and add three small new ones (`FullPageLoader`,
`SelectFilter`, `FormDialog`), not build grand abstractions.** This mirrors the discipline that made
the just-finished `DataTable<T>` migration succeed: **share the presentational leaf** (status→variant,
dialog shell, footer button-row, search box, labeled field) and **keep derivation / data-shaping /
business rules at the call site.**

Rough code-reduction picture (counts spot-checked in the critique):
- **Confirm dialogs** — 50 files hand-roll `AlertDialogContent`; only 9 use the existing
  `ConfirmDeleteDialog`. Collapsing the clones into ~7-prop calls is the single biggest lever (several
  hundred LOC).
- **Select filters** — 59 `SelectItem value="all"` blocks across 24 files → one-liners.
- **Full-page spinners** — ~26 copy-pasted blocks in `src/pages` → one component.
- **Status badges** — ~20 hand-rolled `get*Badge` helpers; the same enum renders in 3+ incompatible
  colour systems. Small but near-zero-risk wins that also delete raw Tailwind colour literals in favour
  of the semantic `ui/badge` variants that already ship.

The reuse-first rule throughout: **every proposal extends an existing primitive where one exists.**

---

## Phased rollout (one component family per wave, behind green tests — like the DataTable migration)

Each new primitive gets a small contract test (the pattern of `data-table-generic.test.tsx` /
`invoiceFormSharedComponents.test.ts`). **Re-grep the counts before each wave** — a few drifted in the
plan's favour. Two items are **owner-visible and must NOT be auto-merged** (screenshot/sign-off gate):
the cycle-status colour normalisation (Wave 1) and the AppPage width sweep (Wave 5).

### Wave 1 — Badge cleanup (lowest risk, builds momentum)
- **#5 `subscriptionStatusVariant`** — collapse the 3 **byte-identical** admin copies
  (`AdminAcademies:130`, `AdminClubs:148`, `AdminTrainers:139`). Cleanest merge in the audit, admin-only,
  zero visible change.
- **#7 waiting-list status badge** — identical logic in `WaitingListTable:128` + `MyWaitingListEntries:74`;
  pass the i18n key prefix as a prop.
- **#4 `<CycleStatusBadge>`** — one mapping for draft/open/closed/archived on the semantic `ui/badge`
  variants; deletes the `bg-green-500/10`/`bg-orange-500/10` literals duplicated in `CyclesTable:163` +
  `AcademyCycleDetail:397`, and gives `CycleDetailView:646` its missing colour. ⚠️ **Owner-visible**:
  this flips closed orange→`warning` token and CycleDetailView grey→coloured — **needs sign-off + a
  screenshot pass** (the "low effort" is optimistic given 4 sites × i18n verification).
- **#18 `<CycleTypeBadge>`** (registration/event) — same files as #4, bundle it in.

### Wave 2 — `FullPageLoader` (#3)
Ship `src/components/ui/page-spinner.tsx` (`min-h-screen flex items-center justify-center` + `Loader2`),
sweep the ~26–30 whole-page initial-load spinners (`LocationDetail:383`, `CalendarSettings:156`,
`AdminPricing:56`, `Locations:598`, `MollieCallback`, …). **Scope strictly to whole-page load** — do not
fold per-section or button-submit spinners in. Add it to the standards primitives table.

### Wave 3 — `ConfirmDialog` (#1 then #11) — the biggest lever
Generalise the existing `ui/confirm-delete-dialog.tsx` → `ConfirmDialog`: add `variant?` (default
`destructive`), `children?` (between description and footer), `confirmDisabled?`. Keep its controlled
"caller owns close, stays open while loading" contract; re-export the old name as an alias.
- **⚠️ Pin a contract test BEFORE the sweep** (50 files, money flows — a mis-wired `onConfirm`/loading
  contract silently breaks a delete/void). Decide spinner-only vs `loadingLabel` up front (recommend
  spinner-only).
- **Phase 1 (variant only):** the ~26 byte-identical destructive clones (`PlayerRemoveCard:138` is a
  literal clone, the 6 admin delete dialogs, `ClubPlayers`/`ClubTournaments`, `IntakeRequestDetailSheet`,
  `EditInvoiceDialog`, the two InvoiceList void/delete dialogs) + fold the 3 byte-identical "Reset all
  proposals?" dialogs into one.
- **Phase 2 (#11, maybe):** ~16 non-destructive + ~9 small-body confirms via `children`. **Keep the
  children slot from becoming a dumping ground.** The type-to-confirm sites (`AdminUsers`,
  `DeleteAccountDialog`) stay **bespoke** (an input inside `children` + `confirmDisabled` is a bolted-on
  escape hatch — leave them).

### Wave 4 — Filter bars
- **#2 `<SelectFilter>`** first — `src/components/ui/select-filter.tsx`: `value/placeholder/allLabel/
  options[]/onChange`, the `value="all"` sentinel as a documented contract. **Takes pre-built
  `options[]`; the caller keeps the option derivation** (static enum vs uniq-from-rows). 59 blocks / 24
  files collapse. Keep exotic rich-item Selects inline.
- **#6** — migrate the 7 inline search bars onto `TableToolbar` (now carrying `SelectFilter` children):
  `CyclesTable:342`, `AdminLocations:349`, `AdminClubs:182`, `AcademyCyclusOverview:947`,
  `TrainerScheduleOverview:1003`, `AcademyRebookManage:230`, `EmailCampaignTab:686`. Don't force
  calendar/grid views (Tabs-beside-search) into TableToolbar's single flex row. (TableToolbar has 12
  importers, not 16 — re-grep.)

### Wave 5 — Page shells & headers
- **#8** — finish `ListPageShell` + `ListPageState` adoption on the ~16 trainer/player list pages still
  on `AppPage`-direct (anchor: `TrainerInvoices` vs the already-migrated `AcademyInvoices`). Header stays
  an injected slot, so **`TrainerPageHeader` vs `PageHeader` stays split** (legitimately role-branded).
- **#9 AppPage double-padding sweep** — replace `container mx-auto px-4 py-N` on the ~30 non-adopters
  (club/*, academy settings/profile/subscription/locations, admin certifications/ratingSystems). ⚠️
  **AppPage's `max-w-7xl` is WIDER than `container`** — map each page's width carefully and **visually
  verify; do NOT auto-merge** (a naive swap visibly widens money/settings pages).
- Then **#13 `PageBackHeader`** (detail/create back-headers; collapses the create-slot/generate-slot
  twins) → composes into **#25 `InvoiceFormPageShell`**. Bundle **#24** (club chrome — *page shell only*,
  never push DataTable/playersOverview onto club's flat table) and **#23** (WaitingList shared body)
  opportunistically.

### Wave 6 — Form dialogs + safe fields
- **#10 `<FormDialog>`** scaffold (header + scrollable body + Cancel/Save footer with pending state) —
  **single-submit dialogs only** (~20–24). The 5 tab mega-editors / credential success dialogs /
  multi-step `MergePlayersDialog` adopt **at most the shell/footer, not their bodies**. *(This also
  normalises the verified ~97-site pending-flag naming drift — `isLoading`/`saving`/`loading`/
  `isSubmitting` — at the boundary.)* If FormDialog feels heavy, take **#26 `<DialogFormActions>`**
  (footer-only) instead — pick one, not both.
- **#16 `<PlayerRatingField>`** (rating-system select + skill input) — clean self-contained extraction
  (`AddPlayerForm`, `EditPlayerDialog`; upgrades `WaitingListForm` off its hard-coded 4-system list).
- **#17 `TIME_OPTIONS`** — move the byte-identical half-hour builder to `src/lib/timeOptions.ts`
  (`AddSlotDialog`, `ClubAddSlotDialog`, `BulkCreateContent`, generators). Pure helper win. (Leave native
  `<input type=time>` sites alone.)

### Wave 7 — Pickers + mobile cards (highest effort, last, behind proven shapes)
- **#28** — route `InlineEditBooking`'s player swap through the existing `GuestPlayerSlotCombobox` (pure
  reuse, fixes a no-search regression, 1 file). **Quick win — can do anytime.**
- **#12 `<InvoiceMobileCard>`** — de-dup the invoice mobile card across `AcademyInvoices` +
  `TrainerInvoices`. ⚠️ More divergent than it looks: the **`renderActions` slot must own the WHOLE
  footer row** (academy always-ShareDropdown vs trainer gates it on status + adds forward-to-bookkeeper),
  and the surfaces differ (flush vs bordered). Still worth it.
- **#14 `MobileCardList`/`MobileCardRow`** (+ optional `DataTable` `mobileRow` slot) — **only after #12
  proves the shape.** Wrapper/divider + selection re-wiring is shareable; **the body stays free
  `children`, never templated.** The `mobileRow` prop is a new escape-hatch on a just-stabilised engine —
  add cautiously.
- **#29 `LocationCombobox`** (merge the 3 location pickers via a render-prop) — high effort/medium risk
  (three selection models: ids vs `{isPrimary}` vs `{relationshipType}` — keep those in caller wrappers).
  Defer until lighter wins ship.

---

## Quick wins (highest value-to-effort — start here)
1. **#5** admin subscription badge (byte-identical, zero visible change).
2. **#3** `FullPageLoader` (~26 blocks, trivial API).
3. **#7** waiting-list badge + **#17** `TIME_OPTIONS` (identical-logic merges).
4. **#28** `InlineEditBooking` → `GuestPlayerSlotCombobox` (pure reuse, fixes a UX regression).
5. **#16** `PlayerRatingField` (clean self-contained extraction).
6. **#1 Phase-1** `ConfirmDialog` (after the contract test) — the destructive clones + reset dialogs.
7. **#12** invoice mobile card (with the full-footer slot).

---

## Leave bespoke (over-abstraction guardrails — do NOT migrate)
- **`FormField` wrapper (#31)** — pilot 2–3 forms MAX; do **not** commit to a 40-file migration. 143
  files use `<Label>` but only 6 use the RHF trio; a forced `space-y` convention is an owner-visible
  restyle, and `<FormField type="select">` is the slippery slope. **The biggest over-abstraction trap.**
- **`EntityCombobox<T>` (#30)** — only if `LocationCombobox` first proves the shape, and only **strictly
  headless.** Pickers diverge on fetch/grouping/chips/inline-create/selection-model — they are NOT
  uniformly data-shaped the way table rows were.
- **`TrainerPageHeader` vs `PageHeader`** — keep split (role-branded; merging needs a trainer-folder dep
  that violates the role-isolation eslint guardrails).
- **`DeleteSlotDialog` / `UpdateAffectedInvoicesDialog` / EmailCampaign preview** — don't fit a
  title/description/confirm/cancel contract.
- **The 5 tab mega-editors** (`AcademyEditDialog` 1554 LOC, etc.), credential success dialogs, multi-step
  `MergePlayersDialog` — shell/footer at most.
- **Payment-badge DERIVATION** (timing/booking/invoice rules) + the **agenda `getFillState`** 5-state
  fill model + the **club_players flat table** data layer + the **~92 bare one-line "no items" notes** +
  native `<input type=time>` + label-style `(€)` price fields + the **~5 react-hook-form forms** — all
  deliberate / genuinely divergent.
- **Already done — do not re-propose:** DataTable for invoices/players/cycles/trainers/admin-blog;
  invoice form+list reuse; player-list reuse; role-isolation eslint; EmptyState/DashboardEmptyState
  merge; and (doc-staleness corrected) Trainer/Academy `InvoiceSettingsCard` are already thin wrappers
  over `InvoiceSettingsCardBase`.

---

## Recommended start
**Waves 1–3** (badge cleanups → `FullPageLoader` → `ConfirmDialog` generalisation + Phase-1) are the
highest value-to-risk and are the place to begin. Pin a contract test before the dialog sweep, re-grep
counts before each wave, and gate the two owner-visible items (#4 colours, #9 widths) behind a
screenshot/sign-off. Each wave ships as its own PR behind a green `vitest run` + adversarial review,
exactly like the table migration.
