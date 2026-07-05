# Architecture Decision Records

Purpose: an index of the **why** behind the load-bearing structural decisions in the scheduling/money domain, so a future AI agent or human can tell whether a constraint is essential or incidental before changing it.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

For the *what* (the entity map + the rules), see [`../DOMAIN_MODEL.md`](../DOMAIN_MODEL.md); for the
*how* (the change playbook + checklist), see [`../EXTENDING_THE_DOMAIN.md`](../EXTENDING_THE_DOMAIN.md).

## Format & process

Each ADR is **Status · Context · Decision · Alternatives considered · Consequences**. New ADRs get the
next sequential number. **Supersede** rather than rewrite a decision: leave the old ADR in place, set its
Status to `Superseded by NNNN`, and record the new one. An ADR captures a decision that is *made and
stable* — do not open one for a still-open product question.

## Existing ADRs

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-registrations-cycles-split.md) | Split the overloaded `cycles` table into `registrations` (form) + `cycles` (training), paired 1:1 via `source_cycle_id` | Accepted (read + write shipped) |
| [0002](./0002-slot-is-price-source-of-truth.md) | `availability_slots` (`price_per_session` + `split_payment`) is the single source of truth for what a booking costs — never a cycle-level scalar | Accepted |
| [0003](./0003-mutation-boundary-facades.md) | Every domain write goes through one canonical lib facade or `SECURITY DEFINER` RPC, never a raw page-level `.insert/.update/.delete` | Accepted (enforced by convention + role-isolation lint) |
| [0004](./0004-rebooking-priority-claims.md) | Rebooking via priority-claim invites + a group captain who books the whole group & pays once | Accepted (shipped incrementally) |
| [0006](./0006-invoice-public-token-payment-links.md) | An invoice is payable by an unauthenticated party via a public `/pay/:token` URL reusing the Mollie pay → webhook → PDF stack | Accepted |
| [0007](./0007-edge-functions-as-backend-boundary.md) | All privileged / cross-tenant / money server work lives in `supabase/functions/*` (verify_jwt=false, self-authenticating) or `SECURITY DEFINER` RPCs; the SPA never holds a service-role key | Accepted |

## Planned / needed ADRs

Decisions that are **already made and stable in the codebase/docs** but lack a formal ADR. Each line is
the decision in one sentence — enough for a future author to write the full record. Do **not** invent new
decisions here; these only formalize what is already visible.

| # | Working title | Decision (one line) |
|---|---|---|
| 0005 | Public-booking payment holds | The public booking widget holds a slot while the payer completes Mollie checkout (hold-while-paying), so unpaid intent never permanently blocks capacity — see [`../PUBLIC_BOOKING_WIDGET_PLAN.md`](../PUBLIC_BOOKING_WIDGET_PLAN.md). *(Widget not yet built — write the ADR when it ships.)* |
| 0008 | Component pattern registry | Shared UI is standardized against a single registry (share the presentational leaf, not the business rule) — see [`../COMPONENT_PATTERN_REGISTRY.md`](../COMPONENT_PATTERN_REGISTRY.md) and [`../UI_COMPONENT_STANDARDS.md`](../UI_COMPONENT_STANDARDS.md); `FormField`/`EntityCombobox`-style over-abstraction is explicitly rejected. *(The registry doc is the source of truth today; promote to an ADR only if contested.)* |
| 0009 | AI-ready architecture rules | The canonical docs (DOMAIN_MODEL, EXTENDING_THE_DOMAIN, MUTATION_BOUNDARIES, INVARIANTS, ADRs) plus the ratcheted CI gates (typecheck baseline, PGlite rehearsals, edge-config drift, i18n parity) are the contract a future AI agent must read and satisfy before changing money/scheduling code — see [`../AI_DEVELOPMENT_GUIDE.md`](../AI_DEVELOPMENT_GUIDE.md). |
