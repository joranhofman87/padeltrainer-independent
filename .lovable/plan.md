## Goal

Let trainers/academies open the *next* cycle to existing players first (priority rebooking window) before the public, while the current cycle is still running. Each participant claims their own seat individually.

## Revised flow (timeline-aware)

```
[Current cycle still running]
        |
        |  ~4-5 weeks before it ends, trainer prepares the next one
        v
[Trainer creates next cycle skeleton (dates, name)]
        |
        v
[Bulk-copy slots from current cycle]
        |
        v
[For each new slot, system pre-attaches the players currently
 sitting in the matching slot of the running cycle]
        |
        v
[Trainer sets:
   - priority window length (e.g. 14 days)
   - price (per slot, editable)
 Then hits "Open priority rebooking"]
        |
        v
[Email goes out to every priority player with a personal claim link]
        |
        +--> Player clicks "Yes, claim my spot" -> pays -> seat locked
        |
        +--> Player clicks "No, I won't continue" -> claim released
        |        -> seat IMMEDIATELY becomes publicly bookable
        |
        +--> Player does nothing
                  |
                  v
        [Window ends] -> all unclaimed seats auto-released to public
        |
        v
[Public booking phase]
   - Cycle is still hidden from public during the priority window
   - Once a seat is released (decline OR window expiry) it appears publicly
```

Key timing rule: **the priority window happens entirely before the new cycle's first session**, and runs in parallel with the tail of the current cycle. The trainer chooses when to open the window; the window length is configurable per cycle.

## Slot states (drives all visibility)

For each new-cycle slot we track a simple state per seat:

- `priority_pending` — waiting for the priority player to act
- `priority_claimed_unpaid` — claimed, awaiting payment (short hold, e.g. 60 min)
- `claimed` — paid, seat locked
- `released` — declined, expired, or never priority -> publicly bookable

A slot is hidden from public listings while ANY seat is still `priority_pending` AND `now() < priority_window_ends_at`. As soon as a seat is `released`, that whole slot becomes publicly visible (with N seats remaining = released + still-open seats). This way one decline immediately exposes the slot to the public, even mid-window.

(Alternative: only show slot publicly after window ends. We will go with the "expose as soon as a seat releases" rule to maximize fill rate, which is what the user asked for.)

## Open question we are NOT re-asking

Per the user: every participant claims and pays their own seat individually. No "one player books for the group" flow.

## Database changes

New table:

```
slot_priority_claims
  id uuid pk
  slot_id uuid -> availability_slots
  player_id uuid (nullable)
  guest_player_id uuid (nullable)
  status text check ('pending','claimed','declined','expired','released')
  claim_token text unique               -- magic link token
  invited_at timestamptz
  responded_at timestamptz
  decline_reason text (nullable)
  source_slot_id uuid (nullable)        -- the slot in the previous cycle
  created_at timestamptz default now()
  unique(slot_id, player_id)
  unique(slot_id, guest_player_id)
```

Add to `availability_slots`:
- `priority_window_starts_at timestamptz` (nullable)
- `priority_window_ends_at timestamptz` (nullable)
- `priority_source_slot_id uuid` (nullable)

RPC (SECURITY DEFINER) for the public claim page:
- `get_priority_claim_by_token(_token text)` -> returns claim + slot + cycle summary
- `respond_to_priority_claim(_token text, _action text)` -> action in `('decline')` (the "claim + pay" action goes through the existing booking + Mollie flow, not here)

RLS:
- Trainers/academy managers can full-CRUD claims for slots they own.
- Players can read their own claims (by `player_id` or by linked `guest_player_id`).
- Public/anon can read & decline a single claim by `claim_token` only.

## Bulk slot copy wizard

New page: `src/pages/academy/AcademyBulkCopySlots.tsx` and parity `src/pages/trainer/TrainerBulkCopySlots.tsx`. Shared component: `src/components/cycles/BulkCopySlotsWizard.tsx`.

