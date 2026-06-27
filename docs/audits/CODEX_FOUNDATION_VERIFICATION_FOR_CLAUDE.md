# Codex Foundation Verification Handoff For Claude

Date: 2026-06-27  
Repo: `joranhofman87/padeltrainer-independent`  
Local path: `/Users/tom/Cursor/padeltrainer`  
Verified local branch/commit at time of Codex audit: `main` at `7f9859e5`  

## Purpose

This document is a Claude-ready handoff from Codex.

The user wants Padeltrainer to have a stable foundation before inviting more academies/trainers. The target scale is roughly:

- 1,000 academies
- 10,000 trainers
- 100,000+ bookings

The goal is not just "the app works today." The goal is:

- stable architecture
- reusable components
- fewer duplicated role-specific implementations
- strong booking/payment/domain invariants
- fewer bugs when scaling
- safer future AI-assisted development
- operational readiness before broader launch

Claude has already made many changes and provided a progress summary. Codex audited that summary against the actual repo. Many improvements are real, but Codex found several things that must be checked/fixed before moving forward.

This file should be used as the starting prompt/context for a new Claude session.

## Instructions For Claude

You are acting as technical lead.

Start by verifying this report against the latest `main`. Do not blindly trust this document, but treat it as high-priority evidence from a second reviewer.

Do the work in this order:

1. Sync latest `main`.
2. Reproduce/verify the findings below.
3. Fix the P0/P1 issues first.
4. Add/update tests so the issues cannot regress.
5. Update docs so future AI/devs understand the canonical architecture.
6. Run the required checks.
7. Report clearly what changed, what remains, and what is safe/unsafe to deploy.

Do not deploy anything to production.
Do not run side-effecting live Supabase functions.
Do not send real emails.
Do not trigger real rebooking flows.
Do not touch live academy/player data.

Recommended start:

```bash
cd /Users/tom/Cursor/padeltrainer
git fetch origin
git checkout main
git pull --ff-only
git checkout -b hardening/foundation-verification-fixes
```

## Executive Summary From Codex

Claude's previous work is directionally strong and much of the summary is true.

Verified good progress:

- Component role-isolation cleanup is real.
- Academy/club/player pages no longer import from `components/trainer`.
- `no-restricted-imports` suppression baseline is now zero.
- Shared neutral folders now exist for booking/slots/agenda/players/dashboard.
- `DateInputField` exists and raw `<Input type="date">` is lint-blocked.
- `ListPageShell` adoption has started.
- `lint`, `tsc`, `build`, edge config check, and DB rehearsals passed locally.
- DB rehearsals are strong: `npm run db:rehearse:all` passed 36/36.

But the summary is too optimistic in a few places.

Codex found:

1. **P0/P1: public single-slot online booking has a serious leftover risk.**
2. **P1: full Vitest test suite is not green.**
3. **P1: "dangerous mutations are out of UI" is overstated.**
4. **P1: merged does not mean live; deploy checklist still has owner-pending items.**
5. **P2: some docs are stale and could mislead future AI/devs.**

Fix these before moving to the next foundation phase.

## Validation Commands Codex Ran

Codex ran these on `/Users/tom/Cursor/padeltrainer`, on `main` at `7f9859e5`.

Passed:

```bash
npm run lint
npx tsc --noEmit
npm run build
npm run check:edge-config
npm run db:rehearse:all
```

Notes:

- `npm run build` passed, but emitted non-fatal warnings:
  - duplicated dynamic/static imports around `src/lib/posthog.ts`
  - duplicated dynamic/static i18n locale imports
  - stale Browserslist data
- `npm run db:rehearse:all` passed: 36/36 rehearsals.
- `npm run check:edge-config` passed: all 25 public edge functions are `verify_jwt=false`.

Failed/could not run:

```bash
npx vitest run
```

Result:

- 1 test file failed
- 2 tests failed
- 236 files passed
- 1782 tests passed

Failed file:

- `src/test/adminListUiPhase1.test.ts`

Could not run:

```bash
npm run i18n:check
```

Reason:

- local machine does not have `bun` installed
- output: `sh: bun: command not found`

## Finding 1: Public Single-Slot Online Booking Can Double-Insert

Severity: P0/P1  
Category: booking/payment correctness, mutation boundary, production risk  

### Why This Matters

This is the sharpest issue Codex found.

