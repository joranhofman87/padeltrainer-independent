## Remaining Trainer Parity Steps

Steps 1, 4, 5 (component relocation, invoice settings banner color, preset quick-add on Create/Edit Invoice) are done. Three steps remain.

### Step A — Trainer Players (biggest gap, ~689 → ~900 lines)

Rewrite `src/pages/TrainerPlayers.tsx` to mirror `AcademyPlayers.tsx`:

- Replace existing header with `PageHeader` (title + count + actions: Manage tags, Import, Add player).
- Three tabs: **All players / Create / Email campaign** (reuse `EmailCampaignTab`, `ImportPlayersTab`, `AddPlayerForm` from academy).
- `TableToolbar`: search + filters (Levels, Cyclus, Tags, Payments) + Columns dropdown. Skip Trainers/Locations filters (academy-only).
- Tags column using `PlayerTagsCell`, notes via `PlayerNotesCell`, Manage Tags via `ManagePlayerTagsDialog`.
- Tag/metadata queries: scope by `trainer_id` instead of `academy_profile_id`. The shared components currently take `academyId` — extend to accept either an `academyId` or `trainerId` and adjust the table/column reference accordingly. Underlying tables (`academy_player_tags`, `academy_player_metadata`) already exist; check whether trainer-scoped variants exist or if a small DB migration is needed to add a `trainer_profile_id` column on those tables.

### Step B — Trainer Calendar parity

In `src/pages/TrainerCalendar.tsx`:

- Drop the old "Sub-page Header" `border-b` shell, wrap in `container mx-auto px-4 py-6 space-y-4`, use `PageHeader` (title + Add slot).
- Add 3-tile overview for the visible range: **Locations in use / Booked hours / Free hours** (skip "Active trainers" — single trainer).
- Add Day / Week / Month tabs.
- Week view: render `AgendaWeekByTrainer` with a one-element trainers list (the current trainer).
- Month view: render `AgendaMonth` filtered to the current trainer.
- Day view: keep existing `TrainerCalendarGrid` for now.

### Step C — Trainer Invoices bulk actions + extras

In `src/pages/trainer/TrainerInvoices.tsx`:

- Add row checkboxes + select-all in the table header.
- Sticky bulk-action bar with: Send email (reuse `BulkInvoiceEmailDialog`), Reset to draft, Update due date, Delete.
- Extend `ExtraCostPresetsCard` to accept `trainerProfileId` (already targeted in the migration this round) and add to the Settings tab.

### Out of scope

- Multi-trainer-only filters (Trainers, Locations) on Trainer pages.
- Visual shell pass on remaining pages (TrainerEarnings, TrainerBookings, etc.) — separate follow-up.
- Collapsing `AcademyInvoiceSettingsCard` and `InvoiceSettingsCard` behind a shared hook.

### Suggested order

1. Step A (Players) — likely needs a small DB migration to add `trainer_profile_id` to `academy_player_tags` / `academy_player_metadata`, or a new pair of tables. Will confirm before migrating.
2. Step B (Calendar) — pure frontend.
3. Step C (Invoices bulk + presets card) — frontend + extending `ExtraCostPresetsCard`.

Each step is independently shippable.
