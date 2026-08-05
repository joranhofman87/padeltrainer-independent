# Foundation Roadmap — what to fix before scaling

Purpose: the single clean, forward-looking priority list of foundation work — grouped by when it must land — so an AI agent or human can pick the next-highest-leverage item without re-reading every audit.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

## How to use this

- This is the **roadmap** (what/when/why). Each item links to the **detailed backlog** that owns the fix mechanics; do not duplicate that detail here. Backlogs live under [`technical-debt/`](technical-debt/); the grounding audit is [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) (its remediation Slices G–K map 1:1 onto the Tier-1 items below).
- **Before touching money/scheduling code, read the contract:** [`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) → [`MUTATION_BOUNDARIES.md`](MUTATION_BOUNDARIES.md) → [`INVARIANTS.md`](INVARIANTS.md) → the relevant [`adr/`](adr/README.md) (ADR 0009 makes this the contract). Never fix-as-you-go in a boundary move (ADR 0003): characterize behavior in a PGlite test, extract verbatim, then wire.
- **Deploy reality:** edge functions + migrations do **not** auto-deploy — the owner applies them manually after merge; CI only validates. "Merged" ≠ "live." Frontend auto-deploys via Vercel.
- **Every fix ships with its test.** Money/data-integrity items require a PGlite (`*.pglite.test.ts`) or `db:rehearse:*` proof, not a mock, per [`TESTING_STRATEGY.md`](TESTING_STRATEGY.md).

## Already fixed + deployed (do NOT re-open)

The 2026-07-02 fresh-eyes audit's P0 and 7 of its P1s are **fixed and live in prod**: forged service-role-JWT bypass (P0), `swap_slots` ownership guard (P1-2), `merge_guest_players` cascade repoint (P1-3), M-17 webhook 23505 tolerance (P1-4), extras charge==invoice (P1-5/P2-7), `create_invoice_deduped` dedup RPC (P1-6), `invoiceSync` paging via new [`src/lib/supabasePaging.ts`](../src/lib/supabasePaging.ts) (P1-7), academy-Mollie charge==confirm routing (P1-9). Do not describe these as open. **Parked/disputed:** P1-1 (Google-Calendar OAuth `state` CSRF, parked), P1-8 (Stripe basil `invoice.subscription`, DISPUTED — endpoint API-version dependent, not source-observable).

---

## Tier 1 — Critical before inviting many academies

Silent money loss/corruption or a CI gap that lets money-path bugs ship green. These are the remaining P2 cluster from the fresh-eyes audit plus the two highest-leverage foundation gaps. Land these before onboarding materially more paying tenants or larger cycles.

### T1-1 · Record refund / chargeback reversals (currently silent money loss)
- **Problem:** `mollie-webhook` has no `charged_back` / `refunded` / `amountRefunded` case; the no-downgrade guard silences the reversal → a reversed payment stays paid/confirmed forever, seat stays occupied, **no `payment_audit_log` row, no alert**. A full refund is even logged as `duplicate_webhook_ignored`. (Audit P2-5, Slice H.)
- **Impact:** Money is gone with no durable record — the observability layer's core promise broken. Highest-severity open item.
- **Fix:** explicit `charged_back` / non-zero `amountRefunded`/`amountChargedBack` handling that does **not** resurrect state, writes `payment_audit_log`, fires `notifySlackEdge`; add a `reconcile_payments` check for reversed-but-still-paid.
- **Owner area:** payments / observability · **Risk:** high (money path) · **PR size:** Medium · **Tests:** PGlite webhook test asserting reversal → audit row + no state resurrection.
- **Detail:** [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md) OBS-P0-2 + [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-3.

### T1-2 · `recalculate-invoices` status guard (paid-invoice overwrite race)
- **Problem:** `recalculate-invoices/index.ts:276` UPDATEs with no `status` guard; if the Mollie webhook flips an invoice to `paid` mid-loop, recalc overwrites the paid total/VAT and wipes `pdf_url`. (Audit P2-6, Slice G.)
- **Impact:** A customer's paid invoice silently shows a different amount than was charged.
- **Fix:** `.neq('status','paid')` (or `updated_at` optimistic guard) on the recalc UPDATE; pairs with the paid-invoice-DELETE guard.
- **Owner area:** invoices · **Risk:** high (money) · **PR size:** Small · **Tests:** PGlite: recalc skips a row that flipped to paid mid-batch.
- **Detail:** [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-2 (bundle with the "can't overwrite/delete paid invoice" trigger + facade).

### T1-3 · Invoice concurrency / mid-flight overwrite races (Slice G rest)
- **Problem:** `auto-create-invoice` TOCTOU overlap-dedup can double-bill on concurrent overlapping booking sets (audit P1-6 core is fixed via `create_invoice_deduped`; the remaining re-pay probe race P2-4 leaves two payable checkouts) and the deduped-invoice paid-match tolerance scales unbounded with booking count (P3-5).
- **Impact:** Double-charge / two open checkouts on retry.
- **Fix:** cancel-before-mint on the re-pay probe path; cap the dedup tolerance (`min(N*0.01, 0.05)`).
- **Owner area:** payments · **Risk:** high (money) · **PR size:** Medium · **Tests:** concurrency PGlite test (blocked today — see T1 dependency on the fixture adapter, T3-2).
- **Detail:** [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-9, B-11 + audit Slice G.

### T1-4 · Edge-function `deno check` CI gate (the money path is untyped in CI)
- **Problem:** `edge-tests` runs `deno test --no-check` on `_shared/` **only**. None of the 96 function `index.ts` (incl. the 813-line `mollie-webhook`) are type/`deno check`ed anywhere. A mistyped/un-imported symbol ships green and fails at runtime on the payment path. (Audit P2-9, Slice I.)
- **Impact:** The single most load-bearing CI hardening item — protects every future money-path edge edit; pure workflow change, no runtime risk.
- **Fix:** add a `deno check` step scoped first to the money-critical set (`mollie-webhook`, `create-mollie-payment`, `auto-create-invoice`, `stripe-subscription-webhook`), ratchet like the tsc baseline. Verify red/green locally before wiring — do not block merges on a perma-red new gate.
- **Owner area:** CI / quality gates · **Risk:** low · **PR size:** Small · **Tests:** the gate itself; confirm it catches a deliberately un-imported symbol.
- **Detail:** [`technical-debt/QUALITY_GATES_BACKLOG.md`](technical-debt/QUALITY_GATES_BACKLOG.md) P0-1 + [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-6.

### T1-5 · Anon RLS / settings PII leaks (Slice K)
- **Problem:** the anon "view open cycles" policy leaks `settings.notify_admin_emails` (staff list) + full settings/terms (P2-1); academy managers can read a shared trainer's entire `guest_players` roster (P2-2); `get_player_locations`/`registrations` trust a client `guest_player_id` (P3-2/P3-3).
- **Impact:** Cross-tenant PII exposure on public/anon surfaces — reputational + compliance risk as tenant count grows.
- **Fix:** serve public forms via a postgres-owned `_public`/`_safe` view whitelisting form-safe columns; scope academy-manager guest visibility to associated guests; derive `guest_player_id` server-side. **Confirm product intent** on the shared-trainer guest sharing before narrowing.
- **Owner area:** RLS / tenancy · **Risk:** medium (each is a policy/SECURITY DEFINER migration) · **PR size:** Medium (one focused migration per leak) · **Tests:** anon-probe PGlite/RLS rehearsal per leaked column.
- **Detail:** [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-4, B-5, B-10.

### T1-6 · `get-admin-stats` GMV truncation (Slice J tail)
- **Problem:** six uncapped selects summed in JS over PostgREST-capped (1000-row) arrays → GMV/fees/trends **materially understated past 1,000 total bookings** with no error; OOM risk if the cap is naively removed. (Audit P2-16.)
- **Impact:** Admin financial dashboard silently wrong — you can't trust your own GMV number as the platform grows. Admin-only blast radius, but it's the number you'll steer by.
- **Fix:** move aggregation into COUNT/SUM RPCs; return summary rows.
- **Owner area:** admin / scale · **Risk:** low (admin-only) · **PR size:** Medium · **Tests:** seed 2k bookings, assert GMV RPC is not truncated.
- **Detail:** [`technical-debt/PERFORMANCE_BACKLOG.md`](technical-debt/PERFORMANCE_BACKLOG.md) P1-a.

### T1-7 · Deploy-gated fallbacks silently revert to unbounded scans
- **Problem:** `AcademyCyclusOverview.buildGroupsClientSide`, `cycles.ts`, `priorityClaims.ts`, `TrainerEarnings.tsx` all fall back to the legacy unbounded path on `PGRST202`/`42883` if their aggregation RPC migration isn't live → the app streams a whole owner's dataset to the browser (OOM at 10k+ slots) invisibly.
- **Impact:** A missed migration on an env bump degrades to a silent full-table scan with zero signal — exactly the failure the deploy-does-not-auto-apply reality makes likely.
- **Fix (operational + telemetry):** verify the RPCs are live after every env bump; emit a `notifySlackEdge`/PostHog ping when any fallback branch fires so a missing migration is loud.
- **Owner area:** scale / observability · **Risk:** low (add-only telemetry) · **PR size:** Small · **Tests:** unit-assert the fallback branch fires the ping.
- **Detail:** [`technical-debt/PERFORMANCE_BACKLOG.md`](technical-debt/PERFORMANCE_BACKLOG.md) P1-d.

---

## Tier 2 — Important before heavy scale

Real failure classes reachable under realistic load, and boundary/reliability gaps that don't lose money today but will bite as volume and contributor count grow.

### T2-1 · Capacity locks on the cyclus + partial-failure booking rollback
- **Problem:** the logged-in **cyclus** insert is not capacity-locked (single-slot is); a fresh single-slot booking orphans a capacity-occupying pending row when Mollie creation fails before a payment id exists (P2-10). (Slice G/J.)
- **Impact:** Overbook under concurrency; starved capacity from orphaned holds.
- **Fix:** route cyclus insert through a capacity-locked SECURITY DEFINER RPC (advisory lock + `FOR UPDATE`) mirroring `book_slot_for_payment`; soft-cancel or TTL-hold the orphaned booking on the Mollie-error branch.
- **Owner area:** booking / capacity · **Risk:** medium · **PR size:** B-11 Small (contained rollback) → B-1 Medium (locked RPC) · **Tests:** concurrency PGlite (blocked on adapter, T3-2).
- **Detail:** [`technical-debt/INVARIANT_BACKLOG.md`](technical-debt/INVARIANT_BACKLOG.md) B-1, B-11.

### T2-2 · Silent-failure alerting on the mid-flow money/email paths
- **Problem:** several edge fns return 200 while a mid-flow step failed with only `console.error`: `finalize-proposals` (booked-but-unbilled), `submit-guest-intake` (enrolled-but-uninvoiced), `resend-webhook` (silent deliverability blackout), `send-auth-email` (auth-critical), `sync-invoice-to-bookings` (price divergence).
- **Impact:** Real failure classes reach no proactive channel — a registrant is enrolled but never invoiced, and no one knows.
- **Fix:** promote the specific mid-flow catches to `notifySlackEdge`/`notifySlackEdgeError` (helper + service key already present in these fns).
- **Owner area:** observability · **Risk:** low (add-only) · **PR size:** Small each · **Tests:** unit-assert the alert fires on the error branch.
- **Detail:** [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md) OBS-P1-1..6.

### T2-3 · Missed-cron heartbeat + Slack dead-man's-switch
- **Problem:** Vercel doesn't page on a cron that never fires (`alertCronFailure` only fires on a non-2xx of a run that *happened*); and if `SLACK_WEBHOOK_URL` is unset, every proactive alert goes silent with zero signal.
- **Impact:** The alerting layer can fail silently — the worst failure mode for observability.
- **Fix:** last-success timestamp per cron (extend the single-flight lock rows) + a daily freshness check that pages if stale; an external uptime monitor on a "last Slack OK" endpoint.
- **Owner area:** observability (structural) · **Risk:** low · **PR size:** Medium · **Tests:** rehearsal that a stale last-success pages.
- **Detail:** [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md) OBS-P0-1, OBS-P1-2.

### T2-4 · Mutation-boundary lint gate + cycle-resync rehearsal
- **Problem:** nothing prevents a component from calling `supabase.from('bookings'|'invoices'|'availability_slots').insert/update/delete` directly, bypassing the boundary libs; and nothing enforces the F2 cycle-RPC resync contract (`syncSplitCountForCycle`/`syncInvoicesAfterPriceChange`) — both live in docs/reviewer memory only.
- **Impact:** A new contributor (or AI agent) silently skips invoice/split resync → money drift, with lint+tsc+tests all green.
- **Fix:** `eslint no-restricted-syntax` flagging the raw high-risk writes outside `src/lib/**` boundary modules, baselined shrink-only like the role-isolation rule; a `rehearse-cycle-resync-contract` script auto-joined to `db:rehearse:all`.
- **Owner area:** quality gates · **Risk:** low · **PR size:** Small (lint) + Medium (rehearsal) · **Tests:** the gate itself.
- **Detail:** [`technical-debt/QUALITY_GATES_BACKLOG.md`](technical-debt/QUALITY_GATES_BACKLOG.md) P1-1, P1-2.

### T2-5 · Remaining money-path page writes behind facades
- **Problem:** the largest open page-write cluster is `TrainerScheduleOverview.handleSaveCycleEdit` (slot/booking/cycle edits in-page, re-implementing whole-cycle-edit semantics `applySlotEditToCycle`/`updateCyclePricing` own — P1-a). ~~P1-b (`AcademyCyclusOverview` targeted bulk price)~~ **DONE**: extracted to `setTargetedCyclePrice` in `src/lib/cycleBookingMode.ts` (writes + invoice resync bundled, characterization-tested; allowlist entry removed).
- **Impact:** P1-a is the last money-adjacent write cluster not owned by a `src/lib/*` facade; divergence = silent under/over-billing.
- **Fix:** a `saveCycleEdit` facade that bundles the slot/booking edit + invoice resync atomically. Characterize (PGlite) → extract verbatim → wire (ADR 0003).
- **Owner area:** cycles / mutation boundary · **Risk:** medium (money) · **PR size:** Large (P1-a) · **Tests:** PGlite reschedule + co-occupant rebalance before extracting.
- **Detail:** [`technical-debt/MUTATION_BOUNDARY_BACKLOG.md`](technical-debt/MUTATION_BOUNDARY_BACKLOG.md) P1-a, P1-b.

### T2-6 · Unbounded per-owner display lists
- **Problem:** `TrainerBookings` (all-time), trainer `InvoiceList` (`select('*')`, no pagination), public `Trainers.tsx` directory — each silently truncates at 1,000 rows for a power user / large directory.
- **Impact:** Older bookings/invoices vanish from a heavy trainer's list; public SEO directory truncates.
- **Fix:** server-side `.range` pagination reusing the paginated RPC path (`playerBookings.ts`, `get_trainer_invoices`); paginate the directory.
- **Owner area:** scale · **Risk:** low · **PR size:** Small each · **Tests:** seed >1k rows for one entity, assert no truncation.
- **Detail:** [`technical-debt/PERFORMANCE_BACKLOG.md`](technical-debt/PERFORMANCE_BACKLOG.md) P1-b, P1-c, P2-a.

### T2-7 · Other confirmed P2 correctness fixes (Slice G/H tail)
- **Problem:** `send-schedule-notifications` double-sends on concurrent invocation (P2-11); `rebook_group_manage` appends onto a client-supplied `_invoice_id` with no ownership scope (P2-3); paid strict-hold confirmed without finalizing its claim (P2-12); `EditInvoiceDialog` detects price changes by array index (P2-13); cycle price/roster mutations don't invalidate invoice/player caches (P2-14); account-deletion deletes guests before invoices under a RESTRICT FK (P2-15).
- **Impact:** Duplicate emails, cross-tenant invoice append, stale UI after a price change, a blocked account deletion.
- **Fix:** per finding — atomic per-row claim / single-flight before emailing; `AND rebook_group_id = v_group` scope; finalize-claim on strict-hold confirm; content-based diff; cache invalidation; reorder the deletion cascade.
- **Owner area:** mixed (email / rebooking / invoices / account) · **Risk:** low-medium · **PR size:** Small each · **Tests:** targeted per fix.
- **Detail:** audit [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md) §P2-3, P2-11..15; INVARIANT_BACKLOG B-5.

---

## Tier 3 — Nice-to-have maintainability

No correctness/scale risk today; these lower the cost of every future change and make the codebase safer for an AI agent to extend. Do opportunistically or when touching the area.

### T3-1 · Component reuse waves (biggest LOC lever first)
- **Problem:** 49 files still hand-roll `AlertDialogContent` vs 12 on the shared `ConfirmDialog` (P0-1, on money flows — voids/deletes); `FullPageLoader` sweep ~3/26 done; no `SelectFilter` (30 sites), `CycleStatusBadge` (raw color literals), `DatePickerPopover` (24 sites), `TIME_OPTIONS` helper.
- **Impact:** Hundreds of duplicated LOC; hand-mixed destructive markup on money flows is a divergence hazard.
- **Fix:** extend the existing primitive; share the presentational leaf, keep business rules at the call site. **Pin a contract test before the `ConfirmDialog` sweep** (a mis-wired `onConfirm` silently breaks a delete/void). Avoid the over-abstraction traps (`FormField`, `EntityCombobox`, `FormDialog`, `TrainerPageHeader`↔`PageHeader` merge).
- **Owner area:** frontend · **Risk:** low (P0-1 medium on money flows) · **PR size:** Small-safe per file, Large in aggregate · **Tests:** contract test for the dialog handler contract.
- **Detail:** [`technical-debt/COMPONENT_REUSE_BACKLOG.md`](technical-debt/COMPONENT_REUSE_BACKLOG.md) (registry: [`COMPONENT_PATTERN_REGISTRY.md`](COMPONENT_PATTERN_REGISTRY.md), ADR 0008).

### T3-2 · Shared PGlite schema/seed fixture layer
- **Problem:** every `*.pglite.test.ts` hand-rolls its own `CREATE TABLE` + literal seed → schema drift between tests and from the real migrations; `factory.ts` (JS) and the PGlite tests (SQL) don't meet; the adapter can't model concurrency (blocks the T1-3/T2-1 race tests) or de-dup the Deno `_shared` auth helpers.
- **Impact:** Test-writing is slow and drift-prone; the concurrency gap blocks proving the highest-severity money-race fixes.
- **Fix:** a canonical PGlite schema loader (ideally derived from migrations) + typed seed helpers (whole-cycle, pending/paid/cancelled booking trio, Mollie payment metadata); extract the Deno `_shared` `makeReq`/`withEnv`/`forgedJwt` helpers into one module; add multi-connection concurrency to the adapter.
- **Owner area:** test infra · **Risk:** low · **PR size:** Medium (loader) · **Tests:** the fixture is the deliverable.
- **Detail:** [`technical-debt/TEST_FIXTURE_BACKLOG.md`](technical-debt/TEST_FIXTURE_BACKLOG.md).

### T3-3 · Deferred-until-measured scale work
- **Problem:** missing `availability_slots(academy_profile_id, start_time)` composite index (P2-b); AcademyDashboard recent-bookings probe-and-discard (P2-c); Players list offset→keyset pagination (P2-d).
- **Impact:** Potential slow academy calendar / deep planner scans only at 100k+ slots/bookings — not reached today.
- **Fix:** add the composite index / denormalize `trainer_id` onto `bookings` / switch to keyset **only if measured slow** — each is a migration; do not pre-optimize.
- **Owner area:** scale · **Risk:** low · **PR size:** Small · **Tests:** measure first.
- **Detail:** [`technical-debt/PERFORMANCE_BACKLOG.md`](technical-debt/PERFORMANCE_BACKLOG.md) P2-b, P2-c, P2-d.

### T3-4 · Lower-risk mutation-boundary sweeps + CI polish
- **Problem:** residual low-risk raw writes (invoice create line-item math duplicated per screen, `is_public` toggles, slot-create scatter — MUTATION_BOUNDARY P2-a..g); `check:edge-config` allowlist is hand-maintained; no money-path coverage floor; no dead-baseline pruning.
- **Impact:** Duplicated math can drift; blind spots in the config guard.
- **Fix:** `createInvoice(input)` facade reusing `invoiceCalc`; route residual writes through their facades; derive `MUST_BE_PUBLIC` from a marker; scoped coverage floor on `src/lib/{bookings,invoiceSync,cycleWrites,slotBookingWrite}.ts`.
- **Owner area:** mutation boundary / CI · **Risk:** low · **PR size:** Small each · **Tests:** characterize totals before extracting.
- **Detail:** [`technical-debt/MUTATION_BOUNDARY_BACKLOG.md`](technical-debt/MUTATION_BOUNDARY_BACKLOG.md) P2-a..g + [`technical-debt/QUALITY_GATES_BACKLOG.md`](technical-debt/QUALITY_GATES_BACKLOG.md) P2-1..3.

### T3-5 · Structural observability + DR runbook
- **Problem:** no server-side error aggregator (an un-instrumented edge fn's failure is captured nowhere durable); no Slack rate-limit/dedup; no tested restore runbook for the `backup-database` logical export.
- **Impact:** Blind spots and channel-flood risk at 1k-academy scale; unrehearsed DR.
- **Fix:** add a server-side error sink (Sentry/Logflare-style) as the durable backstop; per-event throttling on the `slack-notify` path; write + rehearse a restore runbook.
- **Owner area:** observability (structural) · **Risk:** low · **PR size:** Medium · **Tests:** rehearse the restore.
- **Detail:** [`technical-debt/OBSERVABILITY_BACKLOG.md`](technical-debt/OBSERVABILITY_BACKLOG.md) OBS-P2-2, P2-3, P2-5.

---

## Notification-controls units — status 2026-08-05

> **OWNER BOUNDARY (2026-08-05): Complete N0–N7. Stop before A1. FOUNDATION AUDITS NOT STARTED.**
> The notification programme runs through N7 (controlled rollout + postflight). The cross-domain
> foundation certification audits (A1–A7) are POSTPONED and must not begin — no audit subagents,
> no audit reconnaissance — until the owner gives a new instruction. Bounded reviews of
> notification code remain in scope. WhatsApp rollout that lacks provider/template/webhook
> readiness or separate owner approval is recorded as `BLOCKED_OWNER_WHATSAPP` and must not block
> email completion.

### Completion contract (owner, 2026-08-05) — authoritative

This section is the programme's single source of truth; the working memory notes point here rather
than restating it.

**Sequence.** Finish N4 → N5 → N6 → N7 → the *Notification Foundation Final Integration Audit* →
resolve it → declare the architecture frozen → **stop before A1** and before the broader
players/bookings/invoices/academy audit.

**Owner gates (never crossed autonomously).** mark-ready/merge, deployment, production or
credential access, migrations against production, cron/engine/secret/provider configuration, a real
canary or send, channel activation, destructive cleanup or legacy deletion. Email and WhatsApp
activation are *separate* owner decisions.

**Engineering objective.** Not green tests — a foundation where future change is small, localized,
observable and hard to make unsafe: explicit DB/app contracts, typed RPC results, narrow ownership
boundaries, reusable UI components and hooks, provider *adapters* rather than provider logic spread
through the app, durable auditable state transitions, operational visibility, documented recovery,
behavioural tests for invariants, and documentation that explains the reasoning as well as the
behaviour.

**Architecture freeze.** N7 is the feature boundary. After it, architecture changes only where the
final audit names a concrete correctness, security, scalability, operability or user-facing defect.
Every P0/P1/P2 finding is resolved; P3 findings are resolved when they affect users or
maintainability or are cheap, and otherwise recorded in a bounded follow-up list
([`NOTIFICATION_FOLLOWUPS.md`](NOTIFICATION_FOLLOWUPS.md)). Cleared areas are not reopened without
evidence of a regression or a newly discovered cross-unit contradiction.

**Review loop per milestone.** Read the contract → implement a coherent batch → focused tests →
bounded Codex MCP review of that exact diff → evaluate every finding on the merits → fix legitimate
P0/P1/P2 (and relevant P3) → re-run focused tests → *one* correction verification → full applicable
gates at milestone completion → continue automatically. One whole-unit seam review at each N-unit
boundary; no repeated whole-unit audits once a unit is clear, absent concrete evidence of another
cross-unit defect.

**Non-negotiable invariants the finished foundation must prove.** No historical backlog can become
eligible after activation, and only events at or after the activation boundary may enter a newly
activated path · no logical notification delivered twice through retry, concurrency, duplicate
dispatch or ambiguous provider acceptance · every send attributable to event, effective preference,
tenant, channel, attempt and provider outcome · player preference/consent/suppression enforced ·
academy controls restrict but never expand eligibility · required service notifications follow
their documented rules · no cross-tenant or PII leakage through admin or academy surfaces · kill
switches and circuits checked immediately before provider work · failures observable and
recoverable without unsafe replay · WhatsApp gated on provider readiness *and* consent · engine and
channel activation never inferred from DB state alone when an env switch is authoritative · the UI
never claims certainty about unknown state · every operator decision audited and idempotent.

**Final Integration Audit (after N7, one pass).** Inventory and contract reconciliation → cross-unit
seam audit over the complete flows → security and privacy → scalability and reliability →
executable verification (full gates, migration reset + types drift, all notification suites, edge,
UI, architecture guards, selected browser workflows, no-backlog and recipient-preview proofs,
mutation only for critical invariants) → one independent Codex whole-foundation review → fix → one
final verification. Then freeze and stop.


The pre-canary work, in flight on draft PRs. All three are independently Codex-reviewed to clear
and CI-green; mark-ready, merge and deploy are owner gates. **None changes notification behaviour
in production**: N0 is operator tooling, N2 ships inert schema nothing reads yet, and N1 is
presentation and reachability only.

| Unit | PR | State |
|---|---|---|
| **N0** — privilege-correct `cron.job` row lock for the enablement tooling | [#630](https://github.com/joranhofman87/padeltrainer-independent/pull/630) | clear at `6be077cf`, CI green |
| **N1** — player notification-settings gap closure | [#631](https://github.com/joranhofman87/padeltrainer-independent/pull/631) | clear at `6cb96359`, CI green (full suite, 4697 tests) |
| **N2 S1+S2a** — marketing suppression, signed manage capabilities, declared footer policy, token helper | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | clear at `4595a03f`, CI green |
| **N2 S4** — the neutral `/app/settings/notifications` route + Auth redirect sanitisation | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | clear at `a1d9ba8c` |
| **N2 S2b** — neutral-route footers (send-email + digest render) + legacy flush send-time gate | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | clear at `ed2465cd`, CI green at `2980ccb3` |
| **N2 S3** — campaign/onboarding suppression + per-send capabilities + RFC 8058 | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | clear at `b961e7f1`, CI green at `7166d403` |
| **N2 S5** — one-click endpoint + manage page + retention sweep | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | clear at `47e6658e` |
| **N2 WHOLE-UNIT SWEEP** — fresh thread over `main..HEAD`, aimed at the seams | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | **CLEAR at `f1a7f1e8`** (4 findings, all fixed: RFC 8058 body marker; send-email pref read fail-closed; Retry-After; sweep index) |
| **N2 FINAL** — clear reconfirmed through post-clear commits; CI | [#632](https://github.com/joranhofman87/padeltrainer-independent/pull/632) | **ALL CHECKS GREEN at `4f002488`** — N2 complete, awaiting the owner gate (mark-ready/merge/deploy) |
| **N3 M1–M3** — tenant-aware idempotency + academy caps/audit + cap at every send authority | (stacked draft PR) | **clear at `813f7f4e`** (design contract findings 1, 3, 7-11 closed; 3 review rounds; M4-M6 + seam review remain) |
| **N3 M4–M6** — membership reader + player history, attribution matrix, both surfaces | [#633](https://github.com/joranhofman87/padeltrainer-independent/pull/633) | **clear at `626d03ce`** (4 rounds total; whole-unit seam review next) |
| **N3 WHOLE-UNIT SWEEP** — fresh thread over the full unit, aimed at the seams | [#633](https://github.com/joranhofman87/padeltrainer-independent/pull/633) | **CLEAR at `bd09d652`** — N3 **CODE-COMPLETE, Codex-clear, local-gates green; NOT release-ready**: #633 targets the N2 branch, so only Vercel checks have run — the substantive workflows (lint/typecheck/test/edge/db-reset/types-drift) trigger on PRs against `main` only. Full integration CI runs after the ordered retarget (merge #632 → rebase #633 onto main). Do not weaken workflow branch filters to manufacture green checks. |
| **N4 design review** — admin ops, 16-finding contract (4 CRITICAL) | (branch `feat/notif-n4-admin-ops`) | REQUEST-CHANGES consumed as the implementation contract (memory/notif-n4-design.md); M1 invocation record first |
| **N4 M1–M7** — invocation record, kill switches, audit + rejected attempts, admin reads, recovery, readiness/preview/search, the admin UI | (branch `feat/notif-n4-admin-ops`) | each milestone Codex-clear; UI refactored to the `UI_COMPONENT_STANDARDS` primitives with a self-testing architecture guard |
| **N4 WHOLE-UNIT SEAM REVIEW** — fresh thread over `bd09d652..HEAD` | (branch `feat/notif-n4-admin-ops`) | 4 rounds. R1: authority-matrix honesty, cap-guard deadlock, helper ACLs, preview/resolver equivalence. R2: gate lock inversion, circuit-release naming, blank/found-contact equivalence, cross-actor collision, evidence backfill. R3: run/invocation causality, whatsapp digest verdict, applied-decision evidence. **R4 = convergence** (three rounds in one invariant family): the deliberate-invocation *ownership contract* is written out in `20261025100000` and `purpose='manual'` is removed — ownership is proven by exclusion (cron inactive under the job row lock, no run in flight, single-flight, causal pg_net record), never inferred from timestamps |

**N0 is the reason the disabled smoke could not run.** On hosted Supabase `cron.job` is owned by
`supabase_admin` and the connected role holds SELECT only, so the `FOR UPDATE` in four enablement
artifacts was never executable there — a privilege model the superuser-only verify harness never
exercised. #630 replaces it with a guarded no-op `cron.alter_job` lock, runs every artifact in the
harness as a restricted role, adds a real-pg_cron rehearsal, and wires the previously CI-orphaned
10c-b verifies into `rollout-tooling.yml`. **N0 is complete only when the corrected smoke exits 0
in production** with the exact disabled response and zero counter deltas — an owner-gated
operation, still outstanding. It unblocks the SMOKE, not the send: Admin Notification Operations
(below) still blocks every canary and activation.

**S4 landed first, out of numeric order, because S2b emits the route it mounts.**
`/app/settings/notifications` is mounted OUTSIDE every role layout and RENDERS the settings page
rather than forwarding to a role route. Forwarding was the first design; review killed it, because
the role layouts guard far more than role — an expired academy or an incomplete trainer onboarding
is redirected off the settings path by its own layout, so a forward only moved the bounce one hop
later, stranding exactly the people most likely to be unsubscribing. Logged out, the destination
rides in `?redirect=`.

Implementing it exposed a live open redirect on two paths: `Auth.tsx` stored `?redirect=` verbatim
and navigated to it after login, and the same parameter travelled through the signup link into
`TrainerSignup` → `TrainerOnboardingFlow`, which stored and navigated it raw. All five sites now
sanitise, and a stored value that fails is purged. The guest manage page and analytics redaction
stay with S3/S5.

**N2's remaining slices** continue on `feat/notif-n2-email-prefs`: S2b (worker + digest-render
footer attach, the role-agnostic `send-email` link, and a send-time gate for the legacy
`send-digest-emails`, which today sends claimed queue rows with no preference or suppression
re-check); S3 (campaign/onboarding suppression, footers, RFC 8058 headers); S5 (the one-click
endpoint, the capability sweep, docs). The constraints S1 imposes on those slices, each naming the
slice that must satisfy it, are in [`NOTIFICATION_FOLLOWUPS.md`](NOTIFICATION_FOLLOWUPS.md) §N2.

**N3 (academy controls) and N4 (Admin Notification Operations) are not started.**

**One finding from outside these units, recorded rather than fixed:** CI surfaced a concurrent
materializer race in 10c-a2 — `materialize_notification_digest_groups` racing itself, leaving a
member in no group or a duplicate chunk. Not introduced by N2, and not reproducible on a many-core
machine. Evidence and reasoning in [`NOTIFICATION_FOLLOWUPS.md`](NOTIFICATION_FOLLOWUPS.md)
§10c-a2. Both failure modes are silent (an undelivered digest, or a doubled one), so it is worth
reproducing under deliberate contention before the digest engine is enabled for anyone.

---

## Blocking release unit — Admin Notification Operations (10c-b Stage 3.5)

**Owner-requested. It BLOCKS the notification digest canary and activation, and is deliberately NOT
part of PR #629**, which stays scoped to A–I. Entry: #629 merged and deployed inert. Exit: this unit
is reviewed, CI-green, deployed, and the owner has confirmed the surfaces work. Only then may a
canary run or the cron be armed — `scripts/rollout/notif-10cb/run-enablement.sh` requires
`--admin-ops-confirmed` on `canary-invoke`, `canary` and `activate`, and **this section is that
flag's referent**. `canary-invoke` is the one that gates the send itself: it is the subcommand that
invokes the worker, so from that step onward the flag is a mechanical precondition on mail going out
rather than only on reconciling and arming afterwards.

**Why it blocks.** Not because failures are otherwise undetectable — a failed canary shows up in its
HTTP result, in `canary_verify.sql`, and in the worker's Slack alert. Because there is no
**in-product, global** view of the pipeline and no safe recovery controls: today the only way to
see what it is doing, or to intervene, is psql against production plus the rollout scripts. That is
one person at a keyboard, not operations.

**Scope — global admin visibility (read).** A cross-tenant admin surface over the real tables, not a
mock: `notification_outbox` (pending/claimed/failed per event + channel), `notification_digest_groups`
and `notification_digest_attempts` (state, `outcome_class`, provider ids),
`notification_worker_runs` (phase/channel/status/`ended_at`), `notification_provider_circuit`
(per-channel breaker state, reason, `retry_at`), `notification_orphan_reconcile_state` (what is
parked awaiting a human), `notif_digest_worker_liveness()`, and the email deliverability record.
PII-minimal; message bodies are never exposed to a non-tenant admin.

**Scope — safe controls (write). FAIL-CLOSED DIRECTIONS ONLY.** This is the constraint that matters,
and it is easy to get wrong: an admin "activate the cron" button would satisfy a loosely-worded spec
while bypassing everything `scripts/rollout/notif-10cb/sql/activate.sql` exists to enforce — the
reviewed-command hash, the node/schedule/owner identity, canary freshness and binding, the run-ledger
and group locks, and the monitor confirmation. Combined with an already-enabled edge switch, an admin
engine toggle plus an admin arm button *is* a send button, however the copy is worded.

So the admin surface may only move things toward **safe**:
* digest engine **disable** (per event) — never enable;
* cron **deactivate** — never activate, and **never** `cron.unschedule`, which destroys the reviewed
  Vault-backed command;
* resolve or re-queue a quarantined orphan; **cancel** a stuck group.

Three recovery actions are NOT fail-closed, because the next tick can send off the back of them, and
they are specified separately rather than waved through under the same heading:
* **closing a tripped circuit** re-opens the whole channel. It must state the trip reason, refuse
  outright while the reason is `correlation_mismatch` (a permanently mis-correlated message needs
  resolving, not un-holding), and require an explicit typed confirmation.
* **retrying a group** re-enters the send path. It must respect the group's remaining delivery
  budget and attempt cap, require positive provider evidence that the previous attempt did not land
  (never a `delivery_unknown` guess), and re-check consent/stop policy at retry time rather than
  trusting the enqueue-time decision.
* neither may call the provider directly — they may only move state that the existing worker and
  state machine then act on, so every send continues to go through the reviewed path.

**Enabling and arming stay in the owner runbook**, behind the one authoritative gate. If a future
version wants an in-product activate, it must call that same gate — canary-bound, locked and
count-checked — and not a raw `cron.alter_job(active := true)`.

**Acceptance criterion 6 — a durable pending-invocation record.** A dispatch run only appears
in `notification_worker_runs` once the worker *starts*. Between `canary-invoke`'s commit and that
moment the pipeline has no durable record that an invocation is on its way, so "nothing is in flight"
reads clean over a canary that is already travelling — which lets a second invocation start, and lets
`activate` arm the cron on the *previous* canary's evidence while an unverified one is in the air.
10c-b narrows this by refusing while a request to the worker endpoint is still in
`net.http_request_queue`, and both artifacts say plainly that this is a narrowing, not a closure:
pg_net owns that row's lifetime, so a request already dispatched but not yet recorded stays invisible.
Closing it needs a record written by the invoker and cleared by the worker — pipeline state, owned by
this release unit, and one of the things its global view should show. Until it exists, treat
"invocation in flight" as an operator responsibility: one canary at a time, and never `activate` from
a second terminal while `canary-invoke` is still running.

Every control is admin-only, audited, idempotent, and refuses rather than guesses. **No control may
perform a send.** `DIGEST_SEND_ENABLED` is an edge env var that no SQL and no admin surface can read
— the UI must say so rather than imply it checked.

**Acceptance criteria — what "shipped and verified" means for `--admin-ops-confirmed`:**
1. ACL/RLS proven for admin vs trainer vs player vs anon — a non-admin gets nothing.
0. **No control enables the engine or arms the cron.** Asserted, not just reviewed: a test must fail
   if such a control exists, and arming must remain reachable only through `activate.sql`.
2. Every control mutation-pinned: removing the guard fails a test.
3. The read surface tested against real fixture data, not stubs.
4. Independent review clear, every repo gate green.
5. Deployed, and the owner has exercised each surface once.
6. **A durable pending-invocation record exists** — written by whatever invokes the digest worker and
   cleared when that invocation's run appears or is abandoned — and both `canary-invoke` and the
   activation gate read it. See "Acceptance criterion 6" above for why the 10c-b narrowing is not a
   closure. Until this ships, "one invocation at a time" is an operator responsibility, not an
   enforced invariant.

## Owner deploy backlog (already-merged, not yet live)

Independent of the above: these are **merged in code but await the owner's manual prod apply** — track separately so they don't read as "done." The `reconcile_payments` RPC + `mollie-webhook` audit writes need migration `20260705140000` applied + the `mollie-webhook` redeployed (see [`OBSERVABILITY_AND_RECOVERY.md`](OBSERVABILITY_AND_RECOVERY.md)). Confirm against the deploy checklist before assuming any edge-fn/migration fix is active in prod.