The public paid single-slot booking path appears to insert a pending booking in the page, then calls the `create-mollie-payment` edge function without passing that booking's ID.

The edge function treats missing `bookingIds` as "I need to create the booking myself" and calls the capacity-locked `book_slot_for_payment` RPC.

That means the single-slot online booking path can try to create a second booking.

Depending on slot capacity and unique indexes, this can fail with `slot_full` or duplicate booking constraints, while leaving the first pending booking behind.

This is exactly the kind of architecture issue we want to eliminate before scaling.

### Evidence

In `src/pages/BookLesson.tsx`, the single-slot online payment branch inserts a pending booking:

```tsx
const { error } = await supabase.from('bookings').insert({
  player_id: profile.id,
  slot_id: selectedSlot.id,
  notes: notes || null,
  status: 'pending',
  payment_status: 'pending',
}).select().single();
if (error) throw error;

const { data: paymentData, error: paymentError } = await supabase.functions.invoke('create-mollie-payment', {
  body: {
    slotId: selectedSlot.id,
    amount: price,
    description: selectedSlot.cyclus_name || t('booking.trainingSession', 'Training Session'),
    trainerId: trainer.id,
  },
});
```

Observed around:

- `src/pages/BookLesson.tsx:512`

The call does **not** pass `bookingIds`.

In `supabase/functions/create-mollie-payment/index.ts`, the edge function reads optional `bookingIds`:

```ts
const { slotId, amount: clientAmount, description, trainerId, redirectUrl, bookingIds } = await req.json();

const requestedBookingIds: string[] = Array.isArray(bookingIds)
  ? bookingIds.filter((id: unknown) => typeof id === "string")
  : [];
```

Observed around:

- `supabase/functions/create-mollie-payment/index.ts:170`
- `supabase/functions/create-mollie-payment/index.ts:194`

If `bookingIds` are present, it uses existing bookings and validates ownership/status:

```ts
if (allBookingIds.length > 0) {
  bookingId = allBookingIds[0];
  logStep("Using existing bookings", { bookingIds: allBookingIds });
  ...
}
```

Observed around:

- `supabase/functions/create-mollie-payment/index.ts:476`

If no `bookingIds` are present, it creates a booking via RPC:

```ts
const { data: newBookingId, error: bookingError } = await supabase.rpc("book_slot_for_payment", {
  _slot_id: slotId,
  _player_id: playerProfile.id,
  _payment_amount: expectedAmount,
});
```

Observed around:

- `supabase/functions/create-mollie-payment/index.ts:565`

The RPC exists specifically to do capacity-locked booking insertion:

```sql
CREATE OR REPLACE FUNCTION public.book_slot_for_payment(
  _slot_id uuid,
  _player_id uuid,
  _payment_amount numeric
)
...
PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));
...
INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount)
VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount)
RETURNING id INTO v_id;
```

Observed around:

- `supabase/migrations/20260614130000_book_slot_for_payment.sql:11`

The cycle branch in `BookLesson.tsx` already passes `bookingIds` to `create-mollie-payment` after inserting cycle bookings:

```tsx
body: {
  slotId: selectedCyclus.slots[0].id,
  amount: paymentAmount,
  description: cyclusLessonTitle,
  trainerId: trainer.id,
  bookingIds,
}
```

Observed around:

- `src/pages/BookLesson.tsx:446`

The single-slot branch should be made consistent.

### Preferred Fix Direction

There are two possible designs. Pick the safer one after verifying current product behavior.

#### Option A: Edge Function Owns Online Booking Creation

For public online single-slot bookings:

- Do **not** insert the booking in `BookLesson.tsx`.
- Let `create-mollie-payment` call `book_slot_for_payment`.
- Use the returned `bookingId`/`checkoutUrl` from the edge function.

This is the cleaner mutation boundary:

```text
BookLesson UI
  -> create-mollie-payment edge function
    -> book_slot_for_payment RPC
      -> booking row inserted under capacity lock
      -> Mollie payment created
      -> booking.mollie_payment_id written
```

Pros:

- Single owner for online paid booking creation.
- No duplicate pending booking risk.
- Capacity is checked inside the payment edge flow.
- Future retries/idempotency can be centralized.

Cons:

- Must preserve notes if notes are needed on the booking.
- `book_slot_for_payment` currently accepts only `_slot_id`, `_player_id`, `_payment_amount`.
- May need to extend RPC/edge function to include notes/status/metadata.

