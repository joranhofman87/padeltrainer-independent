

## Comprehensive Email Notification Management

### Overview

Redesign the notification preferences system so players, trainers, and academies can control which emails they receive and at what frequency (instant, daily digest, weekly digest). Add an unsubscribe footer to all outgoing emails linking users to their settings page. Build a new digest edge function that runs on a cron schedule to batch non-instant notifications.

### Additional notification types I suggest adding

Beyond what you listed, these would drive engagement and keep users informed:

**Player:**
- **New review reply** -- when a trainer responds to their review
- **Payment receipt/confirmation** -- after successful payment
- **Waitlist update** -- when a spot opens for a session they're on the waitlist for

**Trainer / Academy:**
- **New review received** -- when a player leaves a review
- **Upcoming sessions summary** -- daily/weekly overview of their schedule
- **Payment received** -- when a payment comes in
- **Subscription expiring** -- reminder before trial/subscription ends
- **Profile view milestone** -- "Your profile was viewed X times this week"

---

### 1. Database changes

**Drop and recreate `notification_preferences` table** with role-aware columns and frequency support:

```text
notification_preferences
  id              uuid PK
  user_id         uuid FK (unique)
  -- Frequency: 'instant', 'daily', 'weekly', 'off'
  -- Player notifications
  booking_confirmation       text DEFAULT 'instant'
  booking_reminder           text DEFAULT 'instant'
  open_slots_digest          text DEFAULT 'weekly'
  upcoming_sessions_digest   text DEFAULT 'daily'
  payment_receipt            text DEFAULT 'instant'
  waitlist_update            text DEFAULT 'instant'
  -- Trainer/Academy notifications
  new_booking                text DEFAULT 'instant'
  booking_cancelled          text DEFAULT 'instant'
  new_follower               text DEFAULT 'daily'
  new_player                 text DEFAULT 'daily'
  new_registration           text DEFAULT 'instant'
  new_review                 text DEFAULT 'instant'
  upcoming_schedule_digest   text DEFAULT 'daily'
  payment_received           text DEFAULT 'instant'
  -- Metadata
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()
```

Create a **`notification_queue`** table for batching digest emails:

```text
notification_queue
  id              uuid PK
  user_id         uuid FK
  notification_type  text
  payload         jsonb
  scheduled_for   text ('daily' or 'weekly')
  created_at      timestamptz DEFAULT now()
  processed_at    timestamptz NULL
```

RLS: users can read/update their own preferences. Queue is only accessed by edge functions (service role).

**Migration SQL summary:**
- Add new columns to `notification_preferences` (keep existing table, add columns, backfill defaults)
- Create `notification_queue` table with RLS enabled, service-role-only policies
- Add check constraint on frequency values via a validation trigger

---

### 2. Notification settings page (redesigned)

**File: `src/pages/NotificationSettings.tsx`** -- complete rewrite

The page will be role-aware, showing different notification categories per role:

**Layout:**
- Grouped by category (Bookings, Followers, Schedule, Payments)
- Each notification type shows a label, description, and a **Select dropdown** with options: Instant / Daily / Weekly / Off
- Auto-save on change (debounced) with toast confirmation

**Player sees:**
| Category | Notification | Default |
|----------|-------------|---------|
| Bookings | New booking + invoice | Instant |
| Bookings | Booking reminder | Instant |
| Availability | Open slots from followed trainers | Weekly |
| Schedule | Upcoming sessions overview | Daily |
| Payments | Payment receipt | Instant |
| Waitlist | Spot available | Instant |

**Trainer/Academy sees:**
| Category | Notification | Default |
|----------|-------------|---------|
| Bookings | New booking(s) | Instant |
| Bookings | Player cancelled | Instant |
| Players | New follower | Daily |
| Players | New player | Daily |
| Registration | New registration | Instant |
| Reviews | New review | Instant |
| Schedule | Upcoming sessions overview | Daily |
| Payments | Payment received | Instant |

---

### 3. Email footer with "Manage notifications" link

**File: `supabase/functions/send-email/index.ts`**

Add a shared footer function appended to every email HTML:

```text
---
You're receiving this email from PadelTrainer.ai.
[Manage email notifications](https://padeltrainer.ai/app/{role}/settings/notifications)
```

The footer includes the role-appropriate link. System/security emails (password reset, verification) are excluded from this footer.

---

### 4. Preference-checking middleware in send-email

**File: `supabase/functions/send-email/index.ts`**

Before sending any email, the function will:
1. Look up the recipient's `notification_preferences` by email/user_id
2. Map the email `type` to the corresponding preference column
3. If preference is `'off'` -- skip sending entirely
4. If preference is `'daily'` or `'weekly'` -- insert into `notification_queue` instead of sending immediately
5. If preference is `'instant'` (or no preference row exists) -- send immediately (default behavior)

---

### 5. Digest edge function (new)

**File: `supabase/functions/send-digest-emails/index.ts`**

A new edge function that:
1. Accepts a `frequency` parameter (`daily` or `weekly`)
2. Queries `notification_queue` for unprocessed items matching that frequency
3. Groups items by `user_id`
4. For each user, builds a single digest email with all queued notifications
5. Sends via Resend
6. Marks items as `processed_at = now()`

**Digest email template:** A clean summary email with sections per notification type, e.g.:
- "You have 3 new bookings this week"
- "2 of your followed trainers added open slots"
- "Upcoming sessions: Mon 10:00, Wed 14:00"

With CTA buttons linking to the relevant dashboard pages.

**Cron schedule (pg_cron + pg_net):**
- Daily digest: runs every day at 07:00 CET
- Weekly digest: runs every Monday at 07:00 CET

---

### 6. Route updates

**File: `src/components/DomainRouter.tsx`**

Ensure the notification settings page is accessible from all three role layouts:
- `/player/settings/notifications` (already exists)
- `/trainer/settings/notifications` (add route)
- `/academy/settings/notifications` (add route)

All three routes use the same `NotificationSettings` component which renders role-appropriate options.

---

### 7. i18n

**Files:** `src/i18n/locales/{en,nl}/common.json`

Add keys for all notification type labels, descriptions, and frequency options (Instant/Daily/Weekly/Off) in both English and Dutch.

---

### Files affected (summary)

1. Database migration -- new columns on `notification_preferences`, new `notification_queue` table
2. `src/pages/NotificationSettings.tsx` -- complete rewrite with role-aware frequency selects
3. `supabase/functions/send-email/index.ts` -- add footer, add preference checking + queue logic
4. `supabase/functions/send-digest-emails/index.ts` -- new digest edge function
5. `src/components/DomainRouter.tsx` -- add trainer/academy notification routes
6. `src/i18n/locales/en/common.json` and `nl/common.json` -- new translation keys
7. Cron job SQL for daily/weekly digest scheduling

