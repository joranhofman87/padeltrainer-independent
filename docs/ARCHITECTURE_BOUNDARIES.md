# Architecture boundaries — what belongs where

Purpose: the canonical layering contract — which layer owns which responsibility, so a change lands in the right place and dangerous logic never leaks into a page.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

> Read this before deciding **where** a change goes. It answers "should this live in a
> component, a `src/lib` facade, an edge function, or an RPC?" and "how do academy /
> trainer / club share domain logic without forking it?" For the *entity* map read
> [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md); for the *per-write* boundary table read
> [`MUTATION_BOUNDARIES.md`](./MUTATION_BOUNDARIES.md); for *component/role isolation*
> read [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md). This doc is the
> connective tissue and does not repeat them.

## The layers, top to bottom

Dependencies point **downward**. Each layer trusts the layer below to enforce the
invariant; a page must never re-implement (or bypass) a rule that a lower layer owns.

| Layer | Where | Owns | Must NOT |
|---|---|---|---|
| **UI components** | `src/components/**`, `src/pages/**` | Presentation + orchestration: render state, wire user intent to a lib/edge call, choose *which* facade to call and with what args. | Contain money math, cross-tenant reads, or raw `supabase.from(...).insert/update/delete` on a high-risk table (guarded by `mutationBoundary.test.ts`). |
| **Domain lib** | `src/lib/**` | Domain logic + mutation **facades** + pricing + query helpers + types. One canonical entry point per dangerous write (ADR [`0003`](adr/0003-mutation-boundary-facades.md)). Client-callable, RLS-scoped. | Assume trust it hasn't verified — it runs as the signed-in user under RLS. It is **not** the place for service-role or cross-tenant work. |
| **Edge functions** | `supabase/functions/**` | The server/backend boundary: caller auth, money (server-trusted pricing), cross-tenant work, anything needing the **service role** or a third-party secret (Mollie, Resend). 108 fns (2026-08-08 count): 88 configured `verify_jwt=false` — authenticated class-appropriately (in-function via `_shared/auth.ts` or legacy direct `auth.getUser`; provider signatures; or deliberately public/token-scoped); ~20 effectively gateway-JWT-verified (unconfigured entrypoints inherit true). | Trust client-supplied prices or a decodable JWT claim for privilege. Skip the class-appropriate auth boundary (`requireUser`/`requireServiceRole` for user/service fns; provider verification for webhooks; token scoping for public fns). |
| **SQL / RPCs** | `supabase/migrations/**` | The durable floor: DB constraints, partial-unique indexes, RLS policies, triggers, and `SECURITY DEFINER` / `SECURITY INVOKER` RPCs for **atomic multi-row** ops that must hold even if every layer above is bypassed. | — (this is the backstop; if the invariant can live here, it should). |