#### Option B: Page Inserts Booking, Edge Function Uses Existing Booking

For public online single-slot bookings:

- Keep the `BookLesson.tsx` insert.
- Capture `bookingData.id`.
- Pass `bookingIds: [bookingData.id]` to `create-mollie-payment`.

This is a smaller patch.

Pros:

- Minimal behavior change.
- Matches existing cycle branch.

Cons:

- UI still owns a dangerous booking insert.
- If payment creation fails after insert, a pending booking remains.
- It does not fully move dangerous mutations out of UI.

Given the user's roadmap, prefer Option A unless the blast radius is too high. If Option A is too risky, implement Option B now and document Option A as a near-term follow-up.

### Required Tests

Add tests that catch the current bug.

At minimum:

1. A static/source regression test or component-level test ensuring the single-slot online path does not call `create-mollie-payment` without either:
   - passing `bookingIds`, or
   - not inserting a booking first.

2. A test around `create-mollie-payment` behavior:
   - With no `bookingIds`, it creates exactly one booking via `book_slot_for_payment`.
   - With `bookingIds`, it does not create a new booking and uses the existing booking(s).

3. If feasible, an integration-style test for `BookLesson`:
   - Single slot online booking does not create an orphan pending booking when payment setup/payment creation fails.

### Acceptance Criteria

- Single-slot online booking cannot create a duplicate booking.
- If payment creation fails, no unexpected extra capacity-occupying booking remains.
- `create-mollie-payment` receives clear, intentional inputs.
- Tests fail on the old behavior and pass on the new behavior.
- Public booking happy path still redirects to Mollie checkout.

## Finding 2: Vitest Is Red Due To Stale Admin List Architecture Tests

Severity: P1  
Category: test suite health, CI reliability  

### Evidence

Command:

```bash
npx vitest run
```

Result:

- 1 failed test file
- 2 failed tests
- 236 passed files
- 1782 passed tests

Failed tests:

- `src/test/adminListUiPhase1.test.ts > AdminUsers uses shared list primitives`
- `src/test/adminListUiPhase1.test.ts > AdminAcademies uses shared list primitives`

Observed test source:

```ts
const sharedPrimitives = [
  'AppPage',
  'PageHeader',
  'TableToolbar',
  'DataTableCard',
  'compactDataTableClass',
  'EmptyState',
  'ListPageSkeleton',
] as const;
```

The test checks that each page source literally contains these strings.

Observed around:

- `src/test/adminListUiPhase1.test.ts:7`

But newer migrated pages use `ListPageShell`, which wraps `AppPage`, `PageHeader`, and `ListPageSkeleton` internally:

```tsx
export function ListPageShell(...) {
  return (
    <AppPage width={width} className={className}>
      {isLoading ? (
        loadingFallback ?? <ListPageSkeleton />
      ) : (
        <>
          <div>
            <PageHeader ... />
            {headerAfter}
          </div>
          {children}
        </>
      )}
    </AppPage>
  );
}
```

Observed around:

- `src/components/ui/list-page-shell.tsx:41`

Admin pages now use `ListPageShell`:

- `src/pages/admin/AdminUsers.tsx:521`
- `src/pages/admin/AdminAcademies.tsx:265`

So the failing tests are probably stale architecture tests, not broken runtime UI.

### Required Fix

Update the tests so they enforce the current canonical architecture instead of brittle literal imports.

Suggested approach:

- For pages migrated to `ListPageShell`, the test should accept `ListPageShell` as satisfying `AppPage`, `PageHeader`, and `ListPageSkeleton`.
- Keep asserting:
  - no `container mx-auto`
  - uses `TableToolbar`
  - uses `DataTableCard`
  - uses `compactDataTableClass`
  - uses `EmptyState`
- For pages that are not migrated to `ListPageShell`, either keep the old expectations or split the test into two categories.

Also consider adding a small test for `ListPageShell` itself that confirms it composes:

- `AppPage`
- `PageHeader`
- `ListPageSkeleton`

There is already `src/components/ui/list-page-shell.test.tsx`; inspect and extend it if needed.

### Acceptance Criteria

- `npx vitest run` passes.
- Test still prevents regressions to bespoke page shells.
- Test no longer requires page files to directly import components that are intentionally hidden behind `ListPageShell`.

## Finding 3: Dangerous Mutations Are Not Fully Moved Out Of UI

