# Wave 4 — scope & plan (2026-06-12)

Sources: T4 walkthrough findings W-01..W-10 (docs/AUDIT-2026-06.md), the three
deliberate Wave-3 deferrals (M-38, M-33, M-32/34/35), a five-scout codebase
measurement pass, and a prod data X-ray (migration 20260612150000).

Two corrections to the T4 findings, from measurement:

- **W-09 (no save feedback)** — the success-toast *call exists*
  (InvoiceSettingsCardBase.tsx:310) but uses the legacy radix toast store while
  the page renders sonner toasts, so it never displays; plus a miswired
  "Saving…" label. The fix is a toast-system rewire, not a missing call.
- **W-02 (onboarding English)** — AcademyOnboarding is *fully translated*
  (all 23 keys exist in nl). Wilma saw English because the language never
  activates: no LanguageSwitcher outside MarketingLayout, detection order
  quirks, and the only in-app language control is a buried Select in
  AcademySettings that also offers three unsupported languages.

---

## Workstream A — NL localization of the owner app (W-01/W-02/W-03)

Measured shape of the problem (47 academy files + auth/shells):

- **Zero purely-hardcoded files.** The dominant defect: **282 unique keys**
  used as `t('key', 'English default')` that exist in *neither* en nor nl JSON
  (academy 176, trainer 67, cycles 24, common 15) — invisible in English QA,
  English-only for NL users. nl/academy.json has 100% parity with en (518/518):
  the missing keys were simply never extracted.
- **~170 genuinely hardcoded literals**, 75% concentrated in 8 files:
  AcademyTrainerDetail (31), AcademyCycleDetail (22), RequestLocationDialog
  (21, incl. 10 country names → replace via Workstream B utility),
  AcademyIntakeRequests (14), AcademyDayGrid (13), CreateAcademyTrainerDialog
  (10), AcademyCalendar (10), AcademyProfile (10).
- Auth funnel + all five role shells/sidebars: translated except ~20 missing
  keys (mostly aria-labels) and a 3-string block in ClubOnboarding.
  TrainerSidebar hardcodes "Logout".
- 2 raw-key renders (key shown to user): `common:unknown` (AcademySettings),
  `common:goHome` (AcademyTrainerInvitation).
- Admin app: 14/20 internal sub-pages have zero i18n — **proposed skip**
  (internal tool; confirm).

Plan (the trainer app shares namespaces — every key filled benefits both):

| # | Item | Size |
|---|------|------|
| A1 | Backfill the 282+20 missing keys into en+nl (JSON-mostly; reuse the wave-3 key-sweep script to enumerate exactly) | M |
| A2 | Extract ~170 hardcoded literals to t() with en+nl entries (8 files carry 75%) | M |
| A3 | Language activation: render LanguageSwitcher in the app shells (academy/trainer/club/player headers) and on /auth + signup layouts; restrict the AcademySettings language Select to en/nl; fix the path-detector quirk (`/app/*` parsed as language with no supportedLngs) | S-M |
| A4 | Fix the 2 raw-key renders + TrainerSidebar Logout + ClubOnboarding block | S |

Acceptance: with browser language nl (or switcher set to NL), the full Wilma
journey (login → onboarding → dashboard → players → invoices → settings) shows
zero English strings; EN remains intact; lint ratchet green.

## Workstream B — club/country data normalization (W-06)

Prod X-ray (12,738 locations): 99 distinct country labels — `NL` 940 +
`Netherlands` 606 (split!), 1,707 ISO-code rows vs ~11k English names, garbage
values ("Cala Rajada", "rance", flag emoji), 80–97 city-casing duplicate
groups, 50 exact duplicate clubs, 296 shared-address groups (~635 rows).
**Live bug found while scoping: the picker's default `country='NL'` filter
hides all 606 "Netherlands"-labeled Dutch clubs.** Root cause: unconstrained
TEXT column filled by a raw bulk import; the picker derives its dropdown from
raw distinct values via a 29-entry mixed-language map (duplicated across 2
sibling pickers).

