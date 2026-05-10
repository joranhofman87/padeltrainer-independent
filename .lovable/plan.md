## Goal

Bring the Trainer side to feature + visual parity with the Academy side. Academy is the source of truth. Differences should remain only where they reflect the structural distinction "an academy can have multiple trainers and own things on their behalf."

## Audit summary

| Area | Academy (leading) | Trainer (today) | Gap |
|---|---|---|---|
| **Calendar / Agenda** | `AgendaWeekByTrainer` + `AgendaMonth` (location logos, capacity, status pills), 4-tile summary bar (Active trainers / Locations / Booked h / Free h), `AcademyTrainerHours` tab, `AcademyReportsTab` | `TrainerCalendarGrid` only, day/week/month buttons, generic Available/Pending/Booked counts, sub-page border-b header | Big — new Agenda views + summary not used at all |
| **Registrations** | `PageHeader`, `TableToolbar`, search-first, Add + CSV in header, Workflow steps, Tabs + List/Schedule toggle | Same after recent refactor | Done |
| **Players** | `PageHeader` + 3 tabs (All / Create / Email Campaign) + filters (Trainers, Locations, Levels, Cyclus, Tags, Payments) + Columns dropdown + tags + import + email campaigns + manage tags dialog | Old layout: title + buttons, status pill filter row, search only, single Players card, no tabs, no tags, no columns, no campaigns | Big — table is the leading change the user keeps mentioning |
| **Invoices list** | New `PageHeader` + `TableToolbar`, stats cards, **bulk select + bulk actions** (email, reset to draft, due date, delete), Send all drafts in header, settings tab with `AcademyInvoiceSettingsCard` + `ExtraCostPresetsCard` | New `PageHeader` + `TableToolbar` + stats + Send all drafts (just refactored) | Missing bulk select/actions, missing Extra-cost presets, missing banner color in settings |
| **Create invoice** | Adds line items, `ExtraCostPresetsCard` quick-add, supports `prices_include_vat`, `payment_terms_days` from settings | Adds line items, `prices_include_vat`, `payment_terms_days` from settings, but **no Extra-cost preset quick-add buttons** | Add preset quick-add row |
| **Invoice settings** | `business_name`, address, KvK, BTW, IBAN, BIC, terms, VAT, forward emails, **reply-to**, **logo**, prefix/next/year, **banner color**, language | Same except **no banner color**; otherwise parity exists | Add banner color field |
| **Dashboard** | `UnpaidBookingsCard`, `AcademyCalendarOverview`, etc. | `UnpaidBookingsCard`, `TrainerSetupChecklist`, custom monthly earnings | Smaller — visual polish only |
| **Misc** | Container `py-6 space-y-4`, `PageHeader` everywhere | `TrainerCalendar` still uses old "Sub-page Header" `border-b` shell | Adopt unified shell |

## Plan (in priority order)

### 1. Trainer Players page — adopt full Academy parity (highest impact)

Rewrite `src/pages/TrainerPlayers.tsx` to mirror `AcademyPlayers.tsx`:
- `PageHeader` with title + count + actions (Tags, Import, Add player).
- Tabs: **All players / Create / Email campaign** (reuse `EmailCampaignTab`, `ImportPlayersTab`, `AddPlayerForm`).
- Toolbar: search first, then Levels, Cyclus, Tags, Payments, Columns dropdown. (Trainer filter and Locations filter are academy-only and stay omitted.)
- Tags: reuse `ManagePlayerTagsDialog`, `PlayerTagsCell`, `PlayerNotesCell` from `components/academy/`.
- Move shared bits (`PlayerTagsCell`, `PlayerNotesCell`, `ManagePlayerTagsDialog`, `EmailCampaignTab`, `playerTagColors`) from `components/academy/` to `components/players/` so both pages import from one place. No behaviour change, just relocation + import path updates in Academy.

### 2. Trainer Calendar — adopt new Agenda views + summary

