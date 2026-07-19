# Notification architecture (Foundation v2)

Status: canonical (source of truth) | last updated 2026-07-19 | program IN PROGRESS

> **Rev 2 (2026-07-19, Codex review of PR #590):** per-recipient idempotency key
> (was collision-prone); tenant-visibility columns + RLS + denial tests moved
> into the schema PR (PR 2); tenant-scoped consent (`consent_scope`/provenance)
> on person-keyed contacts; channel-agnostic PII-safe destination model on the
> delivery-events table; WhatsApp provider updated to the Twilio/SendGrid family
> (owner to confirm exact credentials).

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
  channel is deliverable, write a `skipped` row + Slack-alert.
- **Tenant isolation**: academies/trainers see only their own scope; security/
  account/marketing notifications are `private_user_only`/`admin_only`, never
  tenant-visible.
- **No raw PII/tokens** in logs or tenant-visible payloads: `payload` is
  service-role-only; `public_summary` is sanitized (reuse
  `redactTrackingString`/`sanitizeTrackingProperties` from
  [`trackingPrivacy.ts`](../src/lib/trackingPrivacy.ts)). The **raw destination
  (email/phone) is NEVER exposed to a tenant read** — tenant-visible rows carry
  only a `redacted_destination` (`j***@x.com`, `+31•••1234`) + `contact_id`; the
  raw value lives in a service-role-only column. A phone number must never be
  shoved into an email-shaped field (see §3.1).
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
   `booking_paid:<booking_id>:<event_type>:<recipient_person_id>:<channel>` under
   `unique(channel, idempotency_key)`. This keeps the "duplicate Mollie webhook →
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
provider wired up here). But the owner reports an existing **Twilio / SendGrid
account family with a WhatsApp number** — SendGrid is Twilio-owned, and Twilio
WhatsApp senders live under **Twilio Messaging** (registered WhatsApp senders),
so the likely path is **Twilio WhatsApp**, not SendGrid-email and not a separate
Meta Cloud API / 360dialog integration.

> **OWNER TO CONFIRM before PR 9** (the worker's credential model depends on it):
> the exact account (Twilio Account SID vs a SendGrid-branded console), the
> registered WhatsApp sender number, and the credential/API shape (Twilio
> `Messages` API + Content Templates, or Meta Cloud API). This doc will be
> updated to the confirmed provider before the WhatsApp worker is built.

Prerequisites, once the provider is confirmed:
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
3. Policy resolver + `enqueue_notification` helper (absorbs `send-email`'s
   mapping) + tests.
4. Email worker (drains outbox → Resend via the existing primitive) + delivery
   event recording via the reused layer.
5. **Pilot: migrate ONE low-risk notification** (e.g. `review_received_trainer`)
   end-to-end to prove the pipeline — NOT the money path first.
6. Migrate the paid-booking player/staff notifications to the outbox (map the
   E-15 claim → idempotency_key).
7. Tenant-visible timelines — the READ RPCs/UI only (the schema + RLS + denial
   tests already landed in PR 2): `get_player_notification_timeline`,
   `get_invoice_notification_timeline`, `get_booking_notification_timeline`
   (SECURITY DEFINER, reuse the person-scope RPCs), returning only
   `public_summary` + `destination_redacted` + safe IDs.
8. `NotificationSettings` v2 UI (replaces v1).
9. WhatsApp consent + phone normalization + WhatsApp worker + provider webhook
   (once the owner's provider/templates are approved).
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
