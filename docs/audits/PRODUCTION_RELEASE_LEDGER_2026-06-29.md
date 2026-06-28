# Production Release Ledger — padeltrainer

_Generated 2026-06-29 against `main` HEAD `76307127`. This is a **read-only repo audit** — no production database was queried. "Likely live / likely not-live" is **inferred** from migration filename dates, deploy-checklist coverage, and graceful-fallback code paths. The owner must run the Section 3 probes against prod (`ficwbdrzefmblkbkomzw`) to turn inference into fact._

> **Repo-verification note (this revision).** Every fallback code-site named in §2 was confirmed to exist in the current tree (`isMissingCyclusGroupsRpc`/`buildGroupsClientSide` in `AcademyCyclusOverview.tsx`, `countCyclesIntakesWithFallback` in `lib/cycles.ts:357`, `mintRebookInvoiceFallback` in `lib/priorityClaims.ts:705`, `isMissingRegistrationRpc` in `CycleForm.tsx:645`, the `get_trainer_earnings_summary` RPC + fallback in **`src/pages/TrainerEarnings.tsx`**). RPC argument signatures in §3 were read from the migration `GRANT`/`CREATE` lines — **not** guessed (the synthesis draft had mis-typed `update_cycle_pricing`'s `extra_costs` arg as `numeric`; it is `jsonb`). The §3 probes therefore use a **name-based `pg_proc` query** that needs no hand-built signatures and survives overloads.

## 1. Deploy-confidence picture

This app deploys in three independent channels: the **React frontend auto-deploys via Vercel on merge to `main`** (so all `src/` changes through PR #214 are already live), but **DB migrations and Supabase edge functions are applied MANUALLY by the owner** — CI (`migrations.yml`) only runs `supabase db reset` locally to validate SQL; it does **not** prove prod is in sync.

The authoritative `audit/DEPLOY_CHECKLIST.md` asserts "all migrations LIVE except the 6 AI-gateway functions," but that reconciliation was recorded **2026-06-28 ~13:05** and is **stale**: it names by filename only Phase 4 C+E, the capacity migrations, and a handful of others. **Nine committed money/scale migrations (`20260629120000` → `20260702150000`) are not named anywhere in it**, each ships marked INERT/owner-deployed, and **each is masked by a deliberate client-side graceful fallback** (`PGRST202`/`42883` → legacy path). So a missing migration is **invisible** — the app stays *correct* but silently runs the expensive unbounded scan the migration was meant to replace. There is currently **no production signal when a fallback path fires**, so the app cannot self-report deploy drift.

**Confirmed-uncertain set:** the nine wave migrations below + the three #197 edge functions (`finalize-proposals`, `submit-guest-intake`, `sync-invoice-to-bookings`) + `create-rebook-invoice` / `bulk-rebook-cycle` version currency. **Highest-confidence not-live:** `get_trainer_earnings_summary` (`20260702150000`, committed 2026-06-28 23:15 — *after* the checklist's final edit).

## 2. Risk-ranked table — items that may not be live in prod

| Item | Type | Risk if absent | Masked by a fallback? (gap is INVISIBLE) | Degraded behavior today |
|---|---|---|---|---|
| `create-rebook-invoice` edge fn | Edge fn | **Money** | Yes — `mintRebookInvoiceFallback` (`priorityClaims.ts:705`) → `mode:'upfront_unavailable'` | Accepted rebook player keeps their spot but gets **no payable invoice / pay link** — dead-ends on payment; accept is not rolled back. |
| `finalize_cycle_proposals` (`20260701120000`) | RPC, SECDEF, service_role-only | **Money/Correctness** | **No** — `finalize-proposals` edge fn calls it; errors loudly if absent | Atomic claim+booking+invoice txn. Without it the "booked intake, no booking, no invoice" silent-drop bug returns. Hard-fails the edge fn if unapplied. |
| `finalize-proposals` edge fn (#197) | Edge fn | **Money (observability)** | Yes — additive Slack alerts; absence is silent | Money-path failures stay invisible until the next-morning health check instead of real-time. Last deploy predates #197. |
| `sync-invoice-to-bookings` edge fn (#197) | Edge fn | **Money (observability)** | Yes — additive Slack alerts | invoice-paid→bookings-stale divergence only caught by the daily health check. **Absent from the 06-28 functions snapshot** — existence unconfirmed. |
| `submit-guest-intake` edge fn (#197) | Edge fn | **Money (observability)** | Yes — additive Slack alerts | Silent invoice-mint / confirmation-email failures stay unalerted. Last deploy predates #197. |
| `bulk-rebook-cycle` edge fn (rich review fields) | Edge fn | **Correctness** | Yes — feature-detect `detailed=false` (`RebookReviewTable.tsx:50`) | Rebook wizard step-2 drops per-player roster, **missing-email warnings**, projected invoice total. Owner could send invites without seeing the no-email warning. |
| `create_registration_with_cycle` / `update_registration_with_cycle` (`20260630130000`) | RPC, SECDEF | **Correctness** | Partial — only `CycleForm.tsx:645` (`isMissingRegistrationRpc`); lib callers `throw` | New/edited registration forms fall back to legacy `createCycle`/`updateCycle` (no `registrations` overlay row) until the migration lands and they're re-saved. |
| `get_academy_cyclus_groups` (`20260630140000`) | RPC, SECDEF | **Scale** | Yes — `AcademyCyclusOverview.tsx:119` → `buildGroupsClientSide` | Streams the academy's **entire** slot/booking/intake/trainer/profile set to the browser and groups in JS. OOMs at ~10+ academies. |
| `get_trainer_earnings_summary` (`20260702150000`, #213) | RPC, SECDEF | **Scale** | Yes — `TrainerEarnings.tsx` (`PGRST202`/`42883` → legacy full load) | **Highest-confidence not-live** (latest file in tree). Loads the trainer's full lifetime booking history + JS aggregation. Numbers identical; the scale fix is inert. |
| `count_cycles_intakes` + `idx_bookings_slot_status` + `idx_availability_slots_cyclus_trainer` (`20260629120000`) | RPC (INVOKER) + 2 indexes | **Scale** | Yes — `countCyclesIntakesWithFallback` (`cycles.ts:357`) | Unbounded `SELECT cycle_id FROM intake_requests WHERE cycle_id IN (...)` counted in JS. Drives intake-count badges. Identical numbers; cost is the unbounded read. |
| `apply_slot_delete_to_cycle` (`20260629130000`) | RPC, INVOKER | **Correctness** | **No** — `slotDeleteGuard.ts` throws on error | Whole-cycle slot delete hard-errors. INERT until its consuming slice; loud-on-click, so surfaces fast if absent. |
| `apply_slot_edit_to_cycle` (`20260629140000`) | RPC, INVOKER | **Correctness** | **No** — `cycles.ts` hard-throws | Whole-cycle non-price slot edit hard-errors on click. |
| `update_cycle_pricing` relock (`20260629150000`) | RPC, INVOKER | **Money/Correctness** | **No** — but a prior body (`20260614120000`, identical signature) almost certainly **is** live | Repricing still works on the old body; only the **deadlock-safety** win (id-ordered slot lock vs `apply_slot_edit/delete`) is absent. Won't hard-fail. |
| `availability_slots.cyclus_id` FK (`20260630120000`) — **STEP 2 only** | FK NOT VALID→SET NULL | **Correctness (integrity)** | N/A | STEP 1 marked **LIVE 2026-06-28**. Only the deferred STEP 2 (orphan backfill + `VALIDATE CONSTRAINT`) is pending — existing orphans unrepaired. |
| `idx_invoices_booking_ids_gin` (`20260630120100`) | GIN index | **Scale** | N/A | Marked **LIVE 2026-06-28** + in the PHASE4_CE runbook. Re-verify only. |
| `get_academy_invoice_summary_filtered` (`20260622120000`) | RPC | **Cosmetic** | Yes — react-query `isError` (`AcademyInvoices.tsx:147`) | Scoreboard cards fall back to tab-total summary; never blank. June-dated, likely live. |
| `get_academy_invoice_cancelled_count` (`20260622130000`) | RPC | **Cosmetic** | Yes — react-query `isError` | "Geannuleerd" tab count blank. Label-only. June-dated, likely live. |
| guest_players shared-email index drop (`20260611220000`) | Index drop | **Cosmetic** | Yes — `23505` catch (`AddPlayerForm.tsx:218`) | Shared-email insert rejected with a "duplicate email" toast. Lowest risk. |
| 6 AI-gateway edge fns | Edge fns | **N/A (deferred)** | Yes — `isAiGatewayConfigured()` skips | Intentionally owner-deferred (need `AI_GATEWAY_*` secrets). Not a gap. |

**Reasoning rule:** an item **with a fallback** is _silent_ if missing → must be probed. An item **without a fallback** (hard `throw`) would already be throwing "failed" toasts in prod if missing → likely already deployed (or just unexercised). The fallback-masked rows are the real risk.

## 3. How to confirm each item is live (read-only probes)

### PRIMARY PROBE — which RPCs exist in prod, by name (no signature guessing)
```sql
select proname,
       pg_get_function_identity_arguments(oid) as live_args,
       prosecdef as security_definer
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in (
    'get_trainer_earnings_summary','get_academy_cyclus_groups','count_cycles_intakes',
    'create_registration_with_cycle','update_registration_with_cycle','finalize_cycle_proposals',
    'apply_slot_delete_to_cycle','apply_slot_edit_to_cycle','update_cycle_pricing',
    'get_academy_invoice_summary_filtered','get_academy_invoice_cancelled_count')
order by proname;
-- Any name MISSING from the result = that migration is NOT live in prod.
```
Expected live signatures (from the migration `GRANT`/`CREATE` lines — for cross-checking the `live_args` column):
- `get_trainer_earnings_summary(timestamptz, timestamptz, timestamptz, timestamptz)` — SECDEF
- `get_academy_cyclus_groups(uuid)` — SECDEF
- `count_cycles_intakes(uuid[])` — INVOKER
- `create_registration_with_cycle(text, uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text, boolean)` — SECDEF
- `update_registration_with_cycle(uuid, text, text, text, date, date, timestamptz, text, numeric, text, jsonb, uuid, jsonb, text, boolean)` — SECDEF
- `finalize_cycle_proposals(uuid)` — SECDEF, **service_role only**
- `apply_slot_delete_to_cycle(uuid, uuid[])` · `apply_slot_edit_to_cycle(uuid, uuid[], jsonb)` — INVOKER
- `update_cycle_pricing(uuid, numeric, jsonb, boolean, boolean)` — INVOKER ⚠️ **two definitions** exist (`20260614120000` + `20260629150000`); `pg_proc` shows only one row (same sig). To tell whether the **relock** body is live, rely on `db push --dry-run` below — a name probe can't distinguish bodies.

### Indexes / FK / money-guard trigger
```sql
select indexname from pg_indexes where schemaname='public'
  and indexname in ('idx_bookings_slot_status','idx_availability_slots_cyclus_trainer','idx_invoices_booking_ids_gin');

select conname, convalidated from pg_constraint where conname='availability_slots_cyclus_id_fkey';
-- convalidated=false is EXPECTED until FK STEP 2 is run; presence of the row confirms STEP 1 is live.

-- Bonus: confirm the player-payment money guard is live (no fallback; silent if dropped)
select tgname from pg_trigger where tgname='trg_protect_booking_financial_columns_for_players';
```

### Authoritative reconciliation (the real source of truth — supersedes all inference above)
```bash
supabase migration list --linked
supabase db push --dry-run --linked     # ANY wave migration listed here = NOT live (also distinguishes update_cycle_pricing bodies)
supabase functions list --linked        # version/updated_at for the 5 edge fns below
```
For the edge functions, confirm `updated_at` is **after 2026-06-28 17:38** (the #197 merge) for `finalize-proposals` / `submit-guest-intake` / `sync-invoice-to-bookings`; confirm `create-rebook-invoice` exists at all (money path); confirm `bulk-rebook-cycle` returns the rich `roster[]`/`invoiceTotal` review fields.

## 4. Owner deploy checklist (dependency order)

Deduped against existing docs (`audit/DEPLOY_CHECKLIST.md` already marks FK STEP-1 + GIN + capacity migrations + `book_slot_for_payment_notes` **LIVE 2026-06-28** — not re-listed), `docs/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`, `docs/PHASE2_STEP3_CUTOVER.sql`, `docs/PHASE5_DEPLOYMENT.md`, `MIGRATION_STABILIZATION.md`.

**Step 0 — Reconcile (do first, single source of truth)**
- [ ] `supabase db push --dry-run --linked` against `ficwbdrzefmblkbkomzw` — capture the pending list
- [ ] `supabase functions list --linked` — capture versions/timestamps for the 5 edge fns in §3
- [ ] Run the §3 PRIMARY PROBE to confirm the name-by-name RPC presence

**Step 1 — Apply pending migrations (any flagged by Step 0), oldest→newest**
- [ ] `20260629120000_phase4_f2a_read_indexes.sql` (`count_cycles_intakes` + 2 indexes)
- [ ] `20260629130000_phase4_f2_apply_slot_delete.sql`
- [ ] `20260629140000_phase4_f2_apply_slot_edit.sql`
- [ ] `20260629150000_phase4_f2_cycle_pricing_relock.sql` (deadlock-safety body replacement)
- [ ] `20260630130000_registration_write_rpcs.sql`
- [ ] `20260630140000_get_academy_cyclus_groups.sql`
- [ ] `20260701120000_finalize_cycle_proposals_rpc.sql` — **must be live BEFORE redeploying the `finalize-proposals` edge fn** (its consumer)
- [ ] `20260702150000_get_trainer_earnings_summary.sql` — **highest-confidence not-live**
- [ ] Regenerate `src/integrations/supabase/types.ts` if any RPC/FK change drifts the types gate

**Step 2 — Redeploy edge functions (after their migration dependency is live)**
- [ ] `finalize-proposals` (#197 Slack alerts; **depends on** `finalize_cycle_proposals`)
- [ ] `submit-guest-intake` (#197 Slack alerts)
- [ ] `sync-invoice-to-bookings` (#197 Slack alerts; **verify it exists at all**)
- [ ] `create-rebook-invoice` — confirm deployed (money path; fallback dead-ends payment if absent)
- [ ] `bulk-rebook-cycle` — confirm it returns the rich `roster[]`/`invoiceTotal` review fields

**Step 3 — Deferred owner-run one-time SQL (NOT tracked migrations — will not auto-apply)**
- [ ] Phase 4 C **STEP 2**: pre-flight orphan count → if >0 run `20260612230000_rebook01_backfill_calendar_cycles.sql` → `ALTER TABLE public.availability_slots VALIDATE CONSTRAINT availability_slots_cyclus_id_fkey`
- [ ] Phase 2 Step 3 registration↔cycle CUTOVER (`docs/PHASE2_STEP3_CUTOVER.sql`) — **hard pre-req**: the dual-read FE + `submit-guest-intake` + `create-registration-invoice` must already be deployed, else flipped cycles fall to legacy AND paid registrations silently stop charging

**Out of scope / already documented (do NOT action now):** the 6 AI-gateway edge fns + `LOVABLE_API_KEY` deletion; Phase 5 production cutover blockers (Cloudflare DNS→Vercel, Resend DNS, Google OAuth verification, Lovable deletion).

## 5. Gaps — what code alone cannot determine

- **Actual prod migration state.** No prod query was run; only `supabase migration list --linked` / `db push --dry-run --linked` against `ficwbdrzefmblkbkomzw` can confirm which of the nine future-dated wave migrations are applied. Filename timestamps are future-dated and are not proof of deployment.
- **Edge-fn deployed versions.** The 2026-06-28 functions snapshot is stale and omits `sync-invoice-to-bookings`. Only `supabase functions list --linked` reveals the live versions of the #197 trio + `create-rebook-invoice` + `bulk-rebook-cycle`.
- **`update_cycle_pricing` body ambiguity.** A prior body (`20260614120000`, identical signature) is almost certainly live, so the repricing path won't hard-fail even if the relock (`20260629150000`) is unapplied; only `db push --dry-run` (or a live `pg_get_functiondef` diff) distinguishes "old body" from "relock body."
- **FK STEP-2 runtime state.** `pg_constraint.convalidated` and the historical orphan count are runtime facts.
- **No fallback-execution telemetry.** There is no prod signal when a `PGRST202`/`42883` fallback fires, so even when live the app can't self-report deploy drift. **Adding fallback-hit alerting is the standing next P1** (it converts this whole ledger from a manual audit into a self-reporting signal).
