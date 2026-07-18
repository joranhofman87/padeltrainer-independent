# AI Development Guide

Purpose: the first doc a future AI agent (Claude/Codex) or human reads before touching padeltrainer. It is the router to the canonical docs and the hard rules for making safe, consistent changes.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-18

> **Read order for a new agent:** this file → [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) → [`MUTATION_BOUNDARIES.md`](./MUTATION_BOUNDARIES.md) + [`INVARIANTS.md`](./INVARIANTS.md) for money/scheduling work → the topic doc for your change type (below). [`../AGENTS.md`](../AGENTS.md) stays as the short tooling/frontend cheat-sheet; this guide extends it, it does not replace it.

---

## 1. App overview

Padeltrainer is a multi-tenant SaaS for padel academies, trainers, clubs, and players: scheduling, registrations, bookings, invoicing, and Mollie payments.

- **Stack:** React + TypeScript + Vite SPA; Supabase (Postgres + RLS + `SECURITY DEFINER` RPCs + ~96 Deno edge functions + pg_cron); Mollie via OAuth-connected accounts; react-i18next (nl/en); email via Resend.
- **Roles** (`app_role` enum): `player`, `trainer`, `academy_manager`, `club_manager`, `admin`. RLS is gated by the `has_role()` SECURITY DEFINER function. **Clubs are read-only** for scheduling.
- **Not this app:** Rallyo is the free tournament product — different repo, no payments/trainers/academies. Don't cross-reference.

## 2. Domain map

