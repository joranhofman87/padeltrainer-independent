# Domain model & write boundaries

> Canonical map of padeltrainer's 14 domains: for each, the key tables, UI, `src/lib` modules, edge
> functions / RPCs, dangerous mutations, and load-bearing invariants. **Read this before changing any
> scheduling, registration, booking, or invoicing code** — several money/data rules here have been the
> subject of real bugs (stale billing, double-billing, cascade booking loss, paid→pending downgrades).
> When in doubt, route a write through the canonical function named below rather than a raw
> `supabase.from(...).insert/update/delete`.

**Audience / AI-read: yes** — this is the backbone other docs reference.
**Status: canonical (source of truth) | last updated 2026-07-18**

Related: [`EXTENDING_THE_DOMAIN.md`](./EXTENDING_THE_DOMAIN.md) (change playbook + PR checklist + test
matrix), [`SCHEDULING_ARCHITECTURE.md`](./SCHEDULING_ARCHITECTURE.md) (academy-first UX strategy),
[`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) (component/role isolation),
[`payments/`](./payments/) (payment flow map + invariants + recovery runbook),
[`adr/`](./adr/) (the *why*), [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](./audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md)
(latest audit; P0 + 7 P1 fixed & deployed).

---

## Core scheduling spine (read first)

Everything in the money path hangs off one chain. **Slot is the price source of truth; invoices reference
bookings by array with no FK, so reconciliation is always explicit.**

```
registrations ──source_cycle_id──▶ cycles(type='cyclus') ──cyclus_id──▶ availability_slots ──slot_id(CASCADE)──▶ bookings
      ▲                                  ▲                                                                         │
      │ registration_id (additive)       │ cycle_id (load-bearing)                                                 │ booking_ids[] (NO FK)
 intake_requests ──intake_request_id──▶ proposed_assignments                                                      ▼
                                                                                                              invoices
```

- **Slot** owns `price_per_session`, `split_payment`, VAT flag, time, location. `bookings.slot_id` is
  `ON DELETE CASCADE` — deleting a slot destroys its bookings.
- **Invoices** reference bookings via `booking_ids uuid[]` with **no FK** → a cancelled/deleted booking is
  NOT auto-removed; every mutation that changes bookings/price must call a `sync*` helper.
- **registrations ↔ cycles split** (Phase 2/4, LIVE): a form is a `registrations` row whose `source_cycle_id`
  points at a paired `type='cyclus'` cycle shell. `intake_requests`/`invoices` keep `cycle_id` (training link)
  + additive `registration_id` (form link). `id = source_cycle_id` in `registrationToCycle` is intentional.

---

## 1. auth / users / roles

| | |
|---|---|
| **Purpose** | Identity + role gating across the 5 personas. |
| **Key tables** | `profiles`, `user_roles` (enum `app_role`: `player`, `trainer`, `academy_manager`, `club_manager`, `admin`), `academy_managers`, `club_managers`. |
| **UI** | `src/pages/Auth.tsx`, `PlayerSignup/TrainerSignup/AcademySignup/ClubSignup.tsx`, `ProfileSwitcher.tsx`, `DomainRouter.tsx`, `LanguageRouter.tsx`. |
| **lib** | `src/lib/auth.ts` (role/timezone resolution), `appBootstrap.ts`, `adminStatus.ts`, `admin.ts`. |
| **Edge/RPC** | `signup-user`, `complete-oauth-signup`, `send-auth-email`, `toggle-player-role`, `impersonate-user`, `delete-user`, `request-account-deletion`; RPC `has_role(uid, role)` (SECURITY DEFINER — the RLS building block). |
| **Dangerous** | `impersonate-user` / `admin-reset-password` (privileged); any RLS policy that stops calling `has_role` invites cross-tenant reads. |
| **Invariants** | (1) RLS gates every tenant read/write via `has_role`; anon public pages must use postgres-owned `_public`/`_safe` views, never base-table anon SELECT. (2) A user may hold multiple roles; UI role is chosen, not exclusive. |
| **Tests** | `src/lib/auth.test.ts`, `src/test/migrationsBookingsRls.test.ts`, `supabase/functions/rls-smoke-test`. |

## 2. academies

| | |
|---|---|
| **Purpose** | Academy tenant: profile, locations, trainers, players, billing settings. |
| **Key tables** | `academy_profiles`, `academy_locations`, `academy_trainers`, `academy_trainer_invitations`, `academy_managers`, `academy_followers`, `academy_profile_views`, `academy_player_metadata`, `academy_player_tags`, `academy_player_locations`, `academy_stripe_accounts`. |
| **UI** | `src/pages/academy/*` (Dashboard, Settings, Players, Trainers, Locations, Profile, Subscription), `src/components/academy/*` (`AcademyLayout`, `AcademySidebar`, `AcademyInvoiceSettingsCard`, `AcademyMolliePaymentCard`). |
| **lib** | `academy.ts`, `academyVisibility.ts`, `academyMollieSettingsState.ts`, `academyPayments.ts`, `academyPlayerBulk.ts`, `academyPlayerDetails.ts`, `academyPlayerRemoval.ts`, `academySubscription.ts`. |
| **Edge/RPC** | `create-academy-profile`, `create-academy-trainer`, `academy-update-player-email`, `mollie-connect-academy`, `mollie-disconnect-academy`, `check-mollie-connect-status`. |
| **Dangerous** | Player soft-removal is metadata-driven (see §5); Mollie routing must use the *academy's* connected account (P1-9, fixed). |
| **Invariants** | (1) Per-player academy data (notes/tags/preferred location/soft-removal) lives in `academy_player_metadata`, one row per **legacy seat**: keyed `(academy, guest_player_id XOR profile_id)` (row CHECK) plus a derived `person_id` stamp — the person is the canonical identity, the guest/profile key is the transitional dual-write layer (see §5). (2) Only academy + trainer create/edit scheduling; **clubs are read-only**. |
| **Tests** | `academyVisibility.test.ts`, `academyMollieSettingsState.test.ts`, `academyPayments.test.ts`, `AcademyPlayers.actions.test.tsx`. |

## 3. trainers

| | |
|---|---|
| **Purpose** | Trainer tenant + trainer-under-academy/club relationships; parity surface to academy scheduling. |
| **Key tables** | `trainer_profiles`, `trainer_locations`, `trainer_working_hours`, `trainer_followers`, `trainer_profile_views`, `trainer_onboarding`, `trainer_onboarding_responses`, `trainer_stripe_accounts`, `certifications`, `specializations`. |
| **UI** | `src/pages/trainer/*` + top-level `Trainer*.tsx` (Dashboard, Calendar, Cycles, Players, Invoices, Earnings, Settings, Onboarding), `src/components/trainer/*` (`InlineBookPlayer` moved to `components/booking`). |
| **lib** | `trainerInvoices*`, `academyTrainerPayments.ts`, `certifications.ts`; shares the scheduling libs (`bookingPricing`, `cycles`, `bookings`). |
| **Edge/RPC** | `create-academy-trainer`, `create-club-trainer`, `create-admin-trainer`, `mollie-connect-trainer`. |
| **Dangerous** | Trainer `price_per_hour` column is **load-bearing** (price fallback + onboarding gate + payroll) even though removed from public display — do not drop. |
| **Invariants** | (1) Trainer path mirrors academy scheduling via shared `src/lib` helpers; layout differs, business rules don't. (2) Role-isolation ESLint restricts `player/**` imports; `players/**` is shared. |
| **Tests** | `TrainerDashboard.visibility.test.ts`, `TrainerPlayers.visibility.test.ts`, `TrainerEditInvoice.cards.test.tsx`. |

## 4. clubs

| | |
|---|---|
| **Purpose** | Club tenant (venues + tournaments); **read-only for scheduling**. |
| **Key tables** | `club_profiles`, `club_managers`, `club_trainer_invitations`, `club_followers`, `club_players`, `club_profile_views`, `club_tournaments`, `club_stripe_accounts`. |
| **UI** | `src/pages/club/*` (Dashboard, Calendar, Cycles, Players, Trainers, Tournaments, Settings), `src/components/club/*` (`ClubLayout`, `ClubSidebar`, `ClubSlotDetailSheet`, `ClaimClubDialog`). |
| **lib** | `club.ts`, `clubProfileViews.ts`, `clubSubscription.ts`. |
| **Edge/RPC** | `claim-club-profile`, `create-club-trainer`, `enrich-clubs`, `scrape-academies`. |
| **Dangerous** | None club-owned in the money path — the invariant is that no create/edit surfaces exist. |
| **Invariants** | (1) Clubs are read-only over slots/cycles/bookings; RLS may be symmetric but there must be no club write UI. |
| **Tests** | `club.test.ts`, `ClubSidebar.test.tsx`. |

## 5. players / guest-players / persons

| | |
|---|---|
| **Purpose** | The learner identity domain. **Canonical model: one `persons` row per human** — "has a login" is simply `persons.user_id IS NOT NULL` — mapped over the two legacy identities (`profiles` = account holder, `guest_players` = trainer/academy-managed, possibly no account) via the `person_links` identity map. The legacy `player_id`/`guest_player_id` columns stay as the **transitional dual-write layer**; Phase 4 of [`PERSON_UNIFICATION_PLAN.md`](./PERSON_UNIFICATION_PLAN.md) contracts them. |
| **Key tables** | `persons`, `person_links` (`profile_id` UNIQUE, `guest_player_id` UNIQUE, exactly-one-source CHECK, one-profile-per-person partial index), `person_merge_review` (owner sign-off queue) — all three RLS-enabled with **zero policies BY DESIGN** (definer/service-only; `supabase/migrations/20260826260000_persons_expand.sql`, `…280000_persons_backfill.sql`). Person ids are **deterministic** (an absorbed profile/guest keeps its old uuid as its person id). Legacy: `guest_players` (`twin_of_profile_id` = explicit manager-asserted twin stamp; `linked_profile_id` is email-inferred and **NEVER identity truth** — the twin bridge retires at Phase 4), `player_locations`, `academy_player_metadata` (per-academy overlay), `player_rating_history`, `user_discounts`, `waiting_list_entries`. |
| **UI** | `src/pages/{PlayerDashboard,PlayerAgenda,PlayerBookings,PlayerInvoicesPage,PlayerJourney}.tsx`, `AcademyPlayers.tsx`/`AcademyPlayerDetail.tsx`, `src/components/players/*` (shared) vs `src/components/player/*` (player-role-only, ESLint-restricted). |
| **lib** | **`personIdentity.ts` — the single TS home of the person rule** (`personKeyOf`/`unifiedPersonKeyOf`/`personRefOf`/`matchBookingsToPerson`/`personDisplayName`), `guestPlayers.ts`, `academyPlayersQuery.ts`, `academyPlayerDetails.ts`, `signupClaimFlow.ts` (guest→account claim), `mapPlayersOverviewRow` / `UnifiedPlayer`. |
| **Edge/RPC** | `create-manual-player`, `create-guest-slot-payment`, `create-guest-cyclus-payment`, `get-guest-booking`, `submit-guest-intake`; RPC `merge_guest_players` (twin-aware, data-loss-safe — the **only** same-person reconcile path, hardened P1-3); person-keyed readers (Phase 3.x): `get_my_person_id`, `get_cycle_roster_names`, `get_players_overview` (person-dedup), `get_person_refs_for_scope` (+`has_login`), `get_my_linked_guest_bookings`/`get_my_paid_booking_ids`/`get_my_pending_priority_claims`, `can_book_member_window`, `can_report_attendance_on_slot`, `is_guest_split_frozen`. |
| **Dangerous** | Never treat `linked_profile_id` (or a bare email match) as identity — reconcile same-person duplicates only via `merge_guest_players`. Never write `person_id` columns directly — they are derived (invariant 2). Guest→profile linking outside the hardened RPC can lose booking/invoice history. |
| **Invariants** | (1) **FAM-02**: guests and profiles are DISTINCT people unless `person_links` says otherwise, and a **dual-keyed row** (`player_id` + `guest_player_id` both set — written by the historical signup linker, exists by design) **belongs to the GUEST person**. Ownership predicates (player RLS on bookings/invoices) therefore carry pure-profile guards (`player_id = me AND guest_player_id IS NULL`); relationship-visibility helpers (`is_player_of_trainer`/`is_player_of_academy`) deliberately do not. (2) The `person_id` columns on the 7 dual-keyed tables (9 column-pairs) are **pure derived data**: `stamp_person_id_*` SECURITY DEFINER triggers recompute them guest-first from `person_links` on every keyed write — a client-supplied value is re-derived, never trusted. (3) **Split-freeze**: a guest with a pending `twin_detached_needs_split`/`merged_guest_email_moved` review (`is_guest_split_frozen`) reads as its OWN person — every person arm/path is freeze-gated on both the inbound and the candidate side until the owner resolves the `person_merge_review` row. (4) Delete of an academy player is a **soft remove** (reversible metadata flag), not a row delete. |
| **Tests** | `personIdentity.test.ts`, `academyPlayerRemoval.test.ts`, `signupClaimFlow.test.ts`, `guestPlayers`-related tests, `AdminGuestPlayers.tsx`. |

## 6. slots

| | |
|---|---|
| **Purpose** | One scheduled session. **Source of truth for price + split.** |
| **Key tables** | `availability_slots` (`price_per_session`, `split_payment`, VAT flag, location, time, `cyclus_id` → cycles NOT-VALID FK), `dismissed_slot_warnings`. |
| **UI** | `AcademyCreateSlot.tsx`/`TrainerCreateSlot.tsx`, `AcademyGenerateSlots.tsx`, `AcademyBulkCopySlots.tsx`, `AcademySlotDetail.tsx`/`TrainerSlotDetail.tsx`, `src/components/slots/*`, `SlotDetailDialog.tsx`, `BulkCopySlotsWizard.tsx`. |
| **lib** | `academyCreateSlot.ts`, `bulkCreateSlot.ts`, `slotDeleteGuard.ts`, `slotPlan`/`agendaSlots.ts`, `cycles.ts` (edit/price RPC wrappers), `cycleWrites.ts`. |
| **Edge/RPC** | RPCs `apply_slot_delete_to_cycle`, `apply_slot_edit_to_cycle`, `update_cycle_pricing`, `book_slot_for_payment`. |
| **Dangerous** | **Deleting a slot cascade-destroys its bookings.** Never raw-`delete()` a slot — use `applySlotDeleteToCycle` (`src/lib/slotDeleteGuard.ts`), which locks bookings `FOR UPDATE`, keeps slots holding an occupying booking, deletes the rest atomically. Cancel+sync bookings *first* if you must delete a booked slot. |
| **Invariants** | (1) Slot is the price truth — never read price from cycle/registration. (2) Slot deletes are cascade-aware + atomic (no client check-then-delete → TOCTOU). |
| **Tests** | `src/test/applySlotDeleteToCycle.test.ts`, `scripts/db/rehearse-apply-slot-delete.mjs`, `applySlotEditToCycle.test.ts`, `bulkCreateSlot.test.ts`. |

## 7. cycles

| | |
|---|---|
| **Purpose** | The training container grouping a cycle's slots→bookings→invoices; also holds TRAINING-only `settings`. |
| **Key tables** | `cycles` (`type` in `cyclus`/registration/event; `settings.scoring_weights` etc.), grouped via `availability_slots.cyclus_id`. There is **no group entity** — a "cyclus group" is just the slots sharing a `cyclus_id`. |
| **UI** | `CycleFormPage.tsx`, `AcademyCycleDetailView.tsx`/`TrainerCycleDetailView.tsx`, `AcademyCyclusOverview.tsx`, `AcademySessions.tsx`/`TrainerSessions.tsx`, `src/components/cycles/*` (`CycleDetailView`, `CycleForm`, `CyclePricingCard`, `CycleRosterInlinePicker`, `DeleteCycleDialog`, `AcademyNewRoundWizard`). |
| **lib** | `cycles.ts`, `cycleDetail.ts`, `cycleEditPatch.ts`, `cycleRoster.ts`, `cyclePricing.ts`, `cycleExtension.ts`, `cycleTypes.ts`, `cycleMappers.ts`, `cyclusGroupPayment.ts`, `cyclusLabel.ts`. |
| **Edge/RPC** | RPCs `apply_slot_edit_to_cycle`, `update_cycle_pricing`; `generate-cycle-commitment-invoices`. |
| **Dangerous** | Whole-cycle slot edit / price change must go through `applySlotEditToCycle` / `updateCyclePricing` (atomic, row-locking); these only stamp `invoices.split_count` — caller must then `syncSplitCountForCycle` / `syncInvoicesAfterPriceChange`. |
| **Invariants** | (1) Split divisor = the group sharing the slot, not whole-cycle headcount (pass `splitAmongPlayers = N`). (2) TRAINING settings stay on cycle; FORM settings live on `registrations` (partitioned by the frozen `settingsSplit` allowlist). |
| **Tests** | `cycles.test.ts`, `cycleDetailView.test.tsx`, `cycleDetail.test.ts`, `scripts/db/rehearse-cycle-pricing-*`, `rehearse-recalc-split.mjs`. |

## 8. registrations / intakes

| | |
|---|---|
| **Purpose** | The intake **form** (sign-up campaign) + its submissions and draft proposals. |
| **Key tables** | `registrations` (form config, FORM-only `settings`, `price_table`, `source_cycle_id` 1:1 → cycles shell), `intake_requests` (`cycle_id` load-bearing + additive `registration_id`), `proposed_assignments` (`intake_request_id`). |
| **UI** | `CycleRegistration.tsx`/`BrandedCycleRegistration.tsx` (public), `AcademyRegistrations.tsx`, `AcademyIntakeRequests.tsx`, `ProposalOverviewPage.tsx`, `src/components/cycles/*` (`CycleApplicationForm`, `IntakeRequestsTable`, `GenerateProposalsWizard`, `ProposalCard`, `PreGenerationReview`). |
| **lib** | `registrations.ts` (`createRegistration`/`updateRegistration`, `pickFormSettings`), `cycleIntakeReads.ts`, `cycleProposalAssignments.ts`, `cycleProposalSlots.ts`, `intakeCsv.ts`, `registrationToCycle`. |
| **Edge/RPC** | `submit-guest-intake`, `generate-proposals`, `finalize-proposals`; RPCs `create_registration_with_cycle`, `update_registration_with_cycle`, `finalize_cycle_proposals`. |
| **Dangerous** | `generate-proposals` was unauthenticated (fixed); registration pricing is **server-trusted** (never accept client price) to avoid €0/underpay. |
| **Invariants** | (1) Form create/edit is atomic (mint/adopt the cyclus shell + registration in one RPC, `ON CONFLICT (source_cycle_id)`). (2) Registration price ≡ invoice ≡ confirmation-email (computed in three places — keep them in sync). |
| **Tests** | `src/test/registrations.test.ts`, `settingsSplit.golden.test.ts`, `scripts/db/rehearse-registration-write.ts`, `registration-pricing.golden.test.ts`. |

## 9. bookings

| | |
|---|---|
| **Purpose** | A player/guest on a slot; the unit invoices bill and capacity counts. |
| **Key tables** | `bookings` (`status`: pending/confirmed/cancelled/completed; `payment_status`: pending/paid/refunded/waived), `lessons`. |
| **UI** | `src/components/booking/*` (`InlineBookPlayer`, `InlineEditBooking`, `BookForPlayerDialog`, `GuestBookingDialog`, `SkipInvoiceUpdatesCheckbox`), `AcademySlotDetail.tsx`, `BookLesson.tsx`, `OpenSlots.tsx`, `BookingSuccess.tsx`. |
| **lib** | **`bookings.ts` (`cancelBookingsAndSync`) — the canonical cancel entry point**, `bookForPlayerBooking.ts`, `bookingPricing.ts`, `bookingFlags.ts`, `bulkCycleBookings.ts`, `invoiceAfterAddPlayer.ts` / `addPlayerInvoiceFlow.ts`. |
| **Edge/RPC** | `book_slot_for_payment` RPC, `create-*-slot-payment`, `sync-invoice-to-bookings`; write-back via `applyBookingPaymentWriteback` (`_shared/mollie-webhook-payment.ts`). |
| **Dangerous** | **Never hard-delete a booking** (loses history + orphans invoice `booking_ids` + cascade-unsafe). Remove via `cancelBookingsAndSync(ids)` → soft-cancel + invoice reconcile. A bare `update({status:'cancelled'})` without sync = **stale billing**. |
| **Invariants** | (1) Soft-cancel only; a `cancelled` booking never occupies a seat (capacity set = `CAPACITY_OCCUPYING_STATUSES` in `src/lib/lessons.ts`) and is exempt from `uniq_active_booking_per_slot_{player,guest}`. (2) A paid booking is never downgraded by any webhook. |
| **Tests** | `bookings.test.ts`, `invoiceSync.pglite.test.ts`, `bookingFinancialGuard.test.ts`, `scripts/db/rehearse-capacity-locks.mjs`. |

## 10. rebooking / priority-claims

| | |
|---|---|
| **Purpose** | Prior-cohort players (a group captain) re-book the whole group for a new round + pay once; consent to rules on the claim/pay page. |
| **Key tables** | `slot_priority_claims` (`reminded_at`, consent record), rebook metadata on `cycles`, `invoices` (group-payment links). |
| **UI** | `PriorityClaim.tsx` (public claim/pay), `AcademyRebookCohort.tsx`, `AcademyRebookManage.tsx`, `src/components/cycles/*` (`AcademyNewRoundWizard`, `PriorityClaimsSection`, `AddGroupMemberFields`, `RebookRulesField`), `RichTextConsent`. |
| **lib** | `rebookManage.ts`, `priorityClaims.ts`, `rebookPaymentEligibility.ts`, `rebookRules.ts`, `signupClaimFlow.ts`, `invoiceClaimTracking.ts`. |
| **Edge/RPC** | `bulk-rebook-cycle`, `send-priority-claim-invitation`, `send-rebook-reminder`, `send-rebook-group-confirmation`, `create-rebook-invoice`(+`-public`), `create-group-rebook-invoice`; RPCs `rebook_group_apply`, `expire_lapsed_priority_claim` (cron). |
| **Dangerous** | Group payment linchpin = the Mollie webhook flipping *all* linked invoice `booking_ids` to paid; guest-mint on claim must stay rate-limited. Always full price (don't flip slot `split_payment` — overcharges the deferred fallback). |
| **Invariants** | (1) Whole-group captain model: one member books + pays for all; release only on whole-cycle abandonment. (2) Rules gate — if a cycle has rules, claim requires recorded consent; degrades to unchanged behavior if none. |
| **Tests** | `rebookManage.test.ts`, `priorityClaims.test.ts`, `PriorityClaim.consent.test.tsx`, `scripts/db/rehearse-rebook-group-claims.ts`. |

## 11. invoices / payments

| | |
|---|---|
| **Purpose** | Bill sets of bookings; collect via Mollie (OAuth connected accounts) or bank/manual fallback. |
| **Key tables** | `invoices` (`booking_ids uuid[]` **no FK**, `split_count`, `cycle_id` + additive `registration_id`), `invoice_status_history`, `payment_audit_log`, `mollie_oauth_states`, `extra_cost_presets`. |
| **UI** | `AcademyCreateInvoice.tsx`/`AcademyEditInvoice.tsx` (+ trainer twins), `AcademyInvoices.tsx`/`TrainerInvoices.tsx`, `PlayerInvoicesPage.tsx`, `PublicInvoicePay.tsx`, `MollieCallback.tsx`, `src/components/invoices/*` (`UpdateAffectedInvoicesDialog`). |
| **lib** | `invoiceSync.ts` (recalc), `invoiceCalc.ts`, `invoiceNumber.ts`, `affectedInvoices.ts`, `applyAffectedInvoiceUpdates.ts`, `invoiceUpdateChoice.ts`, `cyclePayment.ts`, `academyPayments.ts`, `supabasePaging.ts` (shared paging helper, P1-7). |
| **Edge/RPC** | `auto-create-invoice` (pass `splitAmongPlayers=N`), `create-mollie-payment`, `mollie-webhook`, `verify-mollie-payment`, `create-invoice-payment`, `split-invoice`, `recalculate-invoices`, `generate-invoice`/`send-invoice-email`/`forward-invoice`; RPCs `create_invoice_deduped` (P1-6), `reconcile_payments` (read-only), invoice-numbering RPC. |
| **Dangerous** | No FK on `booking_ids` → every cancel/remove/price change **must** call the matching `sync*`. (The G2 Mollie idempotency-key shipped — `_shared/mollie-idempotency.ts`; corrected 2026-08-08.) Payment write-back guard `payment_status != 'paid'` is unconditional (idempotency + no-downgrade). |
| **Invariants** | (1) Invoices reconcile whenever their bookings or price change (no stale billing). (2) Split divisor = group-per-slot, not whole cycle. (3) A paid booking is never downgraded. See [`payments/`](./payments/) for the 15 money invariants. |
| **Tests** | `invoiceSync.pglite.test.ts`, `mollieWebhookWriteback.pglite.test.ts`, `mollieWebhookPayment.test.ts`, `scripts/db/rehearse-m10-invoice-numbering.ts`, `autoCreateInvoicePolicy.test.ts`. |

## 12. emails / notifications

| | |
|---|---|
| **Purpose** | Transactional + campaign email (Resend), onboarding drip, in-app/queue notifications, Slack ops alerts. Push/OneSignal is **disabled for launch (email-only)**. |
| **Key tables** | `email_campaigns`, `email_campaign_recipients`, `email_campaign_templates`, `email_delivery_events`, `email_address_state`, `onboarding_email_{queue,templates,logs}`, `notification_queue`, `notification_sends`, `notification_preferences`, `notifications`. |
| **UI** | `NotificationSettings.tsx`, `src/components/email/*` (`EmailMessageField`), `AdminOnboardingEmails.tsx`, academy player email history views. |
| **lib** | `email.ts`, `emailBounce.ts`, `academyPlayerEmailHistory.ts`. |
| **Edge/RPC** | `send-email`, `send-campaign-emails`, `send-digest-emails`, `send-invoice-email`, `send-auth-email`, `process-onboarding-emails`, `trigger-welcome-emails`, `notify-followers`, `send-schedule-notifications`, `resend-webhook`, `backfill-email-bounces`, `slack-notify` (edge silent-failure alerts via `notifySlackEdge*`). Push fns (`send-push*`) exist but are inert. |
| **Dangerous** | Campaign sends need idempotency + resume (deep-escape user content); telemetry/logging carry IDs + technical metadata only (privacy hardening) — do not log PII. |
| **Invariants** | (1) The registration-confirmation email is composed in **two** places (client self-reg + server `submit-guest-intake`) — keep both in sync (public form = server path). (2) Email price ≡ invoice ≡ registration price. |
| **Tests** | `academyPlayerEmailHistory.test.ts`, `db:rehearse:email`; edge `_shared` email tests via `npm run test:edge`. |

## 13. public-marketing / SEO

| | |
|---|---|
| **Purpose** | Public tenant pages + SEO/LLM discovery; Cloudflare worker bot-prerender. Content in Sanity + DB. |
| **Key tables** | `articles`, `content_topics`, `sources`, `internal_links`, `locations`, `location_translations`, `slug_redirects`, `reviews`/`court_reviews`, `banner_*`, `rating_systems`. |
| **UI** | `src/pages/marketing/*` (Home, Blog, City/Coach landing, RacketFinder, quizzes), `AcademyPublicProfile.tsx`, `TrainerProfile.tsx`, `LocationDetail.tsx`, `src/components/{seo,home,marketing,locations}/*`, `SEO.tsx`. |
| **lib** | `blog.ts`, `cities.ts`, `cityContent.ts`, `certifications.ts`, `analyticsPagePath.ts`, `cycleRegistrationUrl.ts`. |
| **Edge/RPC** | `render-page` (bot prerender), `sitemap`, `llms-full-txt`, `og-image`/`rating-og-image`, `generate-blog-*`, `process-blog-queue`, `translate-blog-article`, `geocode-locations`, `fetch-location-logos`, `public-api`, `get-public-rating`. |
| **Dangerous** | Anon public reads must use postgres-owned `_public`/`_safe` views (RLS hardening keeps dropping anon base-table SELECT → silent empty pages). Global `X-Frame-Options: DENY` blocks embeds. |
| **Invariants** | (1) Bot-prerender passes through real 404/503 (no soft-404 200s). (2) Public price display no longer shows trainer per-hour rate. |
| **Tests** | `analyticsPagePath.test.ts`, `cities.test.ts`, `seo-smoke.yml`, `sitemap.yml` CI. |

## 14. admin / operations

| | |
|---|---|
| **Purpose** | Internal tooling: user/tenant admin, backups, health checks, subscriptions/billing, impersonation, cron. |
| **Key tables** | `admin_impersonation_logs`, `rate_limits`, `subscription_plans`, `subscription_payments`, `stripe_webhook_events`, `*_stripe_accounts`, `payment_audit_log`, `notification_queue` (cron-driven). |
| **UI** | `src/pages/admin/*` (Users, Academies, Clubs, Trainers, GuestPlayers, Pricing, Backups, Blog*, Locations, RatingSystems), `AdminDashboard.tsx`. |
| **lib** | `admin.ts`, `adminStatus.ts`, `impersonate`-related helpers. |
| **Edge/RPC** | `get-admin-stats`, `backup-database`, `bulk-cleanup-users`, `health-check`, `invoice-health-check`, `impersonate-user`, `admin-reset-password`, `create-stripe-checkout`, `stripe-subscription-webhook`, `customer-portal`, `cancel-stripe-subscription`, `reditus-referral-*`; pg_cron for reminders/expiry/digests. |
| **Dangerous** | Impersonation, bulk-cleanup, backups are service-role privileged; edge fns run `verify_jwt=false` and each self-authenticates via `_shared/auth.ts` (forged-JWT service-role bypass was the audit P0 — now fixed). |
| **Invariants** | (1) Every edge fn authenticates its caller in `_shared/auth.ts`; never trust the JWT claim alone for service-role escalation. (2) Cron jobs (claim expiry, reminders, digests) must be idempotent + heartbeat-monitored. |
| **Tests** | `rls-smoke-test`, `get-admin-stats`/`health-check` fns; observability alerts via `slack-notify`. |

---

## Cross-cutting invariants (the load-bearing seven)

1. **Soft-cancel, never hard-delete a booking** (§9) — preserves history + avoids cascade/orphan.
2. **A paid booking is never downgraded** by any webhook (`payment_status != 'paid'` guard).
3. **Invoices reconcile when bookings/price change** — no FK on `booking_ids`, so `sync*` is mandatory.
4. **Split divisor = group-per-slot**, not whole-cycle headcount (`splitAmongPlayers = N`).
5. **Deleting a slot can cascade-destroy bookings** — always `applySlotDeleteToCycle`; cancel+sync first.
6. **Only academy + trainer create/edit; clubs are read-only.**
7. **Additive, non-destructive migrations only** in the money domain.

## Deploy & CI notes

- Edge functions + migrations do **not** auto-deploy — owner applies manually (CI only validates). Frontend
  auto-deploys via Vercel on merge to main.
- Real schema gate is `supabase db reset`; the generated-types-drift CI gate is **green** (stale perma-red
  note corrected 2026-08-07, CLI pinned 2.107.0) — ship regenerated `types.ts` with the migration or pull
  the CI `types-generated` artifact; do not merge `--admin`.
- `intake_requests.status` CHECK is drifted (migration lacks `'booked'` that prod + `finalize-proposals` use).
- Root `tsc --noEmit` checks **nothing** (`files:[]`); the real typecheck gate is `typecheck:baseline`
  (`tsc -p tsconfig.app.json` ratcheted vs `scripts/tsc-app.baseline.json`).
- See [`EXTENDING_THE_DOMAIN.md`](./EXTENDING_THE_DOMAIN.md) for the full gate list, PR checklist, and
  critical-flow test matrix.

## Short links (`/s/<code>`)

Generic branded short-link primitive — full architecture in [`SHORT_LINKS.md`](./SHORT_LINKS.md).
- **Tables:** `short_links` (RLS ON, no policies — reached only via RPCs).
- **RPCs:** `get_or_create_short_link` (mint, idempotent, `authenticated` only, open-redirect-guarded),
  `resolve_short_link` (read, `anon`, no writes), `get_short_codes` (batch reverse lookup).
- **lib:** `shortLinks.ts` (mint/read), `cycleRegistrationUrl.ts#shareUrlForRegistration` (the single
  share-URL decision), `domains.ts#getShortUrl`.
- **Edge:** Cloudflare Worker `/s/` branch (301) — deploys via `wrangler`, separate from Vercel/Supabase.
- **Invariants:** mint is `authenticated`-only (Supabase default-privileges auto-grant anon — must
  `REVOKE … FROM anon` explicitly); the SQL code charset/length must stay within the Worker regex
  (`src/test/shortLinkContract.test.ts`); `resolve_short_link` must never write (edge-cacheable).
- **Distinct from** the `/t/` `/a/` profile slug links (`slug_redirects` + `resolve_public_handle`) —
  do not conflate; use `/s/` for new surfaces.
