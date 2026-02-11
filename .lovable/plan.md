

## Slack Notifications for Major Platform Events

### Overview

Create a centralized `slack-notify` edge function and integrate it into all critical platform flows. You'll need to set up a Slack Incoming Webhook first.

### Setup Required

You'll need to create a Slack Incoming Webhook URL:
1. Go to your Slack workspace settings
2. Create a new app (or use an existing one) at https://api.slack.com/apps
3. Enable "Incoming Webhooks" and create a webhook for your desired channel
4. Copy the webhook URL -- you'll be asked to save it as a secret

### Events to Track

| Event | Source | Details Sent |
|-------|--------|-------------|
| New trainer signup | `signup-user` edge function | Name, email |
| New player signup | `signup-user` edge function | Name, email |
| New club signup | Database trigger (club_profiles insert) or existing flow | Club name |
| New academy signup | Database trigger (academy_profiles insert) or existing flow | Academy name |
| New booking created | `BookLesson.tsx` via a post-insert call | Player, trainer, date/time, price |
| Booking payment received | `mollie-webhook` edge function | Player, trainer, amount |
| Trainer profile published | `TrainerSettings` page (is_published toggle) | Trainer name, profile link |
| Subscription purchased | `mollie-subscription-webhook` edge function | Trainer/club name, plan, amount |

### Additional Suggested Events

- **New review posted** -- useful to see social proof activity
- **Account deletion requested** -- important to monitor churn
- **New club claim** -- administrative awareness

### Implementation

**1. New edge function: `slack-notify`**

A simple function that accepts an event type and data payload, formats it into a Slack Block Kit message, and posts it to the webhook URL. All other functions call this one internally via `supabase.functions.invoke('slack-notify', ...)`.

```text
POST /slack-notify
Body: { event: "new_signup", data: { name, email, role } }
```

Each event type gets a distinct emoji and formatted message:
- "New Signup" with user emoji
- "Booking Created" with calendar emoji
- "Payment Received" with money emoji
- "Profile Published" with rocket emoji
- "Subscription Purchased" with star emoji

**2. Integrate into existing edge functions**

Add a non-blocking `supabase.functions.invoke('slack-notify', ...)` call (wrapped in try/catch so failures never break the main flow) to:

- `signup-user/index.ts` -- after successful user creation
- `mollie-webhook/index.ts` -- after payment confirmed (status "paid")
- `mollie-subscription-webhook/index.ts` -- after subscription activated

**3. Integrate into frontend flows (via send-email or a lightweight edge call)**

For events triggered from the frontend:
- **Booking created** (`BookLesson.tsx`): Call slack-notify after successful booking insert
- **Profile published** (`TrainerSettings`): Call slack-notify when is_published toggled to true

These will go through the edge function with the user's auth token.

**4. Config**

Add `verify_jwt = false` for `slack-notify` in `supabase/config.toml` (since it will be called by other edge functions using service role).

### Files to Create
- `supabase/functions/slack-notify/index.ts`

### Files to Modify
- `supabase/config.toml` -- add slack-notify config
- `supabase/functions/signup-user/index.ts` -- add notification after user created
- `supabase/functions/mollie-webhook/index.ts` -- add notification after payment confirmed
- `supabase/functions/mollie-subscription-webhook/index.ts` -- add notification after subscription activated
- `src/pages/BookLesson.tsx` -- add notification after booking created
- Trainer settings page (where is_published is toggled) -- add notification on publish

### Secret Needed
- `SLACK_WEBHOOK_URL` -- the Incoming Webhook URL from your Slack app

