# PadelTrainer — Production test runbook

Manual checklist for **https://padeltrainer.ai** (Supabase **ficwb**). Written for a non-developer founder; a developer can help with browser DevTools if something fails.

---

## Before you start

| Tip | Why |
|-----|-----|
| Use **Chrome Incognito** (or a fresh profile) per journey | Avoids wrong account / cached login |
| Use a **new test email** each time (`you+test1@gmail.com`) | Easier to spot new users in admin |
| Keep a **notepad**: journey #, time, pass/fail, what you saw | Helps support and dev follow-up |
| **Payments**: Mollie/Stripe use **real money** in production unless your trainer is in Mollie test mode | Prefer a **low-price slot** (€1 if available) or ask dev for a test trainer |
| **Do not** run admin delete/impersonation on real customers | Use only test accounts you created |

**Optional (developer):** Browser → **Network** tab → filter `functions/v1` to confirm edge functions fired.

**Production base URL:** `https://padeltrainer.ai`

---

## Priority legend

| Priority | Meaning |
|----------|---------|
| **P0** | Revenue or core login/booking/pay — test every release |
| **P1** | Important product flows — test after related changes |
| **P2** | Ops / edge / admin — periodic smoke test |

---

## Journey 1 — Trainer signup (email)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/signup/trainer |

**Steps**

- [ ] Open URL in incognito.
- [ ] Enter name, **new** email, strong password (8+ chars).
- [ ] Submit signup.
- [ ] If shown “check your email”, note it (account may still work — product uses branded signup).
- [ ] You should land on **trainer onboarding** or be logged in.

**Expected result**

- No red error toast; URL becomes `/app/onboarding/trainer` or `/app/trainer`.
- You can open trainer dashboard after onboarding (Journey 5).

**Edge functions**

- `signup-user` (creates auth user + profile)
- `send-auth-email` (if password reset / auth emails used later)

**Database tables**

- `auth.users`, `profiles`, `user_roles` (trainer), `trainer_onboarding`, optionally `trainer_profiles`

**Failure signals**

- Stuck on signup with error “failed to create account”
- Login works but **no** trainer menu / redirect to player app only
- Duplicate-email error when email was never used

---

## Journey 2 — Player signup (email)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/signup/player |

**Steps**

- [ ] Incognito → URL above.
- [ ] Sign up with new email + password.
- [ ] Complete flow; accept redirect to player onboarding if shown.

**Expected result**

- Lands on `/app/onboarding/player` or `/app/player`.
- Player dashboard shows your name.

**Edge functions**

- `signup-user`

**Database tables**

- `auth.users`, `profiles`, `user_roles` (player)

**Failure signals**

- Redirect to trainer/club app instead of player
- “Too many applications” / generic 500 on submit

---

## Journey 3 — Academy signup & onboarding (email)

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/app/signup/academy |

**Steps**

- [ ] Incognito → academy signup with new email.
- [ ] Register → continue to https://padeltrainer.ai/app/academy/onboarding.
- [ ] Enter academy name, country, contact email, description → submit.
- [ ] Open https://padeltrainer.ai/app/academy — dashboard loads with academy name.

**Expected result**

- Full path signup → onboarding → dashboard without role errors.

**Edge functions**

- `signup-user` (signup only)

**Database tables**

- `auth.users`, `profiles`, `user_roles` (academy), `academy_profiles`, `academy_managers`

**Failure signals**

- Cannot access academy app after signup
- Submit error / duplicate slug on onboarding
- Dashboard empty or 403

---

## Journey 4 — Google OAuth (login / signup)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/auth |

**Steps**

- [ ] Incognito → login page.
- [ ] Click **Continue with Google**; pick a Google account.
- [ ] After redirect back, if first time: complete role onboarding (player or trainer) as prompted.
- [ ] Sign out; sign in again with Google — should be one click.

**Expected result**

