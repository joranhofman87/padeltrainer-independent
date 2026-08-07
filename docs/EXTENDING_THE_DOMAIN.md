# Extending the domain safely

> A playbook + checklist for changing the **scheduling / registration / booking / invoicing**
> domain — the money- and data-critical core. It builds on [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md)
> (the entity map + the canonical write boundaries). For component/role concerns, see
> [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) and [`UI_COMPONENT_STANDARDS.md`](./UI_COMPONENT_STANDARDS.md)
> — this doc does not repeat them.

## Before you start

1. Read the **write-boundary table in [`DOMAIN_MODEL.md §5`](./DOMAIN_MODEL.md)**. Almost every domain
   write already has a canonical entry point. Reuse it.
2. If you're touching a page/component, check the role-isolation rules (`FRONTEND_ARCHITECTURE.md §74`)
   — only **academy + trainer** create/edit; **clubs are read-only**.

## How to add a scheduling / money-domain feature

1. **Find the canonical write, don't reinvent it.** Removing a player → `cancelBookingsAndSync`.
   Deleting slots → `applySlotDeleteToCycle`. Editing a cycle's slots/price → `applySlotEditToCycle` /
   `updateCyclePricing`. Creating/editing a form → `createRegistration` / `updateRegistration`. A raw
   `supabase.from('bookings'|'availability_slots'|'invoices').insert/update/delete` in a page/component is
   almost always a bug waiting to happen — that's exactly the class this sprint spent its time fixing.
2. **If a genuinely new write is needed**, add it as a thin function in the matching `src/lib/*.ts` facade
   (so the rule lives in ONE place), or — when it must be atomic across rows — as a `SECURITY DEFINER` RPC
   (the established pattern: `apply_slot_delete_to_cycle`, `update_cycle_pricing`, `finalize_cycle_proposals`).
   Never spread a multi-step money mutation across separate client round-trips (TOCTOU + partial-failure).
3. **Reconcile invoices whenever bookings or price change.** There is no FK on `invoices.booking_ids`, so a
   cancel/remove/price-change that doesn't call the matching `sync*` helper leaves the player billed for
   something that no longer exists. `cancelBookingsAndSync` does this for you; bespoke paths must do it
   explicitly. Pass `splitAmongPlayers = N` to `auto-create-invoice` on split cycles or you over-charge N×.
4. **Respect the invariants** (`DOMAIN_MODEL.md §6`): soft-cancel (never hard-delete) a booking; never
   downgrade a paid booking; cascade-aware slot deletes; additive migrations only.
5. **Test it against real SQL** (see the harnesses below), not a hand-rolled mock — the money bugs this sprint
   fixed all passed naive unit tests.
6. **Run the gates** (next section) and, for any money/data-path change, get an adversarial review.

## Domain-change PR checklist

Copy into the PR description for any change touching scheduling/registration/booking/invoicing:

```md
### Domain-change checklist
- [ ] Uses the canonical write fn / RPC (DOMAIN_MODEL.md §5), not a raw page-level mutation
- [ ] Invoices reconciled on every booking/price change (no stale `booking_ids`); `splitAmongPlayers` passed on split cycles
- [ ] Bookings are soft-cancelled, never hard-deleted; slot deletes go through `applySlotDeleteToCycle`
- [ ] Paid bookings cannot be downgraded; payment writes keep the `payment_status != 'paid'` guard
- [ ] Migration (if any) is additive / non-destructive; `supabase db reset` passes
- [ ] Real-SQL coverage added/updated (PGlite test or rehearsal), not just a mock
- [ ] Gates: tsc · eslint (incl. role-isolation) · i18n parity · vitest · build · (edge: deno check + `npm run test:edge`)
- [ ] All affected roles checked (academy / trainer / club-read-only / player)
- [ ] Adversarial review for money/data paths
- [ ] Owner deploy noted (migration order + edge-fn redeploys) if not FE-only
```

## Gates (quick reference)

| Surface | Command |
|---|---|
| Types | `npm run typecheck:baseline` (bare root `tsc --noEmit` checks nothing) |
| Lint (incl. role isolation) | `npx eslint <files>` |
| i18n nl↔en parity | `npm run i18n:check` |
| Client tests | `npx vitest run` |
| Build | `npm run build` |
| Edge fn types | `deno check supabase/functions/<fn>/index.ts` |
| Edge `_shared` tests | `npm run test:edge` |
| Migration (real gate) | `supabase db reset` (local Docker); types-drift CI gate is green — ship regenerated `types.ts` with the migration (or pull the CI `types-generated` artifact), never merge `--admin` |
| DB RPC rehearsals | `npm run db:rehearse:all` (auto-discovers `scripts/db/rehearse-*`) |