The entity graph, the 14 domains, and the canonical write for each live in **[`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md)** — read it before any scheduling/registration/booking/invoicing change.

The money spine in one line:
`registrations --source_cycle_id--> cycles(type='cyclus') --cyclus_id--> availability_slots --slot_id (CASCADE)--> bookings`; `invoices` reference bookings via `booking_ids uuid[]` **with no FK**. **The slot is the price source of truth** (`price_per_session` / `split_payment` / VAT) — never a cycle-level scalar ([ADR-0002](./adr/0002-slot-is-price-source-of-truth.md)).

## 3. Where to add code

| You're adding… | Put it… |
|---|---|
| A domain write (create/cancel/edit/delete of booking, slot, cycle, invoice, claim, player identity) | A `src/lib/*` facade or a `SECURITY DEFINER` RPC — **never** a raw `.insert/.update/.delete` in a page/component. See [`MUTATION_BOUNDARIES.md`](./MUTATION_BOUNDARIES.md). |
| Privileged / cross-tenant server work | An edge function in `supabase/functions/*`, self-authenticating via [`_shared/auth.ts`](../supabase/functions/_shared/auth.ts) ([ADR-0007](./adr/README.md)). |
| A list/calendar/dashboard/public read | Follow [`PERFORMANCE_QUERY_RULES.md`](./PERFORMANCE_QUERY_RULES.md); paginate with [`src/lib/supabasePaging.ts`](../src/lib/supabasePaging.ts) or a clamped list RPC. Never an un-paginated `select()` (silent 1000-row cap). |
| Shared UI | Reuse a primitive from [`COMPONENT_PATTERN_REGISTRY.md`](./COMPONENT_PATTERN_REGISTRY.md); a page is a thin wrapper. |
| Anything money/data-critical | Read [`EXTENDING_THE_DOMAIN.md`](./EXTENDING_THE_DOMAIN.md) (the change playbook) first. |

## 4. Where NOT to add code

- **No identity logic off `player_id`/`guest_player_id`/`linked_profile_id` alone.** One human =
  one `persons` row ("has a login" = `persons.user_id IS NOT NULL`); identity truth is
  `persons`/`person_links`. Before touching ANY player/guest key, read
  [`src/lib/personIdentity.ts`](../src/lib/personIdentity.ts) (the TS doctrine home),
  [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) §5 and [`INVARIANTS.md`](./INVARIANTS.md) I-15..I-22
  (FAM-02: dual-key rows belong to the guest person; split-frozen guests read as their own person
  via the frozen-CASE pattern; type labels tell LOGINS, not seats).

- **No business-critical mutations in UI components or pages.** Route dangerous actions through domain helpers / RPCs / edge functions ([ADR-0003](./adr/0003-mutation-boundary-facades.md)). The mutation boundary is shrink-only — `src/test/mutationBoundary.test.ts` fails if you add a new page-level write.
- **No cross-role imports.** `components/<role>` and `pages/<role>` must not import another role's code (ESLint `no-restricted-imports`, baseline = 0). To share, lift to a neutral folder (`components/ui`, `components/slots`, `components/invoices`, `components/players`, `hooks/`, `lib/`). Note: `components/player` = the player role (private); `components/players` = shared.
- **No new UI primitive when one exists.** Check the registry first (§10).
- **No cycle-level price scalar.** Price lives on the slot ([ADR-0002](./adr/0002-slot-is-price-source-of-truth.md)).
- **No new `any`; no new lint suppressions.** Fix-and-prune only.

## 5. Required tests by change type

Full matrix in **[`TESTING_STRATEGY.md`](./TESTING_STRATEGY.md)**. Quick map:

| Change | Minimum test |
|---|---|
| Money-path lib (bookings/cycles/invoices/registrations) | vitest unit + a `*.pglite.test.ts` integration against real Postgres-in-WASM ([`src/test/fixtures/pgliteSupabase.ts`](../src/test/fixtures/pgliteSupabase.ts)) |
| New migration / RLS / RPC | add/extend a `scripts/db/rehearse-*` invariant; `npm run db:reset` must stay green |
| Edge function logic | put testable logic in `supabase/functions/_shared/*` (only `_shared/` is in CI) + a deno test |
| Shared component | vitest `.tsx` render test; contract test before consolidating a money-flow component |
| i18n keys | en/nl parity (`i18n:check`) |

Open coverage gaps are tracked in [`TEST_COVERAGE_GAPS.md`](./TEST_COVERAGE_GAPS.md) / [`payments/PAYMENT_TEST_GAPS.md`](./payments/PAYMENT_TEST_GAPS.md).

## 6. Common mistakes to avoid

- **`npm run typecheck` / root `tsc` checks NOTHING** (`files:[]`). The real gate is `npm run typecheck:baseline` (`tsc -p tsconfig.app.json`, ratcheted vs `scripts/tsc-app.baseline.json`).
- **Edge-function `index.ts` bodies are NOT type-checked or deno-checked in CI** — only `_shared/` is. A runtime `ReferenceError` in an edge fn will pass CI. Verify imports by hand.
- **Un-paginated `select()`** silently truncates at 1000 rows — corrupts money aggregates. Always paginate.
- **Registration price must equal the invoice price must equal the confirmation email** — the confirmation email is composed in **two** places (client `CycleApplicationForm` self-reg + `submit-guest-intake` edge fn). Change both.
- **Don't downgrade a paid booking/invoice** and don't hard-delete — soft-cancel only ([`INVARIANTS.md`](./INVARIANTS.md)).
- **Split divisor = group-per-slot.** Pass `splitAmongPlayers = N` or you N×-overcharge (or under-split).
- **types-drift CI job is perma-red** on a line-10 CLI mismatch → merge with `--admin`; the real migration gate is `supabase db reset`.
- **Don't re-add academy Agenda nav** (deliberately removed; route still mounted as a deep-link). Trainer keeps Agenda.

## 7. Deployment caveats

- **Frontend auto-deploys** via Vercel on merge to `main`.
- **Edge functions and DB migrations do NOT auto-deploy.** CI only *validates* them; the owner applies them manually (Supabase dashboard SQL editor / `db push`, edge-fn redeploy). You have no service key.
- Therefore every migration/edge-fn change must **degrade gracefully** until the owner deploys — feature-flag or fallback so the live frontend doesn't break against un-migrated prod. List owner-deploy steps explicitly in your PR body.
- See [`../DEPLOYMENT_GUIDE.md`](../DEPLOYMENT_GUIDE.md) and [`deployment/`](./deployment/) for the checklist.

## 8. Supabase edge-function caveats

- All edge fns run with **`verify_jwt=false`** and **self-authenticate** via [`_shared/auth.ts`](../supabase/functions/_shared/auth.ts) (`requireUser` / service-role check). The SPA never holds a service-role key ([ADR-0007](./adr/README.md)).
- Service-role bypass is a real timing-safe key compare ([`_shared/service-role-auth.ts`](../supabase/functions/_shared/service-role-auth.ts)) — do not weaken it to a claims-only check (that was the fixed P0).
- The `check:edge-config` gate enforces a hand-maintained `verify_jwt` allowlist — a new public function must be added to it deliberately.
- **Bundle shared logic in `_shared/`** so it is testable and CI-covered; keep `index.ts` thin.

## 9. Payment / booking / rebooking rules

Deep detail in [`payments/`](./payments/) (flow map, 15 invariants, reconciliation, recovery runbook). The load-bearing rules:

- **Charge == confirm the org's intent.** A successful Mollie charge is the confirmation; `applyBookingPaymentWriteback` ([`_shared/mollie-webhook-payment.ts`](../supabase/functions/_shared/mollie-webhook-payment.ts)) is the only path that flips bookings/invoices to paid.
- **No double-invoice.** Create invoices only via the deduped path (`create_invoice_deduped` RPC, md5-exact-set unique index). Rebooking-group payment flips all linked `booking_ids` in one webhook.
- **M-17 double-booking guard** = partial unique indexes on active bookings; the webhook tolerates the `23505` collision, never crashes on it.
- **Pay-first holds:** the public booking widget holds a slot only while checkout runs — unpaid intent never permanently blocks capacity ([ADR-0005](./adr/README.md)).
- **Rebooking = priority-claim invites + a group captain who books the whole group and pays once, always full price** ([ADR-0004](./adr/0004-rebooking-priority-claims.md)). Do not flip a slot's `split_payment` to fix rebook pricing — it overcharges the deferred no-Mollie fallback.
- **Never test live money or send live email** unless the user explicitly asks. Everything here is read-only against code.

## 10. Component usage rules

Before writing markup, find your pattern in **[`COMPONENT_PATTERN_REGISTRY.md`](./COMPONENT_PATTERN_REGISTRY.md)** and reach for the one component named. Reuse before creating.

- Pages are thin wrappers around `AppPage`/`PageHeader`/`DataTableCard`/`EmptyState`/`StatTile`/`useTableSort` and the shared `components/invoices` + `components/players`.
- **Share the presentational leaf, not the business rule.** `FormField`-wrapper / `EntityCombobox` / `TrainerPageHeader↔PageHeader`-merge style abstractions are explicitly rejected ([ADR-0008](./adr/README.md)).
- Consolidation candidates and unbuilt primitives (`ConfirmDialog` adoption, `SelectFilter`, `FullPageLoader`, `CycleStatusBadge`) are tracked in [`COMPONENT_REUSE_AUDIT.md`](./COMPONENT_REUSE_AUDIT.md) / [`technical-debt/COMPONENT_REUSE_BACKLOG.md`](./technical-debt/COMPONENT_REUSE_BACKLOG.md). A money-flow component needs a contract test before you consolidate it.

## 11. Documentation update rules

**When you change architecture or a core flow, update the relevant canonical doc in the same PR** — a stale canonical doc is worse than none.

| You changed… | Update… |
|---|---|
| Entity graph / a domain's write path | [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) |
| A dangerous mutation's location or facade | [`MUTATION_BOUNDARIES.md`](./MUTATION_BOUNDARIES.md) |
| A hard rule (payment/tenancy/token) | [`INVARIANTS.md`](./INVARIANTS.md) |
| A structural decision | add/supersede an ADR under [`adr/`](./adr/) (supersede, don't rewrite) |
| A CI gate | [`QUALITY_GATES.md`](./QUALITY_GATES.md) |
| A shared component contract | [`COMPONENT_PATTERN_REGISTRY.md`](./COMPONENT_PATTERN_REGISTRY.md) |

Historical audits under [`audits/`](./audits/) are evidence anchors — don't delete them, and don't treat their already-fixed findings as open (see §12).

## 12. How to verify work before reporting done

Run the exact per-PR CI gates locally and keep them green (details + traps in [`QUALITY_GATES.md`](./QUALITY_GATES.md)):

```
npm run lint             # ratcheted; never add violations, prune when you fix one
npm run typecheck:baseline   # the REAL type gate (root tsc is a no-op)
npm test                 # vitest unit + PGlite integration
npm run test:edge        # deno tests on _shared/
npm run db:rehearse:all  # data-integrity / RLS / list-partition invariants
npm run i18n:check       # en/nl parity (if you touched i18n)
npm run build            # Vite production build
```

For a migration change also run `npm run db:reset` (the real migration gate). Report which gates you ran.

### Current state (do NOT reopen — fixed & deployed 2026-07-02)

The [fresh-eyes audit](./audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) is the audit of record. These are **fixed and deployed** — treat any older audit describing them as open as stale/historical: forged-JWT service-role bypass (P0); `swap_slots` ownership guard; `merge_guest_players` cascade; M-17 webhook `23505` tolerance; extras charge/invoice; `create_invoice_deduped` dedup RPC; invoice-sync paging (now via `src/lib/supabasePaging.ts`); academy-Mollie routing. Push/OneSignal is disabled (email-only). Still open: Mollie idempotency-key on retry (G2), capacity lock on logged-in cyclus (B-1), refund/chargeback webhooks not recorded (B-3), no `deno check` on edge-fn `index.ts` (CI gap). See [`technical-debt/`](./technical-debt/) for the ranked backlogs.
