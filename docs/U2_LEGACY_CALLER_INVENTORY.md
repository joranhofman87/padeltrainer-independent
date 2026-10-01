# U2 — remaining legacy-caller inventory and contraction eligibility

**Status: EVIDENCE, not authorization.** This inventory exists so the later contraction release
(physically dropping `guest_players`, `guest_player_id` columns and legacy `player_id` semantics)
can be judged against a measured baseline instead of an impression. Nothing in this document
approves contraction; that is a separate owner-gated release, entered only when the counts that
must be zero are zero.

Snapshot taken on branch `feat/u2-identity-writer-convergence` (the canonical-Player correction),
2026-08-10. Regenerate with the commands under each section — the numbers rot, the commands do not.

## What this branch closed (the reason the counts are what they are)

* The durable create receipt (`player_create_commands`) carries **no** `guest_player_id`.
* `player_create_command` / `player_create_execute` / `create-manual-player` answer with
  **canonical `person_id` only**.
* The five remaining browser flows that consumed a guest id from the create contract now operate
  from `person_id` through task-specific server commands:
  `invoice_create_for_person`, `intake_request_create_for_person`, `person_display_for_owner`,
  `person_mark_has_trained` (plus the canonical-only checkout resolver in
  `_shared/guest-players.ts`).
* The translation primitives are closed to clients: `person_legacy_source` is granted to
  **nobody**; `player_legacy_ref` is **service_role-only** and additionally refuses non-service
  callers in-function. Mutation-verified (re-grant → suite fails; scope-filter removal → suite
  fails; person-scope gate removal → suite fails).
* `submit-guest-intake` no longer echoes the inserted intake row (which carried
  `guest_player_id`, `player_id` and client-IP metadata) to the anonymous caller.

## The categories

| Category | Meaning | Contraction requirement |
| --- | --- | --- |
| C1 — create/identity contract | Flows that CREATE Players or translate identity | **Zero legacy. DONE in this branch.** |
| C2 — service-internal derivation | Service-key edge code deriving a legacy ref only to write an unmigrated relation | Ends when the relation's column is migrated; each site is a wrapper call, not a decision |
| C3 — legacy read/write surfaces | UI + RPCs that still key rosters, bookings, invoices, claims on `guest_player_id` | Must reach zero (migrated to person keys) before any physical drop |
| C4 — plumbing that keeps both worlds consistent | `stamp_person_id_*`, mint/merge/claim, `person_links` maintenance | Removed BY the contraction itself, last |

## Counts (executable references, tests and generated types excluded)

### Client (`src/**`, excluding `*.test.*` and `integrations/supabase/types.ts`)

**79 files** carry an executable `guest_player_id` / `guestPlayerId` reference.

```bash
grep -rlE "[\"']guest_player_id[\"']|\.guest_player_id\b|guest_player_id\s*:|\.guestPlayerId\b|guestPlayerId\s*:" src --include="*.ts" --include="*.tsx" | grep -v "\.test\.\|/test/\|types.ts" | wc -l
```

All 79 are **C3** (list/roster/booking/invoice/claim surfaces reading or writing rows that
physically carry the column — e.g. `playersOverview.ts`, `BookForPlayerDialog.tsx`,
`CycleDetailView.tsx`, `MergePlayersDialog.tsx`), except the picker-link plumbing that carries the
overview's own keys alongside the new `personId` (`invoiceCustomer.ts`,
`invoiceSelectablePlayers.ts`, `InvoiceCustomerSection.tsx`) — same category, same fate.
**Zero of them obtain a guest id from a create/identity contract** (C1) — that is what the
`u2NoEmailAloneMerge` guard and the behavioural suites now pin.

### Edge functions (`supabase/functions/**`, excluding `*.test.*`)

**38 files** reference the legacy id.

* **C2 (5):** `_shared/guest-players.ts` (checkout derivation via `player_legacy_ref`),
  `create-guest-{slot,cart,cyclus}-payment` (consume that derivation into `bookings`),
  `submit-guest-intake` (derivation into `intake_requests`). The derived id dies inside the
  process; the Deno suites assert the HTTP contracts are canonical-only.
* **C3 (33):** invoice/rebook/webhook/notification machinery reading or writing legacy-keyed rows
  (`mollie-webhook`, `generate-invoice`, `bulk-rebook-cycle`, …).

```bash
grep -rlE "[\"']guest_player_id[\"']|\.guest_player_id\b|guest_player_id\s*:|guestPlayerId" supabase/functions --include="*.ts" | grep -v "\.test\." | wc -l
```

### Database functions (`public.*` whose source mentions `guest_player`)

**98 functions.**

* **C1/boundary (8, all closed):** `person_legacy_source`, `player_legacy_ref`,
  `player_create_command`, `player_create_execute`, `invoice_create_for_person`,
  `intake_request_create_for_person`, `person_display_for_owner`, `person_mark_has_trained` —
  these MENTION the column because they own the internal derivation; none exposes it to a client.
* **C4 (≈15):** `mint_person_for_guest`, `merge_guest_players`, `person_claim_confirm`,
  `stamp_person_id_*`, `rederive_person`, `link_guest_data_to_profile`, … — the consistency
  machinery between the two worlds.
* **C3 (≈75):** readers and writers keyed on the column (`get_players_overview`,
  `get_academy_invoices`, `rebook_group_apply`, `respond_to_priority_claim`, …).

```sql
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc ILIKE '%guest_player%';
```

### Generated types

`src/integrations/supabase/types.ts` mirrors the catalog and therefore names the column and the
closed primitives. The generator includes **all** functions regardless of grants
(memory: supabase-types-generation); presence there is not client reachability.

## Contraction eligibility

**NOT ELIGIBLE.** The C1 contract count is zero (this branch's work), which is the *entry*
condition for beginning surface migration — not the exit condition for dropping anything. The exit
condition is C3 = 0 on all three surfaces (79 client files, 33 edge files, ≈75 DB functions today)
plus a data-parity preflight over production, at which point C2 evaporates (nothing left to derive
for) and C4 is dismantled by the contraction migration itself.

Progress on C3 is measured by re-running the three commands above; each surface conversion PR
should quote its before/after counts here.
