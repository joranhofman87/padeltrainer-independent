
# Tiered Rebooking Flow

Extend the existing priority rebooking system from 2 tiers (priority → public) to 3 tiers:

```text
Tier 1: Priority      Tier 2: Members            Tier 3: Public
(own slot rebooking)  (previous-cycle players,   (anyone, optional
 already built         can switch slots)          admin approval)
```

## 1. Data model

Add to `availability_slots` (one migration):

- `member_window_starts_at timestamptz`
- `member_window_ends_at timestamptz`
- `public_release_status text` — values: `pending_admin_review`, `auto_release_scheduled`, `released`, `held`. Default `auto_release_scheduled`.
- `source_cycle_id uuid` — populated at bulk-copy time from the source slot's `cyclus_id`. Used to identify "members" (anyone who booked any slot in that cycle).

No new tables needed. The audience is computed dynamically from `bookings` joined to source cycle.

## 2. Visibility rules (extend `shouldHidePrioritySlot` helper)

New pure helper `getSlotVisibility({ now, slot, viewer })` returns one of:
`'priority' | 'members' | 'public' | 'hidden'`. Applied in `BookLesson`, `TrainerOpenSlots`, `AcademyPublicOpenSlots`:

- If priority window active and unresolved priority claims → only the matching claim token sees it.
- Else if member window active → only viewers whose `auth.uid` has a non-cancelled booking in `source_cycle_id` see it. Anonymous viewers see it as hidden.
- Else if `public_release_status = 'released'` (or window passed and status auto) → everyone.
- Else if `public_release_status = 'pending_admin_review'` → hidden from public, visible to owner only.

## 3. Bulk Copy wizard — add tier defaults

Extend `BulkCopySlotsWizard.tsx`:

- Step 2: existing priority window setting.
- New Step 3: "Member window" — number of days after priority window ends. Default 7. Toggle to disable.
- New Step 4: "Public release" — radio: `Auto-release after member window` (default) | `Require my approval before public`.
- Persist these into the copied slots' `member_window_*` and `public_release_status` columns.

## 4. Per-slot override

In `TrainerSlotDetail` and `AcademySlotDetail`, add a "Visibility & rebooking" card showing the current tier (Priority / Members / Public / Held) with three actions:

- "Open to members now" — clears priority window, sets `member_window_ends_at`.
- "Open to public now" — sets `public_release_status='released'`, `is_public=true`.
- "Hold for review" — sets `public_release_status='held'`, prevents auto-release.

## 5. Slot-switch flow for members

When a member viewer (Tier 2) opens an eligible slot in `BookLesson`:

- Booking dialog gets a new "Switch from another slot?" section listing their current bookings in source cycle.
- Selecting a source slot triggers RPC `swap_member_booking(_old_booking_id, _new_slot_id)` — atomic: cancels old booking, creates new booking on the new slot, copies player metadata, refunds/credits handled by existing invoice flow (initial pass: marks old booking as `cancelled_swap`, no refund logic — flagged for follow-up).
- Without selecting, regular booking flow applies.

## 6. Admin review queue

A new tab `Cycles → Pending public release` lists slots where `public_release_status='pending_admin_review'` AND member window has ended. One-click "Release to public" or "Hold". Same component on Trainer and Academy.

## 7. Notifications (light)

- When a slot enters Tier 2: optional digest to source-cycle members (use existing notification preferences `open_slots_digest`).
- When `pending_admin_review` reaches the deadline: in-app banner on Cycles page.

## 8. Tests & QA

- Extend `priorityClaims.test.ts` with `getSlotVisibility` cases (12+ branches).
- Add `swapMemberBooking` unit tests for the membership predicate (pure function).
- Manual: full lifecycle test on one slot (priority → member → public).

## What I will NOT include in v1

- Refund handling on switch (mark for v1.1).
- Per-member invitation emails for Tier 2 (rely on existing digest).
- Waitlist promotion (already exists separately).

## Implementation order

1. Migration + types.
2. Pure visibility helper + tests.
3. Bulk Copy wizard tier inputs.
4. Public booking pages respect tiers.
5. Per-slot override card.
6. Member-switch RPC + UI section.
7. Admin review queue tab.