- Back on padeltrainer.ai with dashboard for your role (no infinite spinner on `/app/auth`).
- Second login skips signup forms.

**Edge functions**

- None on click (Supabase Auth OAuth). After login: may run `trigger-welcome-emails`, `check-stripe-subscription` in background.

**Database tables**

- `auth.users`, `auth.identities`, `profiles`, `user_roles`

**Failure signals**

- Google redirect shows “error” in URL or blank page
- “Verification error” toast every time
- User created but **no** role → empty / wrong dashboard

---

## Journey 5 — Trainer onboarding

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/onboarding/trainer (after Journey 1 or 4 as trainer) |

**Steps**

- [ ] Log in as **new trainer** (not yet onboarded).
- [ ] Step 1: fill profile fields (bio, location, etc.) → Next.
- [ ] Step 2: finish / “Go to dashboard”.
- [ ] Open https://padeltrainer.ai/app/trainer — dashboard loads.

**Expected result**

- Onboarding completes; `/app/trainer` shows calendar/get-started, not forced back to onboarding.

**Edge functions**

- Usually none (client writes to DB). `signup-user` may have created stub `trainer_profiles`.

**Database tables**

- `trainer_onboarding`, `trainer_profiles`, `profiles`, `user_roles`

**Failure signals**

- Loop back to onboarding after completion
- “Could not assign trainer role” error
- Trainer dashboard 404 or blank

---

## Journey 6 — Player onboarding

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/onboarding/player |

**Steps**

- [ ] Log in as new player (Journey 2 or 4).
- [ ] Enter phone (if required), rating system + level, submit.
- [ ] Open https://padeltrainer.ai/app/player.

**Expected result**

- Player home loads; profile has phone/rating saved.

**Edge functions**

- None required

**Database tables**

- `profiles`, `user_roles`, optional `player_ratings` / rating fields on profile

**Failure signals**

- Cannot submit onboarding (validation loop)
- Player app shows but profile empty after refresh

---

## Journey 7 — Book a lesson (Mollie payment)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | A **public trainer** with open slots — e.g. https://padeltrainer.ai/nl/book/`TRAINER_SLUG` (get slug from https://padeltrainer.ai/nl/trainers or your known trainer link) |

**Prerequisites**

- Trainer has **Mollie connected** (Journey 15) and at least one **future public slot** (Journey 18).
- Use **player account** from Journey 2/4.

**Steps**

- [ ] Open book URL while logged in as player.
- [ ] Select an **individual** slot (not only cycle bundle unless you intend that).
- [ ] Confirm booking → redirected to **Mollie** checkout.
- [ ] Pay with real/test method (iDEAL/card).
- [ ] Wait for redirect to booking success (Journey 8).

**Expected result**

- Mollie page shows correct amount and trainer description.
- After payment, browser URL includes `booking_id=` on success page.

**Edge functions**

- `create-mollie-payment` (starts checkout)
- Background: `mollie-webhook` (marks paid), possibly `auto-create-invoice`

**Database tables**

- `bookings`, `availability_slots`, `profiles`, `trainer_profiles`, `trainer_mollie_accounts` / `academy_mollie_accounts`

**Failure signals**

- “Payment not available” before Mollie
- Mollie works but success page says payment not completed (webhook delay >30s)
- Double booking / slot still full after pay

---

## Journey 8 — Booking success page

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/booking-success?booking_id=`BOOKING_UUID` (from Journey 7 redirect) |

**Steps**

- [ ] After payment, wait on page (it polls ~30s).
- [ ] Confirm green success state with lesson date/time.
- [ ] Click **Download invoice** (if shown).
- [ ] Click **Add to calendar** / book again link — should not error.

**Expected result**

- “Payment successful” / booking confirmed message.
- Invoice download starts PDF or shows “pending” briefly then PDF.
- Logged-in **player** only: download works; stranger with only booking UUID should **not** get PDF (security).

**Edge functions**