In `src/pages/TrainerCalendar.tsx`:
- Replace the "Sub-page Header" with `PageHeader` (title + Add slot action), wrapped in the standard container.
- Add the 4-tile overview: **Locations in use / Booked hours / Free hours** for the visible range. (Drop "Active trainers" — single trainer.)
- Add view tabs: **Day / Week / Month** as in Academy.
- For Week and Month, render `AgendaWeekByTrainer` / `AgendaMonth` filtered to the single trainer (these components already accept a trainers list — pass the one trainer). Keep the existing `TrainerCalendarGrid` only for Day view, or replace with the Agenda day equivalent if simpler.
- Move `AgendaWeekByTrainer`, `AgendaMonth`, `agendaTokens.ts` from `components/academy/` to `components/agenda/` so both sides import from a neutral location.

### 3. Trainer Invoices — bulk actions + extras

In `src/pages/trainer/TrainerInvoices.tsx`:
- Add the same bulk-selection sticky bar (checkboxes per row + select-all in table header) with actions: Send email, Reset to draft, Update due date, Delete. Reuse `BulkInvoiceEmailDialog`.
- Add `ExtraCostPresetsCard` to the Settings tab (`trainer_id` variant — extend `ExtraCostPresetsCard` to accept either `academyProfileId` or `trainerProfileId`).
- Settings: add **invoice banner color** field to `InvoiceSettingsCard` to match `AcademyInvoiceSettingsCard`.

### 4. Trainer Create / Edit Invoice — preset quick-add row

In `src/pages/trainer/TrainerCreateInvoice.tsx` and `TrainerEditInvoice.tsx`:
- Add the preset quick-add row that appends preset line items (same buttons that exist in `AcademyCreateInvoice.tsx`).

### 5. Visual & shell consistency pass

- Container: every Trainer top-level page uses `container mx-auto px-4 py-6 space-y-4` and starts with `PageHeader`. Audit:
  - `TrainerCalendar` (drop border-b sub-page header)
  - `TrainerEarnings`, `TrainerBookings`, `TrainerWaitingList`, `TrainerScheduleOverview`, `TrainerCycles`, `TrainerCyclus`, `TrainerAnalytics`, `TrainerSettings`, `TrainerProfile` — convert any custom page headers to `PageHeader`.
- All routes use `/app/trainer/...` (one stale `/trainer/calendar` link in TrainerPlayers).

### 6. Component relocation summary (one PR-sized cleanup)

| From | To | Used by |
|---|---|---|
| `components/academy/AgendaWeekByTrainer.tsx` | `components/agenda/AgendaWeekByTrainer.tsx` | Academy + Trainer calendar |
| `components/academy/AgendaMonth.tsx` | `components/agenda/AgendaMonth.tsx` | Academy + Trainer calendar |
| `components/academy/agendaTokens.ts` | `components/agenda/agendaTokens.ts` | both |
| `components/academy/PlayerTagsCell.tsx` | `components/players/PlayerTagsCell.tsx` | both |
| `components/academy/PlayerNotesCell.tsx` | `components/players/PlayerNotesCell.tsx` | both |
| `components/academy/ManagePlayerTagsDialog.tsx` | `components/players/ManagePlayerTagsDialog.tsx` | both |
| `components/academy/EmailCampaignTab.tsx` | `components/players/EmailCampaignTab.tsx` | both |
| `components/academy/playerTagColors.ts` | `components/players/playerTagColors.ts` | both |

`AcademyInvoiceSettingsCard` and `InvoiceSettingsCard` stay separate for now — they read different DB tables (`academy_profiles` vs `trainer_profiles`). A later refactor can collapse them behind a `useInvoiceProfile(ownerType, id)` hook.

## Out of scope this round

- Multi-trainer-only features (location/trainer filters on Trainer pages, AcademyTrainers, AcademyTrainerHours, AcademyReportsTab) — these legitimately stay academy-only.
- DB schema changes — assumes `guest_player_tags`, `guest_player_tag_assignments`, etc. already work for trainer-owned players (they do; tags are scoped by `trainer_id`).
- Mobile-only redesigns beyond what comes free with `PageHeader` + `TableToolbar`.

## Suggested execution order

1. Move the eight shared components to neutral folders (mechanical, low-risk).
2. Trainer Players parity — biggest perceived gap.
3. Trainer Calendar parity — biggest functional gap.
4. Trainer Invoices bulk + presets + banner color.
5. Trainer Create/Edit Invoice presets row.
6. Visual shell pass on the remaining trainer pages.

Each step is independently shippable so we can review and adjust as we go.
