# Notification architecture (Foundation v2)

Status: canonical (source of truth) | last updated 2026-07-19 | program IN PROGRESS

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
notification_outbox  (one row per recipient × channel, idempotent)
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
  [`trackingPrivacy.ts`](../src/lib/trackingPrivacy.ts)).
- WhatsApp requires **explicit opt-in** regardless of preference.

Data model (5 tables) is specified in Codex's plan; the deltas we apply are in
§3. Full column lists live in the migration + are mirrored in
[`DOMAIN_MODEL.md`](DOMAIN_MODEL.md) once shipped.

---

## 3. Reconciliation decisions (the deltas vs a greenfield build)

1. **`notification_delivery_events` = the generalized `email_delivery_events`.**
   Do NOT create a second delivery-log table — that would fork the suppression
   list (`email_address_state`) and break the invoice-delivery UI. Instead:
   add `channel` + `outbox_id` to the delivery-events layer, keep
   `record_email_event`'s idempotency + the state machine, and have the
   `resend-webhook` correlate via `provider_message_id`. The WhatsApp webhook
   writes into the same log with `channel='whatsapp'`.
2. **The resolver absorbs `send-email`'s mapping.** Seed
   `notification_event_types` from the union of the existing ~26 `EmailType`s +
   `TYPE_TO_PREF_COLUMN` + `SYSTEM_EMAIL_TYPES`, so no current notification is
   lost in translation. `SYSTEM_EMAIL_TYPES` → `required_delivery = true`.
3. **Recipients are person-keyed.** `notification_contacts` keys on
   `persons.id` (nullable `user_id`/`guest_player_id` for the transition), and
   recipient resolution reuses `get_invoice_recipient_identity`'s FAM-02 rules
   but resolves through `person_links`. A guest's WhatsApp/email consent lives
   on their person's contact rows.
4. **`notification_preferences_v2` replaces v1** (event_type × channel
   frequency). Backfill from v1's 14 columns where they map; the v2
   `NotificationSettings` UI replaces the v1 page (we may break the v1 page —
   owner-approved).
5. **The outbox `collapse_key` + digest rows replace `notification_queue`.**
   The existing collapse-by-count digest logic is the behavior to generalize.
6. **Slack stays an ops side channel** (`edge-slack`), NOT an outbox channel.
   Required-delivery failures Slack-alert via the existing helper.
7. **Idempotency reuses the paid-chain's atomic claim.** The pilot migration
   maps the E-15 first-paid claim → the outbox `idempotency_key`
   (`unique(channel, idempotency_key)`), so the "duplicate Mollie webhook" and
   "webhook-vs-verify race" no-duplicate guarantees carry over from existing
   precedent.
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

## 5. WhatsApp prerequisites (owner-provisioned, in parallel)

WhatsApp is greenfield — there is **no** provider account today. Before the
WhatsApp worker (PR 8) can send:
- **Provider decision** (Twilio WhatsApp vs Meta Cloud API vs 360dialog) — cost
  + approval trade-offs. Owner to choose/provision.
- **WhatsApp Business number** + Meta Business verification.
- **Approved message templates** — every business-initiated message needs a
  Meta-approved template (~1–3 days review each). Start template drafts early.
- **Consent + phone normalization** (built by us, prerequisite): E.164
  normalization + a consent checkbox on booking/intake/signup writing
  `notification_contacts` (channel=`whatsapp`, `consent_status=opted_in`).
- First release: **no PDF attachments** — send secure links; opt-out via the
  provider webhook updates `notification_contacts`.

---

## 6. Adjusted PR sequence

1. **This doc** (current-state map + reconciled design). ← PR 1
2. Schema: `notification_event_types` (+ seed), `notification_contacts`,
   `notification_preferences_v2`, `notification_outbox`, and the
   `email_delivery_events`→delivery-events generalization. RLS + indexes +
   tenant scoping + pglite tests.
3. Policy resolver + `enqueue_notification` helper (absorbs `send-email`'s
   mapping) + tests.
4. Email worker (drains outbox → Resend via the existing primitive) + delivery
   event recording via the reused layer.
5. **Pilot: migrate ONE low-risk notification** (e.g. `review_received_trainer`)
   end-to-end to prove the pipeline — NOT the money path first.
6. Migrate the paid-booking player/staff notifications to the outbox (map the
   E-15 claim → idempotency_key).
7. Tenant-visible timelines: `get_player_notification_timeline`,
   `get_invoice_notification_timeline`, `get_booking_notification_timeline`
   (SECURITY DEFINER, reuse the person-scope RPCs) + cross-tenant denial tests.
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