- `verify-mollie-payment` (fallback poll)
- `get-booking-invoice` (PDF for owner)
- `generate-invoice` (internal, via get-booking-invoice)

**Database tables**

- `bookings`, `invoices`, `availability_slots`, `trainer_profiles`

**Failure signals**

- Stuck on spinner >30s then “payment not completed”
- Download invoice fails for the paying player
- Success page with missing `booking_id` in URL

---

## Journey 9 — Invoice generation & send (trainer)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/trainer/invoices (trainer with manual invoicing **or** after booking invoice exists) |

**Steps**

- [ ] Log in as trainer.
- [ ] **Option A:** Open existing invoice → Download PDF.  
  **Option B:** Create invoice https://padeltrainer.ai/app/trainer/invoices/new → save draft → send.
- [ ] Send invoice email to a test address you control.
- [ ] Check inbox for PadelTrainer invoice mail.

**Expected result**

- PDF downloads/opens.
- Email arrives with invoice details; invoice status becomes **sent** in list.

**Edge functions**

- `generate-invoice`
- `send-invoice-email`

**Database tables**

- `invoices`, `profiles` / `guest_players`, storage `invoices` bucket

**Failure signals**

- PDF generation error / blank PDF
- Email never arrives (check spam); status stays draft
- `no_email` loop with no way to add guest email

---

## Journey 10 — Public invoice payment (Mollie link)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/pay/`PUBLIC_TOKEN` (from invoice email or trainer “copy pay link”) — **no login required**

**Steps**

- [ ] Open link in incognito (not logged in).
- [ ] Invoice details load (amount, player name, line items).
- [ ] Optional: edit billing name/address → save.
- [ ] Click **Pay** → Mollie → complete payment.
- [ ] Return to pay page with success; download PDF if paid.

**Expected result**

- Pay works **without** login (uses token).
- After pay, status shows paid; PDF download works.

**Edge functions**

- `get-public-invoice`
- `update-public-invoice-details` (billing save)
- `create-invoice-payment` (requires token in request)
- `mollie-webhook` (marks invoice paid)

**Database tables**

- `invoices`, `profiles`, Mollie account tables

**Failure signals**

- Pay button error / 400 (token missing — frontend not deployed)
- Invoice not found for valid link
- Paid in Mollie but invoice still “sent” after 2+ minutes

---

## Journey 11 — Trainer subscription (Stripe)

| Field | Detail |
|-------|--------|
| **Priority** | P0 |
| **Starting URL** | https://padeltrainer.ai/app/trainer/subscription |

**Steps**

- [ ] Log in as trainer (trial or inactive OK).
- [ ] Choose a plan → **Subscribe** → Stripe Checkout opens.
- [ ] Complete payment (use Stripe test card only if project is in test mode; otherwise real sub).
- [ ] Return to app; refresh subscription page.
- [ ] Click **Manage subscription** → Stripe Customer Portal opens.

**Expected result**

- Subscription shows **active** (or correct tier).
- Portal opens without error.

**Edge functions**

- `create-stripe-checkout`
- `customer-portal`
- Background: `stripe-subscription-webhook`, `check-stripe-subscription`

**Database tables**

- `trainer_profiles` (`subscription_status`, `subscription_id`, …), Stripe customer on profile

**Failure signals**

- Checkout never opens
- Payment succeeded but app still “inactive”
- Portal 401/500

---

## Journey 12 — Academy cycle + player registration

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/app/academy/cycles/new |

**Steps**

- [ ] Log in as academy manager.
- [ ] Create a **registration** cycle (name, dates, open status) → save.
- [ ] Copy public registration link from cycle (or open `/nl/academies/ACADEMY_SLUG/register/CYCLE_ID`).
- [ ] As **player** (incognito), open link → submit intake form (availability, preferences).
- [ ] In academy app, open **Intake requests** — see new application.

**Expected result**

