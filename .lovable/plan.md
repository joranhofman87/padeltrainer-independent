

## Goal
Full i18n sweep: close all translation gaps across NL, ES, DE, FR, IT, then localize every hardcoded user-facing string in the app — admin dialogs included.

## Approach (3 phases, executed sequentially in default mode)

### Phase 1 — Locale parity (translation files only)
Bring NL, ES, DE, FR, IT to 100% parity with EN across all 11 namespaces (`common`, `marketing`, `auth`, `player`, `trainer`, `club`, `cycles`, `admin`, `academy`, `waitingList`, `notifications`).

- Diff each EN namespace against each target locale, collect missing key paths.
- Translate missing keys via Lovable AI (Gemini 2.5 Pro) in batched calls per namespace per language.
- Preserve `{{interpolation}}` tokens, HTML tags, and casing rules: sentence case for NL, title case for EN, locale-natural casing for others.
- Merge translated keys into existing JSON files without overwriting any pre-existing values.
- Re-run the diff to confirm zero missing keys per language.

Estimated: ~25 JSON files updated.

### Phase 2 — User-facing hardcoded strings (high priority)
Localize the components real users (players, trainers, academy/club managers) interact with. Worked in batches by surface area:

**Batch 2A — Invoicing (highest priority, payment-critical)**
- `src/pages/trainer/TrainerCreateInvoice.tsx`
- `src/pages/academy/AcademyCreateInvoice.tsx`
- `src/components/invoices/CreateCustomInvoiceDialog.tsx`
- `src/components/invoices/EditInvoiceDialog.tsx`
- `src/components/player/PlayerInvoicesTab.tsx` (currently NL-only — full i18n pass)
- `src/components/trainer/InvoiceEmailDialog.tsx`

**Batch 2B — Cycles, registration, scheduling**
- All `src/components/cycles/*` and `src/pages/{trainer,academy}/cycle*` with hardcoded strings.

**Batch 2C — Players, profiles, booking**
- Player management tabs, profile dialogs, booking flow components.

**Batch 2D — Email/marketing tools surfaced to org users**
- `src/components/academy/EmailCampaignTab.tsx` and trainer equivalent.

**Batch 2E — Remaining role surfaces (club, academy, trainer dashboards)**
- All other flagged files in those directories.

For each file: extract literals → add keys to the appropriate namespace (`trainer`, `academy`, `player`, `club`, `cycles`, `common`) under sensible nested paths → replace with `t("ns.key")` or `<Trans>` for embedded markup → add the same key to all 6 locale files (translated, not just EN).

### Phase 3 — Admin surfaces
Admin tooling, lower priority but included for completeness:
- `src/components/admin/LocationEditDialog.tsx`
- `src/components/admin/AcademyEditDialog.tsx`
- `src/components/admin/TrainerEditDialog.tsx`
- `src/pages/admin/AdminUsers.tsx`
- `src/pages/admin/AdminBlogEditor.tsx`
- Remaining `src/components/admin/*` and `src/pages/admin/*` flagged files.

Keys go into the `admin` namespace, translated across all 6 locales.

### Verification after each phase
- Re-run the hardcoded-string scanner and locale-parity diff.
- Generate updated `i18n-key-coverage.md` and `i18n-hardcoded-scan.md` reports.
- Smoke-test critical pages (invoice pay, invoice create, cycle registration, player tab) in NL + DE + FR.

## Execution model
Because this touches ~190 component files plus 60 locale JSONs, work will be delivered in **multiple sequential batches** (one batch per turn) rather than a single mega-edit. After each batch I'll report progress (files done, keys added, remaining count) so you can pause/redirect at any point.

Order of execution:
1. Phase 1 (locale parity) — single batch, ~25 file updates.
2. Phase 2A → 2B → 2C → 2D → 2E — one batch each.
3. Phase 3 — one or two batches depending on size.

Total expected: ~7–8 implementation turns end-to-end.

## Out of scope
- Email templates and edge-function strings (separate server-side i18n system; flag as a follow-up if needed).
- Sanity CMS content (already locale-aware via the translation system).
- Any string changes that aren't locale-related (no copy edits, no UX changes).

## Files touched
- `src/i18n/locales/{en,nl,es,de,fr,it}/*.json` — additions only, no removals.
- ~190 component/page files under `src/components/` and `src/pages/`.
- New artifacts after each phase: `i18n-key-coverage.md`, `i18n-hardcoded-scan.md` regenerated under `/mnt/documents/`.

