# Notification architecture (Foundation v2)

Status: canonical (source of truth) | last updated 2026-07-19 | program IN PROGRESS

> **Rev 2 (2026-07-19, Codex review of PR #590):** per-recipient idempotency key
> (was collision-prone); tenant-visibility columns + RLS + denial tests moved
> into the schema PR (PR 2); tenant-scoped consent (`consent_scope`/provenance)
> on person-keyed contacts; channel-agnostic PII-safe destination model on the
> delivery-events table; WhatsApp provider updated to the Twilio/SendGrid family
> (owner to confirm exact credentials).
>
> **Rev 3 (2026-07-19, Codex re-check):** tenant timelines return safe ROW ids
> only — `contact_id`/`person_id`/raw destination stay service-role-only (a
> stable contact ref is a cross-tenant person-correlation oracle, same reasoning
> as `get_person_refs_for_scope`); `channel` lives in the
> `unique(channel, idempotency_key)` constraint, not inside the key string.

Audience / AI-read: yes. This is the reference for the notification pipeline
rebuild — the current-state audit, the target design, the reconciliation
decisions (what we reuse vs replace), the taxonomy, and the PR sequence. Read
this before touching any notification/email send path.

**Goal:** one robust, auditable, idempotent notification pipeline — email now,
WhatsApp next, push later. Feature/payment code enqueues *intent*; a central
resolver decides recipients/channels/consent/batching; channel workers send;
every send/skip/fail is recorded and (where appropriate) tenant-visible.

**Decision (owner, 2026-07-19):** the current notification system is lightly
used — we may **break/replace** it to move faster rather than maintain
backward-compat, as long as everything is documented here. WhatsApp: the owner
provisions the provider account + number + Meta-approved templates in parallel;
we build the consent model + worker around it.

---

## 1. Current state (as audited 2026-07-19)

### Channels that exist
- **Email — Resend only.** One transport primitive (`_shared/resend-send.ts`)
  + the Resend SDK / raw `fetch`. From: `PadelTrainer.ai <noreply@app.padeltrainer.ai>`.
- **Slack — one incoming webhook** (`slack-notify`, via `_shared/edge-slack.ts`).
  This is **ops alerting**, not user notification (errors, cron heartbeat,
  business pings). It stays a side channel; the new pipeline does NOT route
  Slack.
- **Push / SMS / WhatsApp — none.** `send-push`/`send-push-bulk` only INSERT
  rows into a dormant in-app `notifications` table (nothing in `src/` reads it).
  Zero Twilio/SendGrid/Meta/FCM/APNs/VAPID/web-push anywhere.

### The ~20 email senders (all fan out independently today)
Central dispatcher `send-email` (~26 `type`s) + standalone senders:
`send-invoice-email`, `forward-invoice`, `send-auth-email`,
`send-campaign-emails`, `send-digest-emails`, `trigger-welcome-emails`,
`process-onboarding-emails`, `notify-followers`,
`send-priority-claim-invitation`, `send-rebook-reminder`,
`auto-rebook-reminder`, `notify-rebook-member-open`,
`send-rebook-group-confirmation`, `send-schedule-notifications`,
`update-user`, `signup-user`, `create-manual-player`, `submit-guest-intake`,
plus the shared paid-booking helpers.

**The paid-booking chain (the highest-value fan-out, and the pilot target):**
`mollie-webhook` / `verify-mollie-payment` → (on the atomic first-paid claim,
E-15) → `runBookingPaidSideEffects` (`_shared/mollie-booking-paid-side-effects.ts`)
→ `auto-create-invoice` → `forward-invoice` (bookkeeping) +
`sendPlayerBookingConfirmation` (`_shared/booking-confirmation-email.ts`) +
Slack `payment_received` + `sendStaffBookingNotifications` (per-trainer &
per-academy-manager).

### Existing data model (what we reconcile with)
| Table | What it is | Fate in v2 |
|---|---|---|
| `notifications` | dormant in-app feed (nobody reads it) | **retire** or repurpose as the in-app channel later |
| `notification_preferences` | 14 fixed frequency columns, `user_id`-keyed, registered-only, has a live `NotificationSettings.tsx` UI | **replace** with `notification_preferences_v2` (event_type × channel); migrate the UI |
| `notification_queue` + `send-digest-emails` | digest hold-buffer + collapse-by-count flusher | **replace** with the outbox `collapse_key` + digest rows |
| `notification_sends` | follower-notification dedup (`dedup_key`) | **generalize** into the outbox `idempotency_key` |
| `email_delivery_events` + `email_address_state` + `record_email_event` + `is_email_suppressed` + `resend-webhook` | append-only Resend delivery/bounce log + address suppression + Svix-verified webhook + invoice-delivery UI | **REUSE — this already IS the delivery-events layer.** Generalize to channel-agnostic + link to the outbox (see §3) |
| `get_invoice_recipient_identity(_player_id,_guest_player_id,_academy_profile_id)` | recipient resolution: academy `billing_email` override → profile → guest, FAM-02 via `linked_profile_id` | **reuse the rules, add a person-aware path** |
| onboarding (`onboarding_email_*`) + campaigns (`email_campaign_*`) | drip + academy marketing blasts | **leave as-is for now**; fold under the taxonomy later (own PRs) |

### The resolver already half-exists
`send-email` is a partial policy resolver: `TYPE_TO_PREF_COLUMN` maps type →
pref column, `SYSTEM_EMAIL_TYPES` bypasses filtering (= `required_delivery`),
`off`→skip, `daily`/`weekly`→enqueue digest, else send. The v2 resolver
**absorbs** this logic — nothing is invented from scratch.

### Gaps the rebuild must close
- **Recipient resolution is dual-key (`player_id`/`guest_player_id`), not
  `person_id`** — even though person-unification landed and `persons` already
  holds `email`/`phone`/`preferred_language`/billing. The outbox is where we
  finally make recipients person-aware.
- **Phone numbers are free-text** (no E.164 canonicalization, no verification).
- **No channel-consent ledger anywhere** (intake `consent_given` is T&C, not
  messaging consent). WhatsApp/marketing need one.
- **Per-message delivery tracking exists only for invoice emails**
  (`send-invoice-email` is the only sender that records a `sent` row); the
  generic `send-email` does not. The outbox makes every send trackable.

---

## 2. Target architecture

```
feature/payment code
   │  enqueue_notification(event_key, subject refs, context)   ← intent only
   ▼
policy resolver  ── decides: recipients, channels, prefs, consent, required
   │                delivery, collapse/digest, quiet hours, rate caps
   ▼
notification_outbox  (one row per recipient × channel; deterministic
                      PER-RECIPIENT idempotency_key)
   │
   ├── email worker ─────► Resend ─┐
   ├── whatsapp worker ──► provider┤ (later)
   └── (push worker) ─────► …      ┘
                                   │  provider webhooks
                                   ▼
                 notification_delivery_events (append-only)
                                   │
                                   ▼
        delivery status + tenant-visible timelines (SECURITY DEFINER RPCs)
```

**Core invariants (kept from Codex's plan — they match repo doctrine):**
- Feature/payment code enqueues intent only — **no direct sends** from client
  or feature code.
- Required/payment/security notifications are **never silently dropped**: if no
  channel is deliverable, write a `skipped` row + Slack-alert. **Split of duties:**
  the *resolver* (PR 3) writes the durable `skipped` row; the *worker* (PR 4)
  raises the Slack alert on skipped-required rows (a `SECURITY DEFINER` SQL
  function can't and shouldn't make an outbound HTTP call).
- **Tenant isolation**: academies/trainers see only their own scope; security/
  account/marketing notifications are `private_user_only`/`admin_only`, never
  tenant-visible.
- **No raw PII/tokens** in logs or tenant-visible payloads: `payload` is
  service-role-only; `public_summary` is sanitized (reuse
  `redactTrackingString`/`sanitizeTrackingProperties` from
  [`trackingPrivacy.ts`](../src/lib/trackingPrivacy.ts)). The **raw destination
  (email/phone) is NEVER exposed to a tenant read** — tenant-visible rows carry
  only a `redacted_destination` (`j***@x.com`, `+31•••1234`) plus safe ROW ids
  (`outbox_id`/`delivery_event_id`). The raw value lives in a service-role-only
  column, and **`contact_id` is NOT tenant-visible either** — it's a stable
  per-person ref that would correlate the same person across academies (the same
  reasoning as `get_person_refs_for_scope`, which withholds `person_id`: a scoped
  reader must not expose a ref the tenant couldn't otherwise see). A phone number
  must never be shoved into an email-shaped field (see §3.1).
- **Idempotency is PER RECIPIENT.** `unique(channel, idempotency_key)` where
  `idempotency_key = <event_key>:<subject_id>:<recipient_person_id>` — NOT the
  shared per-booking claim (that would collide the player + staff rows of one
  paid booking). The E-15 atomic paid-claim gates whether the fan-out ENQUEUES
  at all (run-once); each enqueued recipient row derives its own key (see §3.7).
- **The full tenant-visibility posture is created in the SCHEMA PR (PR 2)** —
  `visibility_scope`, `tenant_academy_profile_id`, `tenant_trainer_id`, subject
  refs, `public_summary`, the RLS, and cross-tenant denial tests. PR 7 only adds
  the read RPCs/UI on top; the columns must be right from the start.
- WhatsApp requires **explicit opt-in** regardless of preference, and the opt-in
  is CONSENT-SCOPED (see §3.3) — an opt-in collected by one tenant is not
  automatically usable by another.

Data model (5 tables) is specified in Codex's plan; the deltas we apply are in
§3. Full column lists live in the migration + are mirrored in
[`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) once shipped.

---

## 3. Reconciliation decisions (the deltas vs a greenfield build)

1. **`notification_delivery_events` = the generalized `email_delivery_events`,
   with a channel-agnostic, PII-safe destination model.**
   Do NOT create a second delivery-log table — that would fork the suppression
   list (`email_address_state`) and break the invoice-delivery UI. Generalize
   the existing table: add `channel`, `outbox_id`, and `contact_id`; keep
   `record_email_event`'s idempotency + the state machine; the `resend-webhook`
   correlates via `provider_message_id`, and the WhatsApp webhook writes the same
   log with `channel='whatsapp'`.
   **Destination handling (the P2 PII boundary — decided):** `recipient_email`
   was `NOT NULL` and email-shaped, which cannot hold a WhatsApp phone. So:
   (a) make `recipient_email` NULLABLE (email channel only, kept for the existing
   suppression join); (b) add `destination_redacted text` (the only thing
   tenant-visible reads ever see — `j***@x.com` / `+31•••1234`); (c) the RAW
   destination is reachable only via `contact_id` → `notification_contacts`
   (service-role-only). Phone numbers never land in `recipient_email`. Suppression
   for WhatsApp keys on the contact, not on an email-shaped string.
2. **The resolver absorbs `send-email`'s mapping.** Seed
   `notification_event_types` from the union of the existing ~26 `EmailType`s +
   `TYPE_TO_PREF_COLUMN` + `SYSTEM_EMAIL_TYPES`, so no current notification is
   lost in translation. `SYSTEM_EMAIL_TYPES` → `required_delivery = true`.
3. **Recipients are person-keyed, but consent is TENANT-SCOPED.**
   `notification_contacts` keys on `persons.id` (nullable
   `user_id`/`guest_player_id` for the transition), and recipient resolution
   reuses `get_invoice_recipient_identity`'s FAM-02 rules but resolves through
   `person_links`. **Critical (P2):** `persons`/`person_links` are GLOBAL /
   cross-tenant by design, so a raw person-keyed consent row would leak across
   tenants — a guest WhatsApp opt-in collected by Academy A must NOT become
   usable or visible for Academy B. So each contact/consent row carries a
   `consent_scope` (`global` | `tenant`) + a tenant provenance
   (`consent_academy_profile_id` / `consent_trainer_id`) + `consent_source`, and
   the resolver **intersects the contact's consent scope with the notification's
   tenant context** (the I-22 tenant-scoping doctrine applied to consent): a
   `tenant`-scoped opt-in is only usable when the notification's
   `tenant_academy_profile_id`/`tenant_trainer_id` matches its provenance;
   `global` (e.g. the person's own account-level email) is usable everywhere.
   Cross-tenant consent-leak denial is a required test.
4. **`notification_preferences_v2` replaces v1** (event_type × channel
   frequency). Backfill from v1's 14 columns where they map; the v2
   `NotificationSettings` UI replaces the v1 page (we may break the v1 page —
   owner-approved).
5. **The outbox `collapse_key` + digest rows replace `notification_queue`.**
   The existing collapse-by-count digest logic is the behavior to generalize.
6. **Slack stays an ops side channel** (`edge-slack`), NOT an outbox channel.
   Required-delivery failures Slack-alert via the existing helper.
7. **Idempotency: a PER-RECIPIENT key, gated by the paid-chain's atomic claim.**
   The E-15 first-paid claim is per BOOKING (shared by the player + every staff
   recipient), so it CANNOT be the outbox `idempotency_key` directly — that
   would collide the player and staff rows of one paid booking (P1). Instead:
   the E-15 claim gates whether `runBookingPaidSideEffects` ENQUEUES at all
   (run-once), and each enqueued row gets a deterministic PER-RECIPIENT key
   `booking_paid:<booking_id>:<event_type>:<recipient_person_id>` under
   `unique(channel, idempotency_key)` — channel lives in the UNIQUE constraint,
   not inside the key string (one convention, no redundancy). This keeps the
   "duplicate Mollie webhook →
   one row per recipient per channel" and "webhook-vs-verify race → no
   duplicates" guarantees (a duplicate delivery re-derives the same per-recipient
   keys and no-ops on the unique index), while still fanning out to N recipients.
8. **Worker = the cron single-flight lock pattern** already in
   [`20260614190000_cron_single_flight_lock.sql`](../supabase/migrations/20260614190000_cron_single_flight_lock.sql),
   plus stale-lock recovery + exponential backoff + max attempts.

---

## 4. Initial event-type taxonomy

Seeded from Codex's list reconciled with the existing senders. Each carries
`category`, `audience`, `priority`, `required_delivery`, per-channel support +
default frequency, `collapse_window_minutes`, rate caps, `quiet_hours_respect`,
templates, and `visibility_scope`.

booking_confirmed_player · booking_confirmed_staff · booking_request_staff ·
booking_cancelled_player · booking_cancelled_staff · session_reminder_player ·
payment_receipt_player · payment_received_staff · invoice_created_player ·
invoice_paid_player · invoice_paid_staff · invoice_payment_failed ·
invoice_reminder_player · rebook_invite_player · rebook_paid_player ·
rebook_paid_staff · review_received_trainer · password_reset ·
account_email_changed · marketing_updates

`visibility_scope`: security/account/marketing ⇒ `private_user_only` or
`admin_only` (never tenant-visible). Staff booking/payment events ⇒
`tenant_visible` scoped by `tenant_academy_profile_id`/`tenant_trainer_id`.

---

## 5. WhatsApp provider + prerequisites (owner-provisioned, in parallel)

WhatsApp is greenfield in THIS codebase (email is Resend; there is no messaging
provider wired up here). **Provider = Twilio WhatsApp (confirmed by owner,
2026-07-19).** The PR-9 worker targets Twilio Messaging — the `Messages` API with
a registered WhatsApp sender + Content Templates (Meta-reviewed), authed by the
Twilio Account SID + Auth Token. Not SendGrid-email, not Meta Cloud API directly,
not 360dialog. New edge-function secrets: `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (the registered sender).

> **Remaining owner setup before PR 9 ships** (does NOT block PRs 3–8): the
> registered WhatsApp sender number provisioned on Twilio + business verification,
> and the approved Content Templates. We build the consent model + worker against
> the Twilio contract in the meantime.

Prerequisites:
- **Registered WhatsApp sender** on the Twilio number + business verification.
- **Approved message templates** — every business-initiated message needs an
  approved template (Twilio Content Templates → Meta review, ~1–3 days each).
  Start template drafts early.
- **Consent + phone normalization** (built by us — the real prerequisite): E.164
  normalization + a tenant-scoped consent checkbox on booking/intake/signup
  writing `notification_contacts` (channel=`whatsapp`, `consent_status=opted_in`,
  `consent_scope` + provenance per §3.3).
- First release: **no PDF attachments** — send secure links; opt-out via the
  provider webhook updates `notification_contacts`.

---

## 6. Adjusted PR sequence

1. **This doc** (current-state map + reconciled design). ← PR 1
2. Schema: `notification_event_types` (+ seed), `notification_contacts`
   (person-keyed + `consent_scope`/provenance §3.3),
   `notification_preferences_v2`, `notification_outbox`, and the
   `email_delivery_events`→delivery-events generalization (§3.1 destination
   model). **Ships the FULL tenant-visibility posture even though the read RPCs
   come in PR 7:** `visibility_scope`, `tenant_academy_profile_id`,
   `tenant_trainer_id`, subject refs, `public_summary`, per-recipient
   `idempotency_key` (§3.7), the RLS, and **cross-tenant (+ cross-tenant
   consent) denial tests**. RLS + indexes + pglite tests.
3. Policy resolver + `enqueue_notification` helper + tests. **← shipped (PR 3).**
   As-built contract (`20260911100000_notification_resolver.sql`,
   `SECURITY DEFINER`, service-role-only, `RETURNS TABLE` of the rows it created):
   - **Recipient normalization** — any of `person_id`/`user_id`/`guest_player_id`
     resolves to the one person (via `persons.user_id` / `person_links`); the
     idempotency key is `<event>:<subject>:<person>` so the same recipient reached
     by different keys never double-sends.
   - **Mandatory idempotency subject** — a blank subject would make every future
     send for that event+recipient collide into a silent no-op (fatal on the money
     path), so it is **derived** from the related invoice / payment / sorted-booking
     refs when omitted, and if there is nothing to derive from the resolver
     **RAISEs** rather than mint a collision-prone `<event>::<person>` key.
   - **Preference resolution** — `prefs_v2` override else the event-type default,
     per channel. A required-delivery event **forces the email channel to
     `instant`** (can't be turned off or digested).
   - **Two independent WhatsApp/push gates** (both must pass): (1) a non-`off`
     per-event frequency — `default_whatsapp_frequency` seeds to `off`, so
     WhatsApp is opt-in per event via `prefs_v2`; (2) an **opted-in, in-tenant-
     scope contact** (`is_notification_consent_in_scope`). No raw phone fallback.
     Because `prefs_v2` is `user_id`-keyed, **WhatsApp/push are registered-only
     for now** — a guest (no login) can't reach a non-`off` cadence; a guest
     opt-in path is a **PR 9** design item. Guest *email* is unaffected.
   - **Email = tenant-scoped transactional** — no opt-in needed, but the
     destination still respects tenant scope: an **in-scope** email contact — a
     `tenant` contact only in its own tenant, and a `global` contact **only for
     account holders** (`v_user_id`) — else, for account holders only, the
     `persons.email` account (login) email. A guest-only person can own **neither**
     a global contact **nor** the account-email fallback: its address is always
     tenant-collected, so it must come from a `tenant`-scoped, in-scope contact —
     **Academy B can't reuse an address Academy A collected**, whether that address
     was scoped `tenant` OR (mis-)written `global`. The schema's
     `consent_scope DEFAULT 'global'` is dropped so writers must state scope on
     purpose. **Hard suppression** (`is_email_suppressed`) blocks even required
     sends (re-sending a hard bounce just re-bounces).
   - **Skipped rows** — a REQUIRED event with no deliverable channel writes a
     visible `status='skipped'` row (`skip_reason` = `preference_off` /
     `no_email_contact` / `email_suppressed`) instead of vanishing. The ops Slack
     alert on those rows is the worker's job (PR 4), not the resolver's.
   - **Redaction** — `notification_redact_destination` covers the account-email
     fallback so a `destination_redacted` always exists for the PR-7 timelines.
   - Deferred here (documented, not gaps): digest batching / quiet-hours /
     `max_per_user` → the worker (PR 4+); the legacy `type`→`key` map → PR 5.
4. Email worker (drains outbox → Resend via the existing primitive) + delivery
   event recording via the reused layer. **← shipped (PR 4).** As-built:
   - **RPC layer** (`20260912100000`, all `SECURITY DEFINER`, service-role-only):
     `claim_notification_outbox_batch` (atomic `FOR UPDATE SKIP LOCKED` claim of due
     `pending` rows **AND** stale-`processing` rows orphaned by a crashed worker —
     `locked_at` past `p_stale_after_minutes` — reaping any stuck past `max_attempts`
     to `failed`; claims under a **per-run lock token**); `record_notification_send_result`
     (validates the caller **still owns the lock** — else returns `stale` so a slow/
     orphaned worker can't overwrite a newer outcome; sent = terminal; failed = backoff
     `2^attempts min` capped, or terminal via `p_terminal`, or at `max_attempts`; writes
     the linked `email_delivery_events` row with `outbox_id`/`channel`/`destination_redacted`
     for PR 7); `claim_skipped_required_alerts` + `mark_skipped_alerts_sent` — a
     **lease → confirm** pair (lease bumps `ops_alert_attempts`; only a confirmed Slack
     send sets `ops_alerted_at`), so a Slack failure re-tries (at-least-once, bounded).
   - **Edge fn** `notification-email-worker`: `requireServiceRole` guard →
     `try_lock_cron_job` single-flight (fail-open) → claim under a fresh `crypto.randomUUID()`
     token → per row: validate payload, re-check `is_email_suppressed` (**fail CLOSED** —
     on check error, retry rather than risk sending to a bad address), `sendResendEmail`
     with a stable **`Idempotency-Key`** (`notification-outbox-<id>`, so a retry after
     Resend accepted can't double-email), record outcome → lease + confirm the ops Slack
     alert on skipped-required rows (the PR-3 hand-off) and best-effort alert on send failures.
   - **Schedule**: pg_cron `*/2 * * * *` (Vault-key pattern, guarded for CI).
   - Deferred: digest **collapse** by `collapse_key` (rows still send individually when
     `scheduled_for` arrives); quiet-hours; `max_per_user` rate limits.
5. **Pilot: migrate ONE low-risk notification** (`review_received_trainer`)
   end-to-end to prove the pipeline — NOT the money path first. **← shipped (PR 5).**
   As-built (`20260913100000`): an `AFTER INSERT ON reviews` **SECURITY DEFINER**
   trigger (`notify_review_received`) resolves the reviewed trainer's `user_id`
   (`trainer_profiles.user_id`, always a login), renders a minimal injection-safe
   email (rating only — no user free-text; details in-app), and calls
   `enqueue_notification('review_received_trainer', p_recipient_user_id => trainer,
   p_tenant_trainer_id => reviews.trainer_id, p_idempotency_subject => reviews.id,
   p_payload => {subject,html}, p_public_summary => {event_type,rating})`. Delivery
   uses the resolver's **account-holder `persons.email` fallback** — every trainer has
   one (verified: 24/24) — so **no contact backfill** is needed. Enqueue failures are
   caught so they never break the review insert.
   **Authorization guard:** `reviews` INSERT RLS only checks `player_id` and
   `booking_id` has no FK, so the trigger first verifies the review is tied to a **real
   completed/confirmed booking of this player with this trainer** (`bookings.slot_id →
   availability_slots.trainer_id`); otherwise it keeps the review row but sends nothing —
   else a forged `trainer_id`/`booking_id` would become platform email spam to arbitrary
   trainers. (Deeper fix — an FK on `reviews.booking_id` + tighter INSERT RLS — is tracked
   as a separate data-integrity follow-up.)
   The legacy client-side
   `sendReviewNotification` is **already dormant** (`trainerEmail` is never passed at
   the only call site, so no double-send) — its removal is deferred to PR 10.
6. Migrate the paid-booking notifications to the outbox (map the E-15 claim →
   idempotency subject, derived from the payment/invoice/booking refs). Split:
   - **6a (shipped): the PLAYER/payer confirmation.** `sendPlayerBookingConfirmation`
     now COMPOSES (subject + html + the invoice-PDF attachment, carried in the outbox
     payload) and enqueues `booking_confirmed_player` instead of sending via Resend —
     for the public paid-booking path (`runBookingPaidSideEffects`) AND the rebook-group
     invoice path. A **registered** player delivers via the resolver's `persons.email`
     account fallback (user_id); a **guest** has no account email, so a locked-down,
     service-role-only `ensure_guest_email_contact(guest, email, academy, trainer)` upserts
     a TENANT-SCOPED (`consent_scope='tenant'`, `consent_source='paid_booking'`,
     `consent_status='unknown'` = transactional not marketing) email contact the resolver
     then finds by `guest_player_id`. Scope = the ACADEMY when present, else the trainer
     (independent) — NOT both: a guest can book several trainers within one academy and
     there is a single contact row per guest, so a trainer dimension would flip and strand
     retries; academy-scope still blocks cross-academy reuse, which is the isolation goal.
     A guest with no collected email → a VISIBLE required-but-`skipped`/`no_email_contact`
     row (the worker's ops alert owns it). The contacts dedup index was reworked so guests
     are keyed per `guest_player_id` (per-academy) rather than per-email (which would
     collapse two same-email guests). The email worker forwards `payload.attachments` to
     Resend so the invoice PDF is delivered; to avoid unbounded JSONB/TOAST bloat, the base64
     attachment lives in the payload only while the row is IN FLIGHT — `record_notification_send_result`
     strips `payload.attachments` on any TERMINAL outcome (sent / non-retryable / exhausted),
     while a RETRYABLE backoff keeps it so the retry re-sends the same PDF (migration
     `20260915110000`). At scale this can be swapped for an invoice reference resolved at send time.
   - **6b (shipped): the STAFF fan-out.** `sendStaffBookingNotifications` now enqueues
     `booking_confirmed_staff` (one row per staff recipient) instead of a direct send-email,
     for both the public and rebook paths. The `new_public_booking_admin` copy was extracted
     to `_shared/staff-booking-email.ts` (send-email now renders through it too — no drift).
     Each row is TENANT-scoped — a manager's to their ACADEMY, a trainer's to their TRAINER —
     so PR-7 timelines show it only inside that scope, never cross-tenant. Delivery is the
     resolver's persons.email ACCOUNT fallback (staff are account holders). Idempotency is
     per recipient (`<event>:<payment-subject>:<person>`), so a duplicate webhook/verify
     delivery re-enqueues to a no-op, and a trainer who is also a manager (same account) gets
     ONLY the academy row. `booking_confirmed_staff` was flipped to REQUIRED-delivery
     (migration `20260916100000`) so a staff account with no reachable email yields a VISIBLE
     skipped/no_email_contact row — consequence: staff booking email is now non-mutable +
     instant (a prefs_v2 opt-out/digest would be a PR-8 decision). The legacy send-email
     `new_public_booking_admin` case stays wired (now via the shared renderer) but has no
     remaining caller → retired in PR 10.
7. Tenant-visible timelines — the READ RPCs/UI only (the schema + RLS + denial
   tests already landed in PR 2): `get_player_notification_timeline`,
   `get_invoice_notification_timeline`, `get_booking_notification_timeline`
   (SECURITY DEFINER, reuse the person-scope RPCs), returning only
   `public_summary`, `destination_redacted`, channel/status/skip_reason,
   timestamps, and safe ROW ids (`outbox_id`/`delivery_event_id`) — **never
   `contact_id`, `person_id`, or a raw destination** (cross-tenant correlation).
   - **7a (shipped, migration `20260917100000`): the READ RPCs.** All three are
     SECURITY DEFINER over the service-role-only tables, so the auth-binding is the
     security story: each RPC first AUTHORIZES THE SUBJECT with the gate the app already
     uses (bookings → `can_manage_slot` + the player/trainer-guest arms; invoices → the
     canonical academy-manager | owning-trainer | admin predicate from
     `get_invoice_status_history`; player → `get_person_refs_for_scope`, which already
     enforces the scope pin, IDOR guard and guest split-freeze), else `42501`. Every row is
     then filtered by ONE shared predicate, `notification_row_visible_to_caller`, so the
     rule cannot drift across the three: admin sees all · `admin_only` never leaves the
     platform · the RECIPIENT sees their own **private** (`private_user_only`) history only —
     being a row's addressee is NOT a bypass, so a `tenant_visible` row must still clear the
     tenant arm (it belongs to its TENANT, not to whoever receives it) · tenant staff see ONLY
     `tenant_visible` rows carrying THEIR academy or trainer. `get_player_notification_timeline` has two modes — `p_scope IS NULL` = the
     signed-in player's own history, `p_scope` academy/trainer = the staff view of one
     player (legitimately EMPTY while every player-recipient event is `private_user_only`;
     widening that is a visibility_scope policy decision, deliberately NOT taken here).
     **Both subject gates are written `IF (...) IS NOT TRUE THEN RAISE`, never
     `IF NOT (...)`** — a NULL in the predicate (e.g. `get_profile_id_for_user()` is NULL
     for a staff account) makes `NOT (...)` NULL, the IF not fire and the RAISE be skipped,
     silently granting a foreign tenant access. The pglite denial suite caught exactly that.
     PR 6b's staff enqueue also now records `related_invoice_id`, so the invoice timeline is
     populated for tenants.
   - **7b (shipped): the UI surfaces.** One compact card
     (`components/notifications/NotificationTimelineCard.tsx`, modelled on
     `InvoiceStatusHistoryCard`) backed by `lib/notificationTimeline.ts`, wired to four
     surfaces: academy + trainer INVOICE detail (`InvoiceNotificationTimelineCard`) and
     academy + trainer PLAYER detail (`PlayerNotificationTimelineCard`, which passes the
     page's existing scope + parsed `p_`/`g_` ref straight through to the RPC). It renders
     the humanized event, a status badge (a `skipped` row shows its reason, so an
     undelivered notice is visible), the REDACTED destination and a timestamp — and
     **self-hides** while loading or with no visible rows, so a viewer who legitimately sees
     nothing (staff on a player whose confirmations are `private_user_only`) gets no empty
     card. A missing RPC (`PGRST202`, client ahead of the migration) also renders nothing
     rather than throwing. Deliberately small: no new dashboard, and no BOOKING surface —
     the app has no standalone booking detail page, and the staff rows are reachable on the
     invoice surface now that PR 6b records `related_invoice_id`.
8. `NotificationSettings` v2 UI (replaces v1). **← shipped (PR 8).** The page is driven by
   the `notification_event_types` CATALOG (readable by `authenticated` precisely so the UI can
   label itself) and stores per user × event in `notification_preferences_v2`. Rules it must
   keep: (a) `required_delivery` events render as **"Always on" with NO control** — the
   resolver forces `email_frequency := 'instant'` for them, so a toggle would silently do
   nothing; (b) a MISSING pref row means "use the event default", not "off", so the page only
   writes on change and never pre-seeds; (c) **no WhatsApp/push UI** — nothing seeds
   `supports_push`, and whatsapp cannot deliver until PR 9, so an opt-in there would be a
   promise we don't keep; (d) saves are **pessimistic** (state updates only after the write
   succeeds — v1 was optimistic with no rollback, so a failed save left the UI lying).
   **Role filtering treats `academy_manager` + `trainer` as ONE staff bucket** rather than
   trusting `audience` literally: `booking_confirmed_staff` is catalogued `academy_manager`
   but PR 6b's fan-out also mails TRAINERS, so a literal match would hide a setting from
   people who receive it. A transitional **"Other notifications"** group keeps the
   **COMPLETE v1 column set** editable. The rule is "every column send-email can still
   consult", NOT "columns with no v2 event key" — the latter is too narrow and strands live
   settings, because send-email still gates legacy sends on `booking_confirmation`,
   `booking_reminder`, `booking_cancelled`, `new_review`, `payment_receipt`, `payment_received`,
   `new_booking` and `open_slots_digest` even where a v2 event of a similar NAME exists (they
   are two different enforcement paths: v1 gates send-email, v2 gates the outbox). Live callers
   confirm it — `send-digest-emails` sends booking_confirmation/booking_reminder/
   booking_cancelled, `BookLesson` sends booking_request→new_booking, `BookForPlayerDialog`
   sends manual_booking_confirmation→booking_confirmation, `notify-followers` sends
   new_availability|slot_reopened→open_slots_digest. Legacy fallbacks mirror the COLUMN DEFAULTs
   of migration 20260210090026 exactly (notably `open_slots_digest` = **weekly**, not daily).
   PR 10 migrates those senders and the group goes.
   The route + the academy-managed-trainer exemption are unchanged: outbound email footers
   deep-link to `settings/notifications` as their unsubscribe target.
9. WhatsApp consent + phone normalization + WhatsApp worker + provider webhook.
   **Built and reviewable ahead of Twilio auth; SHIPPED DISABLED.** All Twilio/Meta side
   effects stay blocked until the owner confirms credentials — no templates created, none
   submitted, nothing sent (the only live Twilio calls are the read-only `diagnose`/`probe`
   actions on `twilio-content-admin`).
   - `normalize_phone_e164` — free-text phone → strict E.164, NULL when it cannot normalize
     CONFIDENTLY. A bare number with no `+` and no leading `0` is rejected rather than guessed:
     a wrong guess does not error, it messages a stranger.
   - `record_whatsapp_optin` (auth-bound, self-only; validates the caller-supplied tenant via
     the INTERNAL `person_has_tenant_relationship`) / `record_whatsapp_optout` (platform-wide —
     a STOP addresses the sender, not one academy). Opting in with a new number RETIRES the
     person's other WhatsApp contacts, so a phone change cannot leave the resolver
     non-deterministically messaging a recycled old number.
   - `whatsapp_outbox_consent_active` — the worker's SEND-TIME re-check, because a STOP can
     land between enqueue and send. **Bound to the row's own `contact_id`, NOT to the number.**
     The question is "is the consent THIS row was enqueued against still valid?", which
     diverges from "is anyone consented on this number?": A opts in with N → row queued; A
     moves to a new number, retiring A's contact for N; B (spouse / N's next holder) registers
     N; a number-keyed check would then return true from **B's** consent and deliver A's
     private notification to B's phone. Contact-binding also makes recycled numbers a
     non-issue — a retired contact stays retired whoever later holds the digits.
   - **Templates are committed to `_shared/whatsapp-templates.ts` and reviewed BEFORE anything
     is created in Twilio.** A submitted template goes in front of Meta under the business's
     identity and cannot be quietly withdrawn. `variables` is a positional contract — Twilio
     fills `{{n}}` by index, so a reorder silently sends a time where a name belongs.
   - **Worker (`notification-whatsapp-worker`) is OFF unless `WHATSAPP_SEND_ENABLED=true`,
     and returns BEFORE claiming.** Claiming and then failing would increment `attempts` on
     every pending row each tick and eventually mark them failed — destroying the queue it is
     meant to protect. Per-row guards: non-E.164 → terminal; consent revoked → terminal;
     consent check errored → retry (never send); no committed template → terminal.
   - **A GLOBAL config gap DEFERS instead of failing** (`defer_notification_outbox_row`, which
     returns the row to pending and gives the claim's attempt back). Marking a missing template
     SID or a 401 "retryable" is not sufficient: `record_notification_send_result` fails a row
     once `attempts >= max_attempts` whatever `p_terminal` says, and 5 attempts of 2^n backoff
     is only ~62 minutes — far shorter than a credential fix or a Meta template review. Without
     deferral, a config gap outliving that hour silently discards everything queued behind it.
     Row-specific faults stay terminal, and a transient provider blip still spends the budget.
   - **The defer/fail split is drawn by WHOSE INPUT WAS WRONG, not by HTTP semantics.** A 4xx
     normally reads as "permanent client error", but every row-shaped input is validated
     locally *before* the call — E.164 recipient, live consent, a committed template, content
     present — so what remains in the request is environment: the `ContentSid`, the sender, the
     account. An unapproved / wrong-account / mistyped `ContentSid` returns a 400, and treating
     that as terminal would destroy the whole queue on its **first drain** — faster and more
     total than the `max_attempts` exhaustion above.
     The full split, by Twilio error code where one is given:
     * **row terminal** — `21610` unsubscribed, `21614` not a mobile, `21211` invalid `To`,
       plus everything we diagnose locally (non-E.164, withdrawn consent, no committed
       template, no content). No config fix makes these deliverable, so they must never sit in
       the defer queue. `21610` additionally calls `record_whatsapp_optout`: until the status
       webhook is live it is our only STOP signal, and ignoring it would keep the resolver
       queueing messages to someone who opted out.
     * **defer** — auth/account/sender/template/ContentSid problems, and any *unrecognised* 4xx.
     * **transient** — 429/5xx/network, which spend the row's attempt budget as intended.
     The row-fault code set is a deliberately **conservative allow-list, not a full table**:
     unknown codes keep deferring, because a wrongly-deferred row is parked and recoverable
     while a wrongly-terminal one is a destroyed notification. Codes get promoted into the list
     from evidence — an unrecognised code appears in the delivery log with its number.
     The decision itself lives in the pure `whatsappFailureAction()` so it is unit-tested; the
     worker only switches on it (its `index.ts` calls `serve()` and has no harness, so policy
     left inline there would be policy nothing verifies).
   - Deferral is **bounded by time** (24h from when the row became *due* — anchored on
     `scheduled_for`, so a reminder queued days ahead isn't born half-expired). Past the cap the
     row fails terminally and lands on the delivery log, because an ambiguous 4xx can also mean
     genuinely undeliverable (recipient not on WhatsApp, sender blocked) and that must not park
     forever. Deferrals and exhaustions both raise ops alerts, so a gap that is never fixed
     parks the queue loudly rather than silently.
   - The worker is **scheduled on pg_cron from the start** (`20260919110000`, every 2 min,
     same guarded/idempotent Vault pattern as the email worker). Safe while disabled — the
     kill switch returns before claiming — and it makes going live a single env-var flip
     rather than a flip plus a remembered second step.
   - **No provider idempotency.** Unlike Resend, Twilio's Messages API has no Idempotency-Key,
     so the outbox claim is the only double-send guard; a crash between Twilio accepting and
     `record_notification_send_result` committing can re-send after the 15-minute stale reclaim.
   - Auth failures (401/403) are classified RETRYABLE: they are wrong for every row, so
     terminal would permanently fail the whole queue over a fixable env var.
   - `record_notification_send_result` now DERIVES `provider` from the row's channel
     (email⇒resend, whatsapp⇒twilio) instead of defaulting to `resend`. The old default was
     right while email was the only worker and silently mislabeled the first non-email
     worker's sends; deriving it means the push worker cannot repeat that by omission.
   - Both cron drainers (`notification-email-worker`, `notification-whatsapp-worker`) are
     `verify_jwt = false` **and now covered by `scripts/check-edge-fn-config.mjs`**: pg_cron
     presents the service-role key, which on this project is an `sb_secret_…` key and not a
     JWT, so `verify_jwt = true` 401s them at the gateway before `requireServiceRole` runs —
     and the cron job still reports success while nothing is ever sent.
   - `twilio-whatsapp-webhook` (`verify_jwt = false`) handles status callbacks AND inbound
     STOP on one endpoint. **The X-Twilio-Signature IS the authentication** — no token
     configured or a bad signature means 403 before the payload is interpreted. Statuses map
     onto the EXISTING `email_delivery_events` taxonomy (raw status kept in `reason`) rather
     than widening a CHECK the PR 7 timeline UI renders; `invoice_id` stays NULL so a WhatsApp
     failure never wears the invoice email-bounce badge. Idempotent on `(sid, status)`.
   - **Rollout order** (belt and braces alongside the deferral mechanism): set
     `TWILIO_ACCOUNT_SID` + working credentials, `TWILIO_WHATSAPP_FROM`,
     `TWILIO_TEMPLATE_SESSION_REMINDER_NL` and `TWILIO_STATUS_CALLBACK_URL` **first**, then
     flip `WHATSAPP_SEND_ENABLED=true` last. Deferral means getting this order wrong parks
     rows rather than losing them, but there is no reason to lean on that.
   - Owner-side, still open: re-copy `TWILIO_AUTH_TOKEN` from the same account as the `AC…`
     SID (the probe matrix proved they belong to different accounts — every us1/ie1/au1 ×
     credential-pair combination 401s), add the `whatsapp:` prefix to `TWILIO_WHATSAPP_FROM`
     (the sender helper now tolerates its absence), then create/submit the template.
10. Retire/wrap remaining legacy direct sends through the outbox; update this
    doc + runbooks as each lands.

## 7. Testing requirements (per Codex, kept)

Duplicate Mollie webhook → one notification per channel · webhook-vs-verify
race → no duplicates · Academy A cannot see Academy B's timeline · trainer sees
only their scope · academy manager sees only their academy's player/guest
history · security notifications hidden from trainers/academies · required
notification cannot be fully opted out · WhatsApp never sends without opt-in ·
hard bounce → skipped/failed + recovery visibility · new-booking burst
collapses/batches · provider failure retries then marks failed ·
`public_summary` contains no raw token/email/phone. Every migration ships with
a pglite test that executes the real migration file (repo standard).