Severity: P1  
Category: architecture boundary, future bug prevention  

### Why This Matters

The user's roadmap says:

> Move dangerous mutations out of UI. Centralize them behind tested domain actions/RPCs.

Claude's summary said:

> Domain facades own the writes now.

Codex found this is only partly true.

There are useful facades now, but direct booking/invoice writes still exist in pages/components. Some are probably safe enough because database triggers/RLS/constraints enforce invariants, but the architectural boundary is not done.

This matters because future AI/dev fixes may patch one UI surface and forget another.

### Evidence: Direct Booking/Invoice Writes Still Exist

Examples found by Codex:

#### Booking inserts

- `src/pages/BookLesson.tsx:384`
- `src/pages/BookLesson.tsx:471`
- `src/pages/BookLesson.tsx:487`
- `src/pages/BookLesson.tsx:512`
- `src/components/booking/BookForPlayerDialog.tsx:600`
- `src/components/booking/BookForPlayerDialog.tsx:730`
- `src/components/booking/InlineBookPlayer.tsx:433`
- `src/components/booking/InlineBookPlayer.tsx:521`
- `src/pages/TrainerScheduleOverview.tsx:609`
- `src/pages/TrainerScheduleOverview.tsx:1015`

#### Booking updates

- `src/components/booking/InlineEditBooking.tsx:128`
- `src/lib/unpaidBookings.ts:247`
- `src/pages/TrainerBookings.tsx:264`

#### Invoice updates/deletes

- `src/pages/trainer/TrainerEditInvoice.tsx:130`
- `src/pages/trainer/TrainerEditInvoice.tsx:174`
- `src/pages/trainer/TrainerEditInvoice.tsx:178`
- `src/pages/trainer/TrainerInvoices.tsx:281`
- `src/pages/trainer/TrainerInvoices.tsx:323`
- `src/pages/trainer/TrainerInvoices.tsx:330`
- `src/pages/trainer/TrainerInvoices.tsx:391`
- `src/pages/trainer/TrainerInvoices.tsx:395`
- `src/pages/trainer/TrainerInvoices.tsx:414`
- `src/pages/academy/AcademyInvoices.tsx:481`
- `src/pages/academy/AcademyInvoices.tsx:573`
- `src/pages/academy/AcademyInvoices.tsx:577`
- `src/pages/academy/AcademyEditInvoice.tsx:230`
- `src/pages/academy/AcademyEditInvoice.tsx:234`
- `src/components/trainer/InvoiceList.tsx:281`
- `src/components/trainer/InvoiceList.tsx:326`
- `src/components/trainer/InvoiceList.tsx:334`
- `src/components/trainer/InvoiceList.tsx:351`
- `src/components/trainer/InvoiceList.tsx:360`

### Important Nuance

Do not blindly remove all direct Supabase writes.

Some writes are admin-only or low-risk. Some may be acceptable for now. Some are already backed by database invariants. The point is to define a clear allowlist and move dangerous flows behind domain functions gradually.

The urgent one is Finding 1.

### Required Work

Create a mutation-boundary inventory and enforcement plan.

Recommended deliverable:

```txt
docs/audits/MUTATION_BOUNDARY_AUDIT.md
```

It should include a table:

| File | Table | Operation | User-facing flow | Risk | Keep / Move | Target owner |
|---|---|---|---|---|---|---|

Classify operations:

- P0: unsafe / bug-prone / must move now
- P1: should move before broader launch
- P2: acceptable for now but document
- Allowed: harmless/admin/config writes

Suggested canonical owners:

- `src/lib/bookings.ts`
- `src/lib/cycles.ts`
- `src/lib/registrations.ts`
- `src/lib/invoices.ts` or new invoice domain facades
- Supabase RPCs for transactional booking/payment/cycle operations
- Edge functions for side-effectful operations like payments/emails

### Suggested Immediate Refactors

Do these only where scoped and testable:

1. Fix public single-slot paid booking flow first.
2. Route booking paid/unpaid writes through `setBookingPaymentAndReconcile` where appropriate.
3. Route cancel/remove booking writes through `cancelBookingsAndSync` or equivalent.
4. Add invoice delete/cancel facades with guardrails:
   - do not hard-delete paid invoices
   - centralize draft delete vs non-draft cancel semantics
5. Add a test/lint guard to prevent new direct writes to high-risk tables from pages/components unless allowlisted.