- Cycle visible in academy cycles list.
- Player submission succeeds once; appears as **new** intake.

**Edge functions**

- `send-email` (optional notification from form)

**Database tables**

- `cycles`, `intake_requests`, `profiles`, `academy_profiles`

**Failure signals**

- Public page 404
- “Too many applications” on first try
- Intake not visible to academy

---

## Journey 13 — Proposal generation (academy or trainer)

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/app/academy/intake-requests/overview?cycleId=`CYCLE_UUID` (or trainer equivalent under `/app/trainer/intake-requests/overview`) |

**Steps**

- [ ] Open overview for a cycle with **new** intake requests (from Journey 12).
- [ ] Run **Generate proposals** wizard → submit.
- [ ] Wait for completion message; see proposed groups/slots on screen.

**Expected result**

- Proposals appear; no 500 error; assignments listed per intake.

**Edge functions**

- `generate-proposals`

**Database tables**

- `proposed_assignments`, `intake_requests`, `availability_slots`, `cycles`

**Failure signals**

- Wizard fails immediately
- Empty proposals with intakes still “new”
- Timeout / spinner never ends

---

## Journey 14 — Finalize proposals + schedule email

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | Same proposal overview URL as Journey 13 |

**Steps**

- [ ] Review generated proposals.
- [ ] Click **Finalize** / confirm finalize dialog.
- [ ] Wait for success (bookings created count).
- [ ] Click **Send schedule notifications** (if separate button).
- [ ] Player test inbox receives schedule email.

**Expected result**

- Finalize reports bookings created > 0 (for non-empty proposals).
- Emails sent without blocking error.

**Edge functions**

- `finalize-proposals`
- `send-schedule-notifications`
- May trigger `auto-create-invoice`, `send-email`

**Database tables**

- `bookings`, `availability_slots`, `intake_requests`, `proposed_assignments`, `cycles`

**Failure signals**

- Finalize succeeds but 0 bookings when players were assigned
- Players not emailed
- Capacity errors / duplicate bookings (known area — note for dev)

---

## Journey 15 — Trainer Mollie connect (earnings)

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/app/trainer/earnings |

**Steps**

- [ ] Log in as trainer.
- [ ] Connect Mollie → complete OAuth in Mollie.
- [ ] Return to earnings page — status **connected** / charges enabled.

**Expected result**

- Can accept online lesson payments (Journey 7).

**Edge functions**

- `mollie-connect-trainer`
- `check-mollie-connect-status`

**Database tables**

- `trainer_mollie_accounts`, `trainer_profiles`

**Failure signals**

- Redirect loop after Mollie
- “Not connected” after successful OAuth
- Book lesson still says payment unavailable

---

