# Invariant enforcement backlog

Purpose: rank the invariants from [`../INVARIANTS.md`](../INVARIANTS.md) that are **not yet enforced at the
DB/server layer** — only in app code, or not at all — with the recommended durable enforcement for each.

Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Scope rule: each item is an **enforcement gap** for an app-wide invariant, not a general bug. Fixes that
touch the DB (new constraint / trigger / RLS / RPC) are **broad, high-blast-radius changes** — do each in its
own focused, tested PR with a migration + deploy note (migrations do not auto-deploy). Do **not** bundle a DB
constraint change into an unrelated feature PR.

Priority: **P0** = cross-tenant / double-charge / money-loss reachable today · **P1** = stuck money/capacity
or data loss under realistic conditions · **P2** = observability / hardening / defense-in-depth. Sourced from
[`../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) and
[`../audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md`](../audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md).

Already fixed (do NOT re-open): P0 forged service-role JWT, P1-2 `swap_slots` guard, P1-3 `merge_guest_players`
cascade repoint, P1-4 webhook 23505 tolerance, P1-5/P2-7 extras charge==invoice, P1-6 `create_invoice_deduped`,
P1-7 `invoiceSync` paging (`src/lib/supabasePaging.ts`), P1-9 Mollie charge==confirm routing.

| ID | Inv | Sev | Gap (where it lives now) | Recommended durable enforcement |
|----|-----|-----|--------------------------|---------------------------------|
| B-1 | I-2 | P1 | Logged-in **cyclus** insert not capacity-locked (single-slot IS) | Route the cyclus insert through a capacity-locked SECURITY DEFINER RPC (advisory lock + `FOR UPDATE`), mirroring `book_slot_for_payment` |
| B-2 | I-5 | P1 | No guard forbids **deleting/overwriting a paid invoice**; financial-cols trigger exempts service role | Add a `deleteInvoice`/`cancelInvoice` `src/lib/` facade with a "can't delete paid" guard **and** a DB trigger blocking DELETE/financial-overwrite of `status='paid'` invoices that fires even for service role; add `.neq('status','paid')` status guard to `recalculate-invoices` (P2-6) |
| B-3 | I-7 | P1 | **Refund / chargeback** webhooks silently ignored → reversed payment stays paid, no alert | In `mollie-webhook`, handle `status='charged_back'` and non-zero `amountRefunded`/`amountChargedBack`: don't resurrect state, write `payment_audit_log` + fire Slack alert for manual reconciliation (P2-5) |
| B-4 | I-1 | P2 | Anon/PII **RLS read leaks**: cycles `settings.notify_admin_emails` (P2-1), shared-trainer `guest_players` roster (P2-2), `get_player_locations` trusts client `guest_player_id` (P3-3), `registrations` repeats the leak (P3-2) | Serve public forms via a postgres-owned `_public`/`_safe` view whitelisting form-safe columns; scope academy-manager guest visibility to guests actually associated with that academy; derive `guest_player_id` server-side |
| B-5 | I-1 | P2 | `rebook_group_manage` appends to a **client-supplied `_invoice_id`** with no ownership scope (P2-3) | Add `AND rebook_group_id = v_group` (or captain-identity match) to the step-4 `UPDATE invoices` |
| B-6 | I-13 | P0-if-broken | **No `deno check`/type-check** on the 96 edge-function `index.ts` (incl. `mollie-webhook`) (P2-9) | Add a CI job running `deno check` (not `--no-check`) over `supabase/functions/**/index.ts` with the import map, ratcheted vs a baseline like the tsc gate |
| B-7 | I-13 | P2 | No CI lint catches an edge-fn referencing a **new column/RPC without its migration** in the same PR | Add a CI check that greps changed edge fns for column/RPC names introduced by an unapplied-vs-main migration; keep the money-path deploy checklist mandatory |
| B-8 | I-11 | P2 | `get-public-invoice` **soft-hides** a revoked token instead of hard-rejecting; no negative token test | Make `get-public-invoice` hard-reject a revoked/paid/cancelled token read; add a "token X cannot read invoice Y" test |
| B-9 | I-8 | P2 | Deduped-invoice paid-match **tolerance scales with booking count**, no absolute cap (P3-5) | Cap the tolerance (e.g. `min(N*0.01, 0.05)`); document the magic number |
| B-10 | I-1 | P2 | No **adversarial cross-tenant test suite** (token holder charging another claimant, forged `guest_player_id`, trainer booking a foreign-academy slot) | Add one PGlite test file with several cross-tenant attack cases; assert identity is always server-derived |
| B-11 | I-2/I-3 | P2 | Fresh single-slot booking **orphans a capacity-occupying pending row** when Mollie creation fails before a payment id exists (P2-10) | Soft-cancel the just-inserted booking in the missing-profile/Mollie-error branches, OR insert as a TTL `payment_pending` hold so the sweep reclaims it |

## Notes for the implementer

- **B-1** and **B-11** are the two capacity items — B-1 is a concurrency race (needs a new locked RPC), B-11 is
  a partial-failure rollback in an existing edge fn (smaller). Do B-11 first (contained), B-1 as a focused RPC PR.
- **B-2** and **B-3** are the two money-durability items; B-3 (reversal handling) also depends on
  `payment_audit_log` being written from the webhook (see PAYMENT_INVARIANTS #13). Sequence B-3 after that.
- **B-4/B-5** are RLS/RPC tenancy fixes — each is a migration touching a policy or SECURITY DEFINER function;
  **confirm the product intent** for B-4's shared-trainer guest sharing before narrowing (audit flagged it as
  possibly intended).
- **B-6** is the single highest-leverage CI hardening item — it protects every future edit to the money-path
  edge functions and is a pure workflow change (no runtime risk).
- None of these block the current measured-growth posture on their own, but B-1, B-2, B-3, B-6 are the ones to
  land before onboarding materially more paying tenants or larger cycles.