| # | Item | Size |
|---|------|------|
| B1 | Country utility: ISO-3166 codes + `Intl.DisplayNames` per-language labels + variants/typo map; replace the 7 consumer sites (incl. both pickers + RequestLocationDialog's hardcoded list) | S |
| B2 | Backfill migration: map all 99 labels → ISO codes (~100-entry mapping, 1 manual row), CHECK constraint on locations + location_requests; rehearse, then push (fixes the hidden-606 bug immediately) | S |
| B3 | City canonicalization backfill (mode-based casing per (country, city) group) | S |
| B4 | Club dedupe: soft-retire via `merged_into` column, 14-FK repoint with junction dedup, survivor policy, slug redirect, **dry-run report first**, prevention unique index | L |
| B5 | public-api compat: `?country=` name→code alias so external consumers don't break post-backfill | S |

B4 is the only careful piece (CASCADE deletes on 4 junction tables; claimed
`club_profiles` pairs need a manual path). Ship B1+B2+B5 together; B3 next;
B4 last with its dry-run reviewed.

## Workstream C — T4 UX fixes (exact map in scout output)

| # | Item | Fix | Size |
|---|------|-----|------|
| C1 (W-04/U-23) | 4 dashboard "No data yet" cards | EmptyState already supports description+action — mirror AcademyPlayers.tsx:563; ~4 hint keys ×2 langs | M |
| C2 (W-05) | "training contract" jargon | 2 locale value edits, no TSX | S |
| C3 (W-07) | Create vs Invite trainer | caption explaining the choice + email copy-button (password copy exists) + i18n-ify ~8 strings in that dialog | M |
| C4 (W-08) | 3-way Create Registration choice | one-line explainers (2 new keys; third reuses bulkCopy.subtitle); mirror to trainer/club cycles pages | S |
| C5 (W-09) | invisible save toast | rewire InvoiceSettingsCardBase to sonner + fix "Saving…" label; regression-check the TRAINER settings page (shared base) and renumber/bulk-VAT toasts | S |
| C6 (W-10) | pay-page table clipped at 375px | wrapper uses `overflow-hidden` → `overflow-x-auto` (one class) | S |

## Workstream D — deferred money items (decision needed)

**M-38 (refund/credit-note):** recommend **option (a) — real credit-note
invoices**: negative line items + `credited_invoice_id`, numbered by the
existing atomic allocator, PDF variant, badges on both invoices. Legally sound
(NL invoicing), aligns with M-13 ("paid is immutable — correct via credit
note"). Total L, decomposed into 5 S/M slices (schema S; createCreditNote lib +
DeleteSlotDialog rewire M; PDF variant S-M; pay-link/email guards S; list
badges S). Guardrails from review: existing-credit-note lookup (no
double-credit), negative-VAT unit tests land WITH the lib, credit notes must
NOT carry booking_ids (or every `.overlaps()` sync starts rewriting them).
Option (b) field-level refund log is M but produces no legal document and
violates the M-13 principle — not recommended.

**M-33 (split state in "(1/N)" regex):** `invoices.split_count` column;
5 reader sites + 6 writer clusters; readers get "column, else regex" fallback;
backfill parses the trailing `\(1/(\d+)\)$` marker. Size M. Unlocks cleaner
M-32/M-34/M-35 fixes (cent-drift family) afterwards — those stay deferred
until split_count lands.

## Suggested order & totals

1. **A3 + A4 + C5 + C6 + B2/B1/B5** — small, high-visibility, fixes the
   hidden-Dutch-clubs bug and makes NL activation real (~1 batch).
2. **A1 then A2** — the key backfill + extraction (the bulk of Wave 4).
3. **C1–C4** — UX copy/empty states.
4. **B3, then B4** (dry-run gate) — data hygiene.
5. **D: M-33 (M), then M-38 slices (L)** — if approved.

Rough total: ~9 S, ~5 M, 2 L (B4 club-dedupe, M-38 credit notes).

## Decisions (taken by maintainer, 2026-06-12)

1. **Admin app translation**: SKIPPED — internal tool stays English.
2. **M-38 credit notes**: DEFERRED — not in Wave 4.
3. **M-33 split_count**: IN, **forward-only** — new invoices write
   split_count; existing invoices are NOT touched (no backfill, no rewriting
   of generated invoices). Readers use column-if-present, else the legacy
   "(1/N)" regex, indefinitely.
4. **B4 dedupe survivor policy**: claimed club wins, else oldest row keeps its
   slug; dry-run report reviewed by maintainer before any merge executes.
5. **NL tone**: informal "je", consistent with the existing nl files.