## Test harnesses available

- **PGlite-Supabase adapter** (`src/test/fixtures/pgliteSupabase.ts`) — run the REAL client lib against real
  Postgres-in-WASM from vitest. Use `// @vitest-environment node` + the `vi.hoisted` Proxy mock pattern (see
  `src/lib/invoiceSync.pglite.test.ts`). Tests the **client** TS, not Deno edge fns.
- **PGlite rehearsals** (`scripts/db/rehearse-*.{ts,mjs}`) — apply the ACTUAL migration SQL to PGlite and assert
  RPC behaviour (stub `auth.uid()` via a GUC, `CREATE ROLE authenticated`/`service_role` for GRANTs).
- **Deno tests** (`supabase/functions/_shared/*.test.ts` via `npm run test:edge`) — for pure `_shared` logic
  (pricing goldens, payment decisions). Edge handlers themselves aren't directly testable — extract their
  money logic into client-injectable `_shared` fns (as `applyBookingPaymentWriteback` did).

## Critical-flow test matrix

What covers each money/data-critical journey today. Add to the matching file when you extend a flow.

| Journey | Covering test(s) / rehearsal |
|---|---|
| Booking cancel → invoice reconcile (no stale billing, split share kept) | `src/lib/invoiceSync.pglite.test.ts`, `src/test/invoiceSync.test.ts`, `src/lib/bookings.test.ts` |
| Mollie webhook → booking paid: idempotency + no paid→pending downgrade | `src/test/mollieWebhookWriteback.pglite.test.ts`, `src/test/mollieWebhookPayment.test.ts`, `src/test/mollieWebhookMetadata.test.ts` |
| Finalize proposals: atomic claim → bookings → assignments (all-or-nothing) | `scripts/db/rehearse-finalize-proposals.ts` |
| Slot delete guard: protect booked, atomic vs cascade | `src/test/applySlotDeleteToCycle.test.ts`, `scripts/db/rehearse-apply-slot-delete.mjs` |
| Whole-cycle slot edit (atomic) | `src/test/applySlotEditToCycle.test.ts`, `scripts/db/rehearse-apply-slot-edit.mjs` |
| Cycle price change + split divisor recompute | `scripts/db/rehearse-cycle-pricing-relock.mjs`, `scripts/db/rehearse-cycle-pricing-revert.mjs`, `scripts/db/rehearse-recalc-split.mjs`, `scripts/db/rehearse-split-payment-trigger.mjs` |
| Player can't edit `payment_status`/`paid_at` (trigger) | `src/test/bookingFinancialGuard.test.ts`, `scripts/db/rehearse-booking-financial-guard.ts`, `src/test/migrationsBookingsRls.test.ts` |
| Registration create/edit: write RPCs + settings split | `scripts/db/rehearse-registration-write.ts`, `src/test/registrations.test.ts`, `src/test/settingsSplit.golden.test.ts` |
| Registration pricing (server-trusted, no €0/underpay) | `supabase/functions/_shared/registration-pricing.golden.test.ts`, `src/test/registrationPricing.test.ts` |
| Capacity locks: no overbooking under concurrency | `scripts/db/rehearse-capacity-locks.mjs`, `scripts/db/rehearse-book-slot.mjs` |
| Invoice numbering: atomic, no duplicates | `scripts/db/rehearse-m10-invoice-numbering.ts` |
| Rebook group: one captain books all + pays once | `scripts/db/rehearse-rebook-group-claims.ts`, `src/test/rebookManage.test.ts`, `src/test/priorityClaims.test.ts` |
| Cycle-detail view (roster / sessions / scoped actions) | `src/test/cycleDetailView.test.tsx`, `src/lib/cycleDetail.test.ts` |
| Mollie account readiness / payment-ready gating | `supabase/functions/_shared/mollie-payment-ready.test.ts`, `src/test/academyMollieSettingsState.test.ts` |

**Known coverage gaps (good next slices):**
- Registration price **≡ invoice ≡ confirmation-email** parity across all three surfaces (the price is computed in
  three places; a golden that asserts they agree would lock it — Phase 5 pricing golden).
- bulk-rebook **dry-run preview ≡ real charge** (verified consistent by hand, but no test pins it).

## Adding a shared component

Already covered — follow [`UI_COMPONENT_STANDARDS.md` §"When you add a new shared component"](./UI_COMPONENT_STANDARDS.md)
and the role-isolation layers in [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md). The one domain-specific
addition: if the component issues a domain write, it must call a canonical write fn (above), not a raw mutation —
keep components presentational and push money/data writes down into `src/lib/*`.
