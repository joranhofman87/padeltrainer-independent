# Payment Reliability Foundation — Report

Summary of the payment-reliability foundation work (no staging environment). Everything was built
locally as small, reviewable PRs — **no deploys, no live payments, no real emails, no side-effecting
production calls.** Deploy actions are called out for the owner where relevant.

## What was audited

Every money flow, end-to-end, via an 8-agent read-only code map: public single/whole-cyclus booking,
logged-in single/cycle booking, single/deferred/group rebooking (incl. the new no-login Slice A),
registration/intake, manual invoice `/pay/:token`, all 5 Mollie-webhook branches, Mollie readiness +
multi-academy (F3) routing, guest/linked identity, and invoice email. Result: **[`PAYMENT_FLOW_MAP.md`](PAYMENT_FLOW_MAP.md)**.

## What was changed / added (by PR)

| PR | Phase(s) | Type | Contents |
|---|---|---|---|
| — | — | — | **2026-08-08 status banner:** this is a point-in-time report; several statuses below have moved. G2 ✅ SHIPPED (`_shared/mollie-idempotency.ts`); G5 ✅ decided + shipped (freeze-to-capacity, Option A); G6 re-scoped to service-role `finalize_cycle_proposals` (backlog B-1); #314's webhook audit coverage is PARTIAL (paid-path terminal rows only — see `PAYMENT_INVARIANTS.md` #13). Verify in `PAYMENT_TEST_GAPS.md` before acting on any row. |
| #313 | 1, 2, 7 | docs | `PAYMENT_FLOW_MAP.md`, `PAYMENT_INVARIANTS.md` (15 invariants w/ enforcement + gaps), `EDGE_FUNCTION_DEPLOY_SAFETY.md` (+ money-path PR checklist) |
| #314 | 4 | code + docs | `_shared/payment-audit.ts` (best-effort helper) + **`mollie-webhook` now writes `payment_audit_log`** at every terminal outcome; `PAYMENT_OBSERVABILITY_AUDIT.md` |
| #315 | 3 | code + docs | Extracted + tested `bookingSumTolerance`; `paymentAmountInvariant.test.ts` (#5), `chargeConfirmParity.pglite.test.ts` (#6); `PAYMENT_TEST_GAPS.md` (G1–G10) |
| #316 | 5 | code + docs | `reconcile_payments()` read-only admin RPC + `reconcilePayments.pglite.test.ts`; `PAYMENT_RECONCILIATION_PLAN.md` |
| (this) | 6, 8 | docs | `PAYMENT_RECOVERY_RUNBOOK.md`, `PAYMENT_OPERATOR_TOOL_GAPS.md`, this report |

**Net code change to the money path was deliberately minimal + additive:** durable audit writes
(non-fatal), one pure-refactor tolerance extraction, and one read-only reconciliation RPC. No payment
logic was altered.

## Tests added