Steps:
1. **Source cycle** — pick the currently-running cycle (default).
2. **Target cycle** — pick existing or create new (name, start date, # weeks). System maps each source slot's weekday + time onto the new dates.
3. **Per-slot review (table)** — for each recurring slot row show: weekday + time, location, trainer, price (editable), max participants (editable), and the list of players auto-pulled from the source slot's bookings. Trainer can remove specific players from the priority list, change the price, swap trainer, or exclude the slot entirely.
4. **Window settings** — single global setting for this batch:
   - Priority window length in days (default 14)
   - Optional "send invites immediately" vs "save as draft, send later"
5. **Confirm** — bulk insert `availability_slots` + `slot_priority_claims`. Generates `claim_token` per claim. If "send immediately", queues the invitation email.

Idempotency key: `(target_cycle_id, source_slot_id, weekday, time)` so re-running won't duplicate.

## Player-facing public claim page

New public route `/claim/:token` -> `src/pages/PriorityClaim.tsx`.

- No auth required. Fetches via `get_priority_claim_by_token`.
- Shows: cycle name, date range, day/time, location, trainer, price, deadline.
- Two CTAs:
  - **Yes, claim my spot** -> goes to existing booking + Mollie payment flow, prefilled with the player. On payment success the booking is created and the claim is marked `claimed`.
  - **No, I won't continue** -> calls `respond_to_priority_claim(token, 'decline')`. Sets claim `declined`, frees the seat (becomes `released`), shows a thank-you screen.
- If opened after the window has ended and not yet acted on, claim auto-marks `expired` and the page shows a "this window has ended, here's the public booking link" CTA.
- Page is `noindex` and excluded from sitemap.

## Invitation email

New transactional edge function `send-priority-claim-invitation`:
- Subject: "Reserve your spot for {{cycle_name}}"
- Body: cycle dates, slot day/time, price, deadline, "Claim spot" + "I won't continue" buttons (both deep-link with `claim_token`).
- Reminders (optional v2): one reminder 48h before window ends to anyone still `pending`.

## Public visibility rule (slot listing)

Wherever public slot lists are queried (`AcademyPublicProfile`, trainer public profile, `BookLesson`, public slot RPCs):

A slot is visible to the public if:
- `priority_window_ends_at IS NULL` (no priority window configured), OR
- `now() >= priority_window_ends_at`, OR
- the slot has at least one `released` seat (decline or no priority on that seat) AND remaining capacity > 0

The seat count shown publicly = `max_participants - claimed - priority_pending - priority_claimed_unpaid`.

`BookLesson` accepts an optional `?claim=<token>` param so a priority player's payment flow doesn't get blocked by the public visibility rule.

## Trainer/academy management UI

On `AcademySlotDetail` and `TrainerSlotDetail` add a "Priority claims" section:
- List of priority players with status badges (pending / claimed / declined / expired)
- Per-row actions: resend invite, manually decline on their behalf (releases seat), add another player to priority list
- Countdown to `priority_window_ends_at`
- Buttons: "Open to public now" (force-end the window) and "Extend window by X days"

On the cycle detail page add a summary card: total seats, claimed, declined, pending, public bookings, fill rate %.

## Files to add/edit

Add:
- migration: `slot_priority_claims` table + new columns on `availability_slots` + RLS + 2 RPCs
- `src/pages/academy/AcademyBulkCopySlots.tsx`
- `src/pages/trainer/TrainerBulkCopySlots.tsx`
- `src/components/cycles/BulkCopySlotsWizard.tsx`
- `src/components/cycles/PriorityClaimsSection.tsx`
- `src/pages/PriorityClaim.tsx`
- `supabase/functions/send-priority-claim-invitation/index.ts`

Edit:
- `src/App.tsx` + DomainRouter -> register `/claim/:token`
- `src/pages/academy/AcademySlotDetail.tsx`, `src/pages/trainer/TrainerSlotDetail.tsx` -> embed `PriorityClaimsSection`
- `src/pages/AcademyPublicProfile.tsx`, public slot listing logic, `BookLesson.tsx` -> apply visibility rule + accept `?claim=` token
- Mollie payment webhook -> on successful payment for a booking that came via a claim token, mark the claim `claimed`
- `src/i18n/locales/{nl,en,...}/...` -> new strings (cycles + emails + claim page)
- `public/llms.txt`, `scripts/generate-sitemap.ts`, render-page worker -> exclude `/claim/:token`
- Cycle detail page -> add fill-rate summary card

## Safeguards

- `claim_token` is `crypto.randomUUID()` x2 (long random) and single-use per claim row.
- DB unique constraints prevent two priority claims on the same seat for the same player.
- Bulk copy is idempotent on `(target_cycle_id, source_slot_id, weekday, time)`.
- A claim never blocks a seat after the window ends; `expired` is computed on read in case no cron has run.
- Existing manual booking, intake form, and proposal flow remain untouched. Trainers only opt into this when they want priority rebooking.

## Suggested order of execution

1. Migration + RLS + RPCs
2. Bulk copy wizard (without email yet) so trainers can already prepare next cycles
3. Priority claims section on slot detail page (manual decline / extend / open-now controls)
4. Public claim page + decline endpoint + visibility rule update + Mollie webhook hook-up
5. Invitation email + optional reminder

Step 1 + 2 can ship first and be validated before we wire up the public-facing pieces.
