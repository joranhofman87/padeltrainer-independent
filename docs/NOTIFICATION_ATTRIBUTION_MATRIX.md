# Notification attribution matrix — which sends answer to academy caps

Status: canonical (N3 M5, design-contract finding 2) | last updated 2026-08-13
Audience / AI-read: yes. **Pinned by `src/test/notificationAttributionMatrix.test.ts` — a
producer changing its attribution arguments fails a test until this file is updated.**

## The rule this matrix exists to make honest

An academy cap applies to a send **iff the producer supplied `p_tenant_academy_profile_id`**.
The resolver NEVER infers an academy from a trainer's affiliation — trainers belong to multiple
academies, affiliation changes over time, and inference could apply the *wrong tenant's* cap
(design review, finding 2). Where a send is genuinely academy-owned, its **producer** derives the
academy from the event's immutable business object (e.g. the booked slot), or refuses when the
set is incoherent.

Consequence, stated plainly for every surface that shows caps (M6 must repeat it): **a cap on an
event only affects that event's academy-attributed sends.** Trainer-only sends of the same event
are out of its reach — by design, not omission.

## The live producers (v2 pipeline — everything that reaches `enqueue_notification`)

| # | Producer (call site) | Event(s) | Attribution supplied | Academy caps? |
|---|---|---|---|---|
| 1 | `supabase/migrations/20260926100000_booking_notification_enqueue_rpc.sql` (both call sites) | `booking_request_staff`, `booking_confirmed_player`, `booking_cancelled_player` | **academy + trainer, derived from the booked SLOTS** — a set spanning academy scopes is refused outright | **Yes**, when the slot belongs to an academy and the event is optional |
| 2 | `supabase/functions/_shared/booking-confirmation-email.ts:319` | `booking_confirmed_player` | academy (when the slot has one) + trainer | Moot — the event is `required_delivery`; caps are refused at write and ignored at read |
| 3 | `supabase/functions/_shared/mollie-booking-paid-side-effects.ts:480` | `booking_confirmed_staff` | per-recipient staff scope: `scope.academy ?? null` / `scope.trainer ?? null` | **Yes** for academy-scoped staff copies; trainer-scoped copies are outside |
| 4 | `supabase/functions/notify-followers/index.ts:320` (logic in `_shared/open-slots-notify.ts` — one producer, two files) | `open_slots_player` | **trainer only** | **No.** A follower follows a TRAINER; the send has no academy owner. An academy cap on `open_slots_player` therefore affects nothing today — M6's surface must say so rather than offer a dead control |
| 5 | `supabase/migrations/20260913100000_notification_pilot_review_received.sql:63` | `review_received_trainer` | **trainer only** | **No** — same reasoning; the recipient is the trainer, reviews are trainer-owned |
| 6 | `supabase/migrations/20261118120000_abc27_rebook_round_notification_authority.sql` (`rebook_round_materialize(int,int)`, exactly three calls) | `rebook_member_open_player` | **academy only, from the typed locked round** (`r.academy_profile_id`) | **Yes** — optional email event; the academy cap applies before contact lookup/rendering |

## Not governed by caps at all (outside the v2 resolver)

The legacy senders (`send-email`'s direct path, `send-digest-emails`, `send-campaign-emails`,
`process-onboarding-emails`) do not pass through `enqueue_notification` and are therefore outside
cap enforcement entirely:

- **Campaigns** are the academy's own outbound marketing — the academy *sending* them is the
  entity a cap would restrict; restricting yourself is a UI choice, not a consent control. Their
  recipient-side control is N2's marketing suppression (unsubscribe), not caps.
- **Onboarding drip** is platform mail; no academy attribution exists.
- **Legacy `send-email` service events** predate the outbox. They retire with 10c-d; until then
  M6's surface must not list them as cappable (design-contract finding 12 — legacy honesty).

## Invariants a future producer must keep

1. Supply the academy **only** from the event's immutable business object; never from a live
   affiliation lookup.
2. A send with no coherent single tenant must be **refused**, not attributed to an arbitrary one
   (the booking RPC's `v_scopes <> 1` refusal is the model).
3. New producers must be added to this table AND to the pin test in the same change.