## Journey 16 — Public trainer profile & book CTA

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/nl/trainer/`TRAINER_SLUG` (from directory https://padeltrainer.ai/nl/trainers )

**Steps**

- [ ] Open profile (no login).
- [ ] Confirm photo, bio, locations, reviews section load.
- [ ] Click **Book** / lesson CTA → book page opens with same trainer.
- [ ] View page source / tab title reasonable (SEO smoke).

**Expected result**

- Public page loads fast; no “trainer not found”.
- Book link goes to `/nl/book/SLUG` with slots or empty state message.

**Edge functions**

- None (reads public views `trainer_profiles_safe`, locations)

**Database tables**

- `trainer_profiles`, `profiles_public`, `availability_slots`, `reviews`, `locations`

**Failure signals**

- 404 trainer
- Book button wrong trainer or broken link
- Private data exposed (email/phone of trainer in HTML)

---

## Journey 17 — Email sending (booking confirmation)

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | Complete Journey 7 with **manual invoicing off** and email you control

**Steps**

- [ ] Book a paid lesson as player.
- [ ] Check player email for **booking confirmation** (within 5 min).
- [ ] Trainer with “notify followers” optional — skip unless configured.

**Expected result**

- At least one transactional email (confirmation or receipt path).

**Edge functions**

- `send-email` (types: `booking_request`, `manual_booking_confirmation`, etc.)
- `mollie-webhook` does not send player email directly — confirmation often from book flow

**Database tables**

- `bookings`, `profiles`, email logs if enabled

**Failure signals**

- No email at all (Resend misconfig)
- Email in spam only — note but still pass if content correct

---

## Journey 18 — Availability management (trainer calendar)

| Field | Detail |
|-------|--------|
| **Priority** | P1 |
| **Starting URL** | https://padeltrainer.ai/app/trainer/calendar |

**Steps**

- [ ] Log in as trainer.
- [ ] Click **Add slot** (or open `/app/trainer/slot/new`).
- [ ] Create a single public slot: tomorrow, 1 hour, price set, location selected → save.
- [ ] See slot on calendar week view.
- [ ] Open slot detail → edit price or time → save.
- [ ] As player, confirm slot appears on public book page (Journey 16).

**Expected result**

- Slot visible on trainer calendar and public book flow.

**Edge functions**

- None for basic slot CRUD

**Database tables**

- `availability_slots`, `trainer_profiles`, `locations`

**Failure signals**

- Save error / slot not on calendar
- Slot not visible to players (`is_public` / date range)

---

## Journey 19 — Google Calendar sync

| Field | Detail |
|-------|--------|
| **Priority** | P2 |
| **Starting URL** | Calendar connect UI is **not linked** in main nav (route commented in app). Ask dev to enable settings or use a trainer account that already connected Google. **Workaround test:** confirm a booking as trainer after connection exists. |

**Steps (if calendar settings URL is enabled for your account)**

- [ ] Open calendar settings page (dev-provided URL, e.g. player/trainer settings calendar).
- [ ] Connect Google → approve → return with `?success=true`.
- [ ] Confirm a **pending** booking on trainer bookings page (or create + confirm).
- [ ] Check Google Calendar for new event within a few minutes.

**Expected result**

- Connection row in app shows connected.
- Event appears in Google Calendar for confirmed booking.

**Edge functions**

- `google-calendar-auth` (OAuth start)
- `sync-calendar-event` (on confirm/cancel booking)

**Database tables**

- `user_calendar_connections`, `bookings`, `availability_slots`

**Failure signals**

- OAuth error redirect
- Connection shows connected but no calendar events
- If settings page 404 — treat as **product gap**, not test failure

---

## Journey 20 — Admin impersonation (support)

| Field | Detail |
|-------|--------|
| **Priority** | P2 |
| **Starting URL** | https://padeltrainer.ai/app/admin/users |

**Steps**

- [ ] Log in as **admin** only.
- [ ] Search a **test user** you created (never a real customer).
- [ ] Click **Impersonate** → new tab opens.
- [ ] In new tab, confirm you see that user’s dashboard.
- [ ] Close tab; admin session unchanged.

**Expected result**

- Impersonation tab loads as target user without password.

**Edge functions**

- `impersonate-user`

**Database tables**

- `auth.users`, `user_roles` (read); magic link session only

**Failure signals**

- No new tab / URL error
- Impersonation opens wrong user
- Admin locked out after impersonation

---

## Quick release smoke (15 minutes)

Run only **P0** journeys: **1 or 2**, **4**, **5 or 6**, **7→8**, **9 or 10**, **11** (20 journeys total in this doc).

---

## Related docs

- Deploy / stack: `DEPLOYMENT_GUIDE.md`
- P0 security deploy notes: `docs/P0_PR1_PR4_NOTES.md`
- Security SQL checks: `scripts/security/p0_pr1_pr4_verification.sql`
- Self-booking invoice edge case: [GitHub issue #1](https://github.com/joranhofman87/padeltrainer-independent/issues/1)

---

*Last updated: 2026-06-03 — codebase `padeltrainer` on ficwb production.*
