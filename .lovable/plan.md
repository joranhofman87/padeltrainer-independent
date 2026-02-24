

# In-App Notifications: Table, Realtime, and Edge Functions

## Overview
Create the notifications infrastructure: a `notifications` table with RLS and realtime, plus two edge functions for sending notifications programmatically.

## Changes

### 1. Database Migration
Create the `notifications` table with the schema you specified:
- `id` (uuid, primary key)
- `user_id` (uuid, references auth.users, NOT NULL)
- `title` (text, NOT NULL)
- `body` (text, NOT NULL)
- `data` (jsonb, nullable)
- `read` (boolean, default false)
- `created_at` (timestamptz, default now())

RLS policies:
- Users can SELECT their own notifications
- Users can UPDATE their own notifications (mark as read)
- Users can DELETE their own notifications

Enable realtime via `ALTER PUBLICATION supabase_realtime ADD TABLE notifications`.

### 2. Edge Function: `send-push`
Creates a single notification for one user. Accepts:
- `user_id`, `title`, `body`, `data` (optional)

Protected by JWT validation (service-role or authenticated admin/system calls).

### 3. Edge Function: `send-push-bulk`
Creates notifications for multiple users at once. Accepts an array of notification objects. Configured with `verify_jwt = false` in `config.toml` so it can be called from other backend functions, cron jobs, or webhooks without a user JWT. Will validate using the service role key internally.

### 4. Config update
Add `verify_jwt = false` for `send-push-bulk` to `supabase/config.toml`.

## Technical Details

### `send-push/index.ts`
- Validates the JWT using `getClaims()`
- Inserts a single row into `notifications` using a service-role client
- Returns the created notification

### `send-push-bulk/index.ts`
- Validates using `SUPABASE_SERVICE_ROLE_KEY` header check (since JWT is disabled)
- Accepts `{ notifications: [{ user_id, title, body, data? }] }`
- Bulk-inserts into `notifications`
- Returns count of inserted notifications

### Pre-existing build errors
The build errors shown (in `forward-invoice`, `mollie-subscription-webhook`, `reconcile-subscriptions`, `send-email`) are pre-existing and unrelated to this change. They will not be addressed in this task.