High-risk tables:

- `bookings`
- `availability_slots`
- `cycles`
- `registrations`
- `invoices`
- `slot_priority_claims`
- `email_campaign_recipients`

### Acceptance Criteria

- There is a documented mutation boundary.
- Direct writes to high-risk tables are either moved or explicitly allowlisted.
- New tests/guardrails prevent accidental reintroduction.
- No broad behavior rewrite without tests.

## Finding 4: Deploy Checklist Still Has Owner-Pending Items

Severity: P1  
Category: production readiness, deploy safety  

### Why This Matters

The app auto-deploys frontend through Vercel, but Supabase migrations and edge functions do not always auto-deploy.

The repo can be correct while production is still stale.

The user's stated goal includes:

> No more "did we deploy the function?" uncertainty.

### Evidence

`audit/DEPLOY_CHECKLIST.md` still has unchecked items.

Observed around:

- `audit/DEPLOY_CHECKLIST.md:20`

Pending migrations:

- `20260630120000_phase4_C_cyclus_id_fk.sql`
- `20260630120100_phase4_E_invoices_booking_ids_gin.sql`
- `20260625120000_academy_invoice_email_message.sql`

Pending edge function deploy:

- `send-invoice-email`

Pending AI gateway replacement:

- set `AI_GATEWAY_BASE_URL`
- set `AI_GATEWAY_API_KEY`
- redeploy:
  - `enrich-clubs`
  - `scrape-academies`
  - `generate-proposals`
  - `generate-blog-article`
  - `translate-blog-article`
  - `generate-blog-cover`

Pending batch-job correctness/alert deploys:

- `recalculate-invoices`
- `generate-cycle-commitment-invoices`
- `send-digest-emails`
- `process-onboarding-emails`

### Required Work

Do not deploy unless the user explicitly asks and credentials are available.

But do update the repo docs/checklist so the owner can confidently deploy.

Tasks:

1. Reconcile `audit/DEPLOY_CHECKLIST.md` with the current merged code.
2. Make pending items clear:
   - which are required before broad launch
   - which are optional
   - which are already deployed
   - which are safe/additive
   - which need secrets first
3. Add exact commands for the owner.
4. Add dry-run instructions for migrations.
5. Add "stop if unexpected migration appears" instructions.
6. Add a verification section:
   - `supabase migration list`
   - `supabase functions list`
   - expected updated functions

### Acceptance Criteria

- The deploy checklist is current.
- It does not reference stale owner-pending items incorrectly.
- A human can execute it without guessing.
- It clearly distinguishes merged code from live production state.

## Finding 5: Docs Are Slightly Stale

Severity: P2  
Category: maintainability, AI-safety  

### Evidence

`docs/FRONTEND_ARCHITECTURE.md` is mostly up to date and says the role-isolation debt is resolved:

- `docs/FRONTEND_ARCHITECTURE.md:110`

But `docs/UI_COMPONENT_STANDARDS.md` still lists some completed items as follow-ups:

- shared date-picker/date field
- `EmptyState` vs `DashboardEmptyState`
- remaining role-neutral trainer/admin components

Observed around:

- `docs/UI_COMPONENT_STANDARDS.md:203`

### Required Work

Update docs after fixes.

Docs should clearly say:

- `DateInputField` is canonical for native date inputs.
- Raw `<Input type="date">` is blocked by lint.
- `ListPageShell`/`ListPageState` are canonical for list/table pages.
- `EmptyState variant="trainer"` replaces `DashboardEmptyState`.
- Cross-role imports from role folders are forbidden.
- Shared role-neutral components belong in neutral folders:
  - `components/booking`
  - `components/slots`
  - `components/agenda`
  - `components/players`
  - `components/dashboard`
- Any remaining direct mutation exceptions should be documented with an allowlist.

### Acceptance Criteria

- Docs do not ask future AI/devs to redo already-completed work.
- Docs accurately describe current canonical patterns.
- Docs point to current tests/guardrails.

## Verified Good Progress

Do not redo these unless verification on latest `main` disproves them.

### Component Role Isolation

Codex verified:

- no remaining `no-restricted-imports` suppressions
- no academy/club/player pages importing from `components/trainer`
- role-neutral trainer components moved into neutral folders

Examples now present:

- `src/components/agenda/CalendarSlotCard.tsx`
- `src/components/agenda/DayViewSlotCard.tsx`
- `src/components/agenda/TrainerCalendarGrid.tsx`
- `src/components/booking/BookForPlayerDialog.tsx`
- `src/components/booking/InlineBookPlayer.tsx`
- `src/components/booking/InlineEditBooking.tsx`
- `src/components/dashboard/UnpaidBookingsCard.tsx`
- `src/components/players/PlayerDetailsCard.tsx`
- `src/components/players/PlayerRemoveCard.tsx`
- `src/components/slots/AddSlotDialog.tsx`

### Shared Player Cards

Codex verified:

- shared `PlayerDetailsCard`
- shared `PlayerRemoveCard`
- trainer/academy wrappers are now thin wrappers

Relevant files:

- `src/components/players/PlayerDetailsCard.tsx`
- `src/components/players/PlayerRemoveCard.tsx`
- `src/components/trainer/TrainerPlayerDetailsCard.tsx`
- `src/components/trainer/TrainerPlayerRemoveCard.tsx`
- `src/components/academy/AcademyPlayerDetailsCard.tsx`
- `src/components/academy/AcademyPlayerRemoveCard.tsx`

### Date Input Guardrail

Codex verified:

- `src/components/ui/date-input-field.tsx` exists
- lint guard exists in `eslint.config.js`
- current raw `<Input type="date">` uses appear only inside the shared component with a local suppression

### List/Page Shell Adoption

Adoption has started:

- `src/pages/admin/AdminUsers.tsx`
- `src/pages/admin/AdminAcademies.tsx`
- `src/pages/academy/AcademyInvoices.tsx`
- `src/pages/academy/AcademyPlayers.tsx`
- `src/pages/academy/AcademyIntakeRequests.tsx`
- `src/pages/academy/AcademyTrainers.tsx`

This is not complete across the whole app, but the first phase is real.

## Foundation Roadmap Going Forward

After fixing the P0/P1 items above, continue with the user's broader roadmap.

### Phase 1: Finish Core Booking Domain Hardening

Scope:

- slots
- cycles
- registrations
- rebooking
- invoices
- webhooks
- public booking
- payment creation

Focus:

- make booking/payment state transitions single-owner
- prevent orphan pending bookings
- make payment creation idempotent
- make slot capacity enforcement impossible to bypass
- make invoice reconciliation consistent

Concrete next tasks:

1. Fix public single-slot online booking flow.
2. Audit all public booking paths:
   - free/manual booking
   - online single-slot booking
   - online cycle booking
   - approval-required booking
   - manual invoice booking
3. Ensure every path has:
   - capacity guard
   - correct status/payment_status
   - no orphan booking on payment failure
   - clear invoice behavior
   - tests
4. Verify Mollie retry/idempotency behavior.
5. Verify stale payment webhook no-downgrade behavior remains covered.

### Phase 2: Add Invariant / Database Tests

Goal:

Make impossible states impossible.

Add or verify tests for:

- slot cannot be overbooked
- paid booking cannot be downgraded
- stale webhook cannot change paid booking
- invoice cannot be marked paid unless linked active bookings are paid
- paid invoice cannot be hard-deleted
- player cannot mutate financial fields
- academy cannot see another academy's data
- rebooking dry-run has no side effects
- rebooking execution cannot double-run
- invitation/reminder send is idempotent/guarded
- public token flows expose minimal data

Use PGlite rehearsals where DB behavior matters.

### Phase 3: Move Dangerous Mutations Out Of UI

Goal:

Dangerous domain writes should live in tested domain services/RPCs/edge functions, not scattered across pages/components.

Target architecture:

```text
UI
  -> typed domain action in src/lib/*
    -> RPC or Edge Function where transaction/side-effect matters
      -> database constraints/RLS/triggers
```

Create:

- `docs/audits/MUTATION_BOUNDARY_AUDIT.md`
- optional script/test that detects direct writes to high-risk tables from disallowed folders

Potential canonical modules:

- `src/lib/bookings.ts`
- `src/lib/cycles.ts`
- `src/lib/registrations.ts`
- `src/lib/invoices.ts`
- `src/lib/payments.ts`
- `src/lib/emailCampaigns.ts`

### Phase 4: Clean Up Shared Components

Goal:

When a component/pattern is updated, all roles benefit.

Continue adoption of:

- `AppPage`
- `PageHeader`
- `ListPageShell`
- `ListPageState`
- `DataTableCard`
- `TableToolbar`
- `EmptyState`
- `DateInputField`
- shared booking dialogs
- shared calendar/agenda components
- shared player cards/forms
- shared invoice components

Next likely targets:

- remaining list/table pages not using `ListPageShell`
- remaining hand-rolled table cards/toolbars
- shared calendar/slot card base if variants still diverge
- invoice settings convergence if still split
- fat page extraction only where it improves reuse/testability

Do not refactor for size alone. Refactor where it reduces duplicated behavior or creates a safer canonical pattern.

### Phase 5: Run Performance / Index Audit

Goal:

Make high-volume pages safe at 100,000+ bookings.

Audit with query shape and indexes:

- academy calendar
- trainer calendar
- academy cycle overview
- trainer schedule overview
- bookings lists
- invoice lists
- registration/intake lists
- player lists
- dashboard summary queries

Look for:

- unbounded selects
- client-side aggregation over large datasets
- N+1 queries
- missing tenant/date/status indexes
- RLS performance issues
- `.select('*')` on hot paths
- pagination missing
- count queries that scan too much

Deliverable:

```txt
docs/audits/PERFORMANCE_INDEX_AUDIT.md
```

Include:

- query
- source file
- expected scale
- current indexes
- risk
- fix
- whether a migration is needed

### Phase 6: Add Observability And Alerts

Goal:

Bugs should become visible and recoverable.

Verify/extend:

- client error capture
- edge function Slack/PostHog alerts
- failed invoice creation alerts
- failed payment webhook alerts
- failed campaign/email alerts
- failed cron/batch partial-failure alerts
- release/deployment tagging
- source maps if using a dedicated error platform
- daily business health checks

Important:

Do not assume "logs exist" is enough. Ask:

- Who gets alerted?
- What is the severity?
- Which academy/player/booking/invoice was affected?
- Is there a retry/recovery path?

Deliverable:

```txt
docs/audits/OBSERVABILITY_AND_ALERTING_AUDIT.md
```

### Phase 7: Add Staging + Deploy Safety

Goal:

No more uncertainty around manual Supabase deploys.

Need:

- clear staging environment
- migration dry-run process
- edge function deploy process
- function version verification
- rollback plan
- production deploy checklist
- ownership of manual deploys
- drift detection between repo and production
- smoke tests after deploy
- backup and restore drill

Deliverable:

```txt
docs/DEPLOYMENT_AND_RELEASE_SAFETY.md
```

At minimum, improve:

- `audit/DEPLOY_CHECKLIST.md`

## Required Checks Before Final Response

Run:

```bash
npm run lint
npx tsc --noEmit
npm run build
npx vitest run
npm run check:edge-config
npm run db:rehearse:all
```

Run if possible:

```bash
npm run i18n:check
```

If `bun` is missing, either install/use the project-approved runtime or document clearly that this check could not run.

If touching edge functions:

```bash
deno check supabase/functions/<function>/index.ts
```

If touching migrations/DB behavior, run relevant PGlite rehearsal scripts and update `npm run db:rehearse:all` if adding a new invariant.

## Final Response Requirements For Claude

Report:

1. Branch name.
2. Findings verified.
3. Findings disproved, if any.
4. Files changed.
5. Tests added/updated.
6. Commands run and results.
7. Any checks that could not run and why.
8. Remaining risks.
9. Whether this is safe to merge.
10. What should be done in the next phase.

Be explicit about whether production still needs manual migrations or edge-function deploys.

## Important Guardrails

- Do not deploy production.
- Do not run live side-effecting functions.
- Do not send real emails.
- Do not trigger live rebooking.
- Do not rewrite unrelated UI while fixing domain issues.
- Prefer small, testable changes.
- Do not mark the foundation "done" while tests are red.
- Do not claim production is updated unless Supabase production was actually checked/deployed.

## Codex Verdict

The foundation is much stronger than before, especially on component reuse and database rehearsals.

But before moving forward, Claude should fix:

1. public single-slot online booking double-insert/orphan-pending risk
2. red Vitest suite
3. mutation-boundary overstatement / missing allowlist
4. stale deploy checklist/live-production ambiguity
5. stale docs

After that, continue the roadmap:

1. finish core booking domain hardening
2. add invariant/database tests
3. move dangerous mutations out of UI
4. clean up shared components
5. run performance/index audit
6. add observability and alerts
7. add staging/deploy safety

