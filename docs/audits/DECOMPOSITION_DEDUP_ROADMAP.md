# Decomposition + De-dup Roadmap (god-components & role-page duplication)

Ranked, risk-adjusted plan for the foundation sprint's #1 maintainability liability: near-duplicate role pages + god-components (1.5k–2.5k lines). Verified against the repo on 2026-06-29. Every slice lands in **neutral** folders (`components/{slots,players,invoices}`, `src/lib/cycles/`) so the zero-baseline role-isolation guardrail is never tripped, and is **behavior-frozen** (props-injected extraction / re-export shim / verbatim move).

Scoring: value/safety = high/med/low; size ≈ lines moved.

## Wave 1 — start now (high value, high safety, pure mechanical)
| # | Slice | Type | Files | ~Lines | Status |
|---|-------|------|-------|--------|--------|
| 1 | **Split `BulkCreateContent` out of `AddSlotDialog.tsx`** → `components/slots/BulkCreateContent.tsx` + re-export shim | decompose | AddSlotDialog.tsx | ~1555 | **✅ done (this PR)** — AddSlotDialog 1997→395 |
| 2 | Extract verbatim PlayerDetail helpers → `components/players/playerDetailParts.tsx` (Stat/Empty/InvoiceStatus/RatingTrendCard) | dedup | trainer/academy PlayerDetail | ~125 ×2 | next |
| 3 | Extract `intakeCsv.ts` (`exportIntakeRequestsToCsv`) out of `lib/cycles.ts` behind a barrel | lib-split | lib/cycles.ts | ~100 | next |

## Wave 2 — next (high value; touches a shell or money payload → add a characterization test)
| # | Slice | Type | Files | ~Lines |
|---|-------|------|-------|--------|
| 4 | `PlayerDetailLayout` skeleton lift (6 sections + per-role data hook) — follows slice 2 | dedup | trainer/academy PlayerDetail | ~440 |
| 5 | Finish `InvoiceSettingsCardBase` convergence (debt #2; academy canonical → trainer converges) | dedup | components/{trainer,academy} InvoiceSettingsCard | ~150 |
| 6 | Extract `CampaignHistoryView` from `EmailCampaignTab` (read-mostly, props-injected) | decompose | components/players/EmailCampaignTab.tsx | ~210 |
| 7 | Extract `DiscountFields` from `BookForPlayerDialog` (+ characterization on discount payload) | decompose | components/booking/BookForPlayerDialog.tsx | ~90 |
| 8 | `lib/cycles.ts`: lift `cycleTypes.ts` + `cycleMappers.ts` (pure types/mappers) behind barrel | lib-split | lib/cycles.ts | ~280 |
| 9 | Migrate `TrainerInvoices` onto `ListPageShell`/`ListPageState` (zero-visual; recipe = PR #101) | dedup | pages/trainer/TrainerInvoices.tsx | shell swap |

## Wave 3 — later (medium value or higher entanglement / product decisions)
| # | Slice | Type | Files |
|---|-------|------|-------|
| 10 | `lib/cycles.ts`: `cycleReads.ts` then `slotScheduling.ts`/`proposals.ts` behind barrel | lib-split | lib/cycles.ts |
| 11 | `lib/cycles.ts`: `cycleWrites.ts` + `intakeRequests.ts` **LAST** (money: pricing/edit/intake) — pair with existing tests | lib-split | lib/cycles.ts |
| 12 | Split `lib/academy.ts` (1120, 34 importers) 5-way behind barrel | lib-split | lib/academy.ts |
| 13 | `AcademyEditDialog` relation tabs → props-injected sections; start with the Managers tab | decompose | components/admin/AcademyEditDialog.tsx |
| 14 | `useInvoiceListPage` orchestration hook (shared query/mutation/dialog block) — after slice 9 | dedup | trainer/academy Invoices |
| 15 | Migrate `TrainerPlayers` onto `ListPageShell` (zero-visual; keep role logic separate) | dedup | pages/TrainerPlayers.tsx |
| 16 | Invoice create/edit form scaffold (characterization on `invoiceFormTotals.ts`) | dedup | trainer/academy Create/EditInvoice |
| 17 | `TrainerScheduleOverview` `EditCycleDialog` extract — **BLOCKED on product decision** (should it converge onto `CycleDetailView` first?) | decompose | pages/TrainerScheduleOverview.tsx |
| 18 | Split `lib/priorityClaims.ts` (938) + `lib/club.ts` (840) behind barrels | lib-split | lib/{priorityClaims,club}.ts |

## Deliberately deferred (flagged so a future slice doesn't chase them)
- **`CycleForm.tsx` (2477)** — biggest but hardest: ~30 interdependent `useState`, a price-table matrix with cross-cell mutation, a draft-persistence effect that serializes ALL state, and it's the canonical registration/event write path. Sub-sections share the draft-serialize closure → extraction risks the draft round-trip + submit payload. When tackled, extract leaf read-only pieces (price-overview summary) or route through the existing `DayAvailabilityPicker`/`ExtraCostsEditor`, NOT the stateful pricing matrix.
- **`ProposalScheduleGrid.tsx` (1967)** — already decomposed into ~15 dnd-kit-coupled sub-components (shared drag overlays/undo stack). Low value, high entanglement. Leave it.
- **`AcademySlotDetail` (1040) vs `TrainerSlotDetail` (522)** — NOT a near-duplicate (whole-cycle surface already shared via `CycleDetailView`). Treat as a god-component split of `AcademySlotDetail` later, not a cross-role dedup.
- **`ClubPlayers`**, settings/subscription/dashboard clusters — different data sources / Stripe-facing / more product decisions. Defer.

## Sequencing logic
Wave 1 delivers the largest line reduction at the lowest risk and unblocks `AddSlotDialog` for future shared adoption. Wave 2 builds on the patterns Wave 1 proves. Money/security-sensitive lib moves (`cycleWrites`/`intakeRequests`) are pushed to the end and always paired with existing characterization coverage.