- `paymentAmountInvariant.test.ts` — amount-match incl. the multi-booking `bookingSumTolerance` (#5).
- `chargeConfirmParity.pglite.test.ts` — charge-org == confirm-org resolution parity across the F3 cases (#6).
- `reconcilePayments.pglite.test.ts` — the reconciliation RPC flags each seeded mismatch, is read-only, admin-gated.
- `_shared/payment-audit.test.ts` — the audit helper writes the right shape + never throws.

All against real code/Postgres (PGlite) or the real Deno helpers.

## Current risk assessment

**The confirm path — where money becomes real — is sound and well-guarded:** idempotency (atomic-claim
writeback), no-downgrade / no-resurrection, amount-match, and F3 charge-org==confirm-org are enforced and
now tested; abandoned/expired holds self-heal; guest and logged-in paths converge; a paid guest sees their
data after signup. Failures are now **durably audited** and **detectable via reconciliation**, and every
incident has a **recovery procedure**.

### Remaining items (ranked)

| ID | Sev | Item | Status | Where |
|---|---|---|---|---|
| G2 | **P0** | ~~No Mollie `idempotencyKey` on payment creation~~ | **✅ SHIPPED** (`mollieIdempotencyKey`, `_shared/mollie-idempotency.ts` — noted 2026-08-08) | `PAYMENT_TEST_GAPS.md` G2 |
| G6 | **P1** | ~~Logged-in cycle insert has no per-slot capacity lock~~ CORRECTED 2026-08-08: the authenticated path is trigger-locked (`20260715100000`); the uncovered path is service-role `finalize_cycle_proposals` (no lock/recount) | **OPEN (code fix, re-scoped)** | G6 |
| G5 | **P1** | Split-payment divisor race (Codex F4) | **✅ RESOLVED by design** (freeze-to-capacity, Option A — noted 2026-08-08) | G5 |
| G4 | P0-hardening | Charge==confirm **code-path** parity: predicate is correct + tested, but the two functions could diverge in future | Predicate-tested; **structural fix recommended** (extract shared helper) | G4 |
| #13 | P0 | Webhook had no durable audit trail | **FIXED (#314)** — pending `mollie-webhook` redeploy to activate | — |
| G1/#15, G3, G7, G8, G9, G10 | P1/P2 | Concurrency proofs, adversarial cross-tenant suite, e2e webhook, etc. — mechanisms are sound, tests missing | OPEN (coverage) | `PAYMENT_TEST_GAPS.md` |

## Ready to invite more academies (payment-flow standpoint)?

**Not an unqualified "yes" yet — but close, and safe for measured growth.** Per the bar set for this work:

- ✅ Reconciliation + recovery docs exist; durable audit exists; critical amount/idempotency/routing
  invariants are enforced + (mostly) tested.
- ❌ Two genuine code gaps remain that a P0-clean bar requires: **G2 (Mollie idempotency-key — double-charge
  on retry)** and **G6 (cycle capacity lock — concurrent overbook)**. Neither fires in normal single-user
  flow; both need concurrency / a network fault. **G5** needs a product decision.

**Recommendation:** the app is safe to onboard academies **at a measured pace now** — the money path is
well-guarded and any incident is now *detectable* (`reconcile_payments()` + `payment_audit_log`) and
*recoverable* (runbook). Before **aggressive** scaling, land the two P0/P1 code fixes below.

## Recommended next PRs (in order)

1. **G2 — Mollie idempotency-key** on `POST /v2/payments` in `create-mollie-payment` + the guest charge fns (deterministic key per booking+amount). Closes the double-charge-on-retry vector. *P0.*
2. **G6 — capacity-locked cycle insert** — route the logged-in cycle booking through a per-slot advisory-locked RPC (mirror `book_slot_for_payment`). Closes the concurrent overbook. *P1.*
3. **G5 — decide + implement** split-payment cohort semantics (freeze at accept, or re-divide at webhook). *P1 (product first).*
4. **G4 — extract the recipient-resolution predicate** into `_shared/mollie-recipient.ts` used by `resolveSlotRecipient` + `resolveAccessToken` (+ verify), then a golden parity test. *P0 hardening.*
5. **Operator tooling** — `PAYMENT_OPERATOR_TOOL_GAPS.md` #1/#2 (reconciliation dashboard + daily cron/Slack) so we catch incidents, not customers.
6. **Deploy the merged foundation** — redeploy `mollie-webhook` (audit + `bookingSumTolerance`) and apply migration `20260705140000` (see each PR's "Owner deploy" note + `EDGE_FUNCTION_DEPLOY_SAFETY.md`).

## Owner deploy checklist for this foundation

- Apply migration **`20260705140000`** (`reconcile_payments` — read-only RPC).
- Redeploy **`mollie-webhook`** (Phase 4 audit writes + Phase 3 `bookingSumTolerance` import — behaviour identical).
- Everything else is docs/tests — no deploy.
- Nothing here requires a live payment, email, or side-effecting call to verify (use `functions list` +
  logs + `reconcile_payments()`).