Enforcement is strongest at the bottom:
`DB constraints / unique indexes → RLS → RPCs → edge fns → lib facades → UI`. See
[`MUTATION_BOUNDARIES.md` §Enforcement layers](./MUTATION_BOUNDARIES.md#enforcement-layers-most-durable--least).

---

## What belongs in each layer (the detail)

### UI components — presentation + orchestration only
- Render domain state; own local view state (open/closed, selected row, form fields).
- Translate a click into a **call to a named lib facade or edge function**, passing
  role-specific args (labels, query keys, `splitAmongPlayers`, submit handler).
- Show optimistic/loading/error UI and invalidate queries after the call returns.
- **Never** issue a raw high-risk mutation. A `supabase.from('bookings' | 'availability_slots' | 'cycles' | 'registrations' | 'invoices' | 'slot_priority_claims' | 'email_campaign_recipients').insert/update/delete` in a NEW file under `src/pages`/`src/components`, or one pushing an existing file's count ABOVE its stored ceiling, **fails `src/test/mutationBoundary.test.ts`** (count-neutral swaps and stale-headroom additions pass mechanically — the rule, not the test, is the contract) and points you to the owner. Reads and low-risk writes are fine.

### src/lib — domain logic + mutation facades
- One canonical function per dangerous write: e.g. `cancelBookingsAndSync` (`src/lib/bookings.ts:41`), `applySlotDeleteToCycle` (`src/lib/slotDeleteGuard.ts:65`), `applySlotEditToCycle` / `updateCyclePricing` (`src/lib/cycleWrites.ts`, `src/lib/cycles.ts`), the `sync*` invoice reconcilers (`src/lib/invoiceSync.ts`).
- Pricing + split math (`bookingPricing.ts`, `invoiceCalc.ts`, `cyclePricing.ts`), read/query helpers (`academyPlayersQuery.ts`, shared paging `supabasePaging.ts`), and shared types (`slotTypes.ts`, `cycleTypes.ts`).
- Facades bundle the invariant with the write — e.g. "cancel a booking" **always** reconciles its invoice, so billing can't go stale (that divergence was a real bug; see ADR 0003). A caller cannot forget the sync because it isn't a separate step.
- Runs client-side under the caller's RLS. If a write needs the service role, a secret, or must be trusted (money), it does **not** belong here — it belongs in an edge function.

### Edge functions — the server/backend boundary
- The trust boundary. Everything that must not be forgeable by a client lives here: **auth** (`requireUser` / `requireServiceRole`, `supabase/functions/_shared/auth.ts:48,65`), **money** (server computes the price; never accept a client-supplied amount → prevents €0/underpay), **cross-tenant** work, **service-role** writes, and **third-party** calls (Mollie OAuth, Resend).
- Most of the 108 fns run `verify_jwt=false` (88 configured entries) and authenticate class-appropriately — in-function via `_shared/auth.ts` or legacy direct `auth.getUser`, by provider signature, or deliberately public/token-scoped; ~20 are effectively gateway-JWT-verified (unconfigured entrypoints inherit true). `check:edge-config` gates a curated `MUST_VERIFY_JWT_FALSE` subset (corrected 2026-08-08). Service-role detection is a constant-time compare of the bearer/apikey against the real key (`isServiceRoleRequest`, `service-role-auth.ts:84`, `timingSafeEqual` at :53) — a decodable JWT claim is **not** trusted (that forged-JWT bypass was the fresh-eyes P0, now fixed + deployed). `check:edge-config` guards `verify_jwt` drift in CI.
- Not auto-deployed: the owner applies edge-fn changes manually; CI only validates (`deno test --no-check` on `_shared/` only). See [`DOMAIN_MODEL.md §Deploy & CI notes`](./DOMAIN_MODEL.md#deploy--ci-notes).

### SQL / RPCs — invariants + atomic multi-row ops
- The durable floor. Put a rule here when it must hold no matter what calls the DB:
  - **Constraints / partial-unique indexes** — e.g. `uniq_active_booking_per_slot_{player,guest}` (no double-book), `uniq_invoice_active_{player,guest}_bookings` (invoice dedup).
  - **RLS policies** — every tenant read/write gates on `has_role(uid, role)`; anon public pages read postgres-owned `_public` / `_safe` views, never anon base-table SELECT.
  - **Triggers** — `enforce_booking_slot_tier` (capacity), `protect_booking_financial_columns_for_players`.
  - **`SECURITY DEFINER` / `SECURITY INVOKER` RPCs** for atomic multi-row work that a client sequence can't do safely: `apply_slot_delete_to_cycle` (locks bookings `FOR UPDATE`, avoids the check-then-delete TOCTOU that cascade-destroyed a booking), `apply_slot_edit_to_cycle`, `update_cycle_pricing`, `create_/update_registration_with_cycle`, `create_invoice_deduped`, `merge_guest_players`.
- Real schema gate is `supabase db reset` (migrations.yml). Migrations are additive/non-destructive in the money domain. Not auto-deployed — owner applies manually.

### Shared components — leaf reuse, NOT business rules
- `components/ui` (design-system primitives) and neutral domain folders (`components/{invoices,players,cycles,slots,booking,...}`) hold **presentational leaves** reused across roles. They receive data + callbacks via props/slots; the role page supplies role-specific bits.
- **Share the leaf, not the business rule.** A shared component renders and emits intent; it must not embed a money/data invariant — that lives in `src/lib` or below, and every role's shared component calls the *same* facade. (`FormField` / `EntityCombobox`-style over-abstraction that tries to own business rules is the anti-pattern; see the component-reuse audit in MEMORY.)
- Role folders (`components/{trainer,academy,club,player}`, `pages/{trainer,academy,club}`) are **private**: CI-enforced `no-restricted-imports` bars importing another role's folder (`eslint.config.js:21,92`). Cross-role baseline is **0**.

---

## How role-specific UI (academy / trainer / club) reuses domain logic

The rule that keeps roles from forking: **the business rule lives once, below the UI;
each role is a thin consumer.** Layout and copy differ per role — *business rules do not*
([`DOMAIN_MODEL.md §3`](./DOMAIN_MODEL.md), trainer mirrors academy via shared `src/lib`).

1. **Domain write → shared `src/lib` facade.** Academy's "remove player" and trainer's "remove player" both call `cancelBookingsAndSync`. Neither re-implements the cancel→reconcile rule. To change the rule, edit the facade once.
2. **Reusable UI → neutral folder, role passes props.** `InlineBookPlayer`, `BookForPlayerDialog`, `CycleDetailView` live in neutral folders; the academy/trainer page injects labels, query keys, and the submit handler. Don't copy JSX into a second role — lift it (recipe in [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md#relocating-a-shared-component-to-a-neutral-folder-the-recipe)).
3. **Cross-tenant / money / service-role → edge function**, callable identically by every role. Role never changes the trust rules.
4. **Canonical role = academy.** It's the most-developed, most-tested surface; when converging a trainer/club variant, converge toward academy's behaviour.
5. **Clubs are read-only in the money path** — there must be no club create/edit scheduling UI at all ([`DOMAIN_MODEL.md §4`](./DOMAIN_MODEL.md)).

---

## Decision table — kind of change → where it lives

| You are changing… | It lives in… | Because |
|---|---|---|
| Rendering, layout, loading/empty/error states, which action a button triggers | UI component (`src/pages/**`, `src/components/**`) | Presentation + orchestration only. |
| A UI piece two+ roles need | neutral folder (`components/ui` or `components/<domain>`), role passes props | Share the leaf, not a per-role copy (FRONTEND_ARCHITECTURE). |
| Pricing / split math, a domain read/query, a shared type | `src/lib/**` | Domain logic layer; testable in isolation. |
| **How a booking/slot/cycle/invoice/claim is created/cancelled/edited/deleted** (client-side) | the **named `src/lib` facade** for that write (MUTATION_BOUNDARIES table) | ADR 0003: one canonical entry point bundles the invariant with the write. |
| Caller auth, a price the server must trust, cross-tenant work, a service-role write, a Mollie/Resend call | **edge function** (`supabase/functions/**`) | The trust boundary — must not be forgeable by a client. |
| An atomic multi-row DB operation, a constraint/index, an RLS policy, a trigger | **SQL migration + RPC** | The durable floor; holds even if every layer above is bypassed. |
| A new dangerous mutation of any kind | **extend the existing facade / RPC** in the MUTATION_BOUNDARIES "Allowed boundary" column | Never add a raw `supabase.from(...)` write in a page — the rule is absolute; `mutationBoundary.test.ts` mechanically catches new files and above-ceiling counts only. |
| A rule that must never be forgeable (double-book, dedup, capacity, no-downgrade) | push it **as low as it will go** (constraint > RLS > RPC > edge > lib) | Strongest enforcement is at the bottom. |

---

## Right / wrong — concrete examples

**1. Cancelling a booking**
- ✅ Call `cancelBookingsAndSync(ids)` (`src/lib/bookings.ts:41`) — it soft-cancels and reconciles the invoice in one step.
- ❌ `supabase.from('bookings').update({ status: 'cancelled' }).in('id', ids)` in a page. The invoice still lists the cancelled `booking_id` → **stale billing** (the exact ADR-0003 bug). It also fails `mutationBoundary.test.ts`.

**2. Deleting a slot**
- ✅ `applySlotDeleteToCycle(...)` (`src/lib/slotDeleteGuard.ts:65`) → the RPC locks bookings `FOR UPDATE` and refuses to delete a slot still holding an occupying booking.
- ❌ Client-side "check if booked, then `.delete()` the slot." `bookings.slot_id` is `ON DELETE CASCADE`, and a booking can land between the check and the delete → **cascade-destroys the booking** (TOCTOU). This is why the guard is an atomic RPC, not client logic.

**3. Charging a player**
- ✅ The UI calls an edge fn (`auto-create-invoice` / `create-mollie-payment`) that **computes the price server-side** from the slot (price source of truth, ADR [`0002`](adr/0002-slot-is-price-source-of-truth.md)) and passes `splitAmongPlayers = N` for the per-slot group.
- ❌ The component computes an amount and sends it to the payment fn. A client can forge €0 / underpay, and reading price from the cycle instead of the slot overcharges the deferred fallback. Money math and trust belong in the edge function, not the page.

**4. A UI piece trainer + academy both need (e.g. inline booking)**
- ✅ It lives in a neutral folder (`components/booking/InlineBookPlayer`); each role page is a thin consumer passing role-specific props, and both call the same `src/lib` write facade.
- ❌ Copy `InlineBookPlayer` into `components/trainer` and again into `components/academy`, or import `components/trainer/*` from an academy page. The copies diverge (that produced real money bugs), and the cross-role import **fails the role-isolation lint** (`eslint.config.js:92`). Lift to neutral instead.

---

## See also
- [`MUTATION_BOUNDARIES.md`](./MUTATION_BOUNDARIES.md) — per-write table: allowed boundary, current file:line, server-side enforcement.
- [`DOMAIN_MODEL.md`](./DOMAIN_MODEL.md) — the 14-domain entity map + the load-bearing invariants.
- [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) — role isolation, neutral-folder recipe, layer import rules.
- [`adr/0003-mutation-boundary-facades.md`](./adr/0003-mutation-boundary-facades.md) — the *why* behind one-facade-per-write.
- [`EXTENDING_THE_DOMAIN.md`](./EXTENDING_THE_DOMAIN.md) — the change playbook + PR checklist + test matrix.
