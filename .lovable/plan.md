
# Onboarding Email System for Admin

## Overview
Create a comprehensive onboarding email system that allows admins to configure automated email sequences for different user types (players, trainers, clubs, academy owners). Emails can be triggered based on signup or plan purchase, with configurable delays.

## Database Schema

### New Tables

**1. `onboarding_email_templates`**
Stores the email templates that admins can create and edit.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Internal template name (e.g., "Trainer Day 1 Welcome") |
| user_type | text | Target: 'player', 'trainer', 'club', 'academy' |
| trigger_type | text | 'signup' or 'paid_plan' |
| delay_days | integer | Days after trigger to send (0 = immediately) |
| subject | text | Email subject line |
| body_html | text | HTML email body content |
| is_active | boolean | Whether this email is active |
| created_at | timestamptz | Creation timestamp |
| updated_at | timestamptz | Last update timestamp |

**2. `onboarding_email_queue`**
Tracks scheduled emails and their send status.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| template_id | uuid | FK to onboarding_email_templates |
| user_id | uuid | Target user |
| email | text | Recipient email |
| user_name | text | Recipient name |
| scheduled_for | timestamptz | When to send |
| sent_at | timestamptz | When actually sent (null if pending) |
| status | text | 'pending', 'sent', 'failed', 'cancelled' |
| error_message | text | Error details if failed |
| created_at | timestamptz | Queue entry creation |

**3. `onboarding_email_logs`**
Audit log for sent emails.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| template_id | uuid | FK to template |
| queue_id | uuid | FK to queue entry |
| user_id | uuid | Recipient user |
| email | text | Recipient email |
| subject | text | Subject sent |
| sent_at | timestamptz | Send timestamp |
| status | text | 'sent', 'failed' |

## Architecture

```text
+------------------+     +---------------------+     +-------------------+
|  User Signs Up   | --> | Database Trigger    | --> | Queue Email       |
|  or Purchases    |     | (after insert/      |     | (calculate        |
|  Plan            |     |  update)            |     |  scheduled_for)   |
+------------------+     +---------------------+     +-------------------+
                                                              |
                                                              v
+------------------+     +---------------------+     +-------------------+
|  Email Sent      | <-- | Edge Function       | <-- | pg_cron Job       |
|  via Resend      |     | process-onboarding- |     | (runs every hour) |
|                  |     | emails              |     |                   |
+------------------+     +---------------------+     +-------------------+
```

## Implementation Components

### 1. Admin UI - New Page: `/admin/onboarding-emails`
- Add to sidebar under Settings group
- Table view of all templates
- Create/Edit dialog with:
  - Template name
  - User type dropdown (Player, Trainer, Club, Academy)
  - Trigger type dropdown (Signup, Paid Plan)
  - Delay days input (0-30)
  - Subject field
  - Rich text/HTML editor for body
  - Active toggle
- Preview functionality
- Send test email button

### 2. Database Triggers
- **On user signup**: When a profile is created for each type, queue relevant emails
- **On paid plan**: When subscription_status changes to 'active', queue relevant emails

### 3. Edge Function: `process-onboarding-emails`
- Called by pg_cron every hour
- Fetches pending emails where `scheduled_for <= now()`
- Sends via Resend
- Updates status to 'sent' or 'failed'
- Creates log entry

### 4. Template Variables
Support dynamic placeholders in email body:
- `{{user_name}}` - Full name
- `{{user_email}}` - Email address
- `{{user_type}}` - Role type
- `{{signup_date}}` - When they signed up
- `{{plan_name}}` - For paid plan triggers

## Files to Create/Modify

### New Files
1. `src/pages/admin/AdminOnboardingEmails.tsx` - Main admin page
2. `src/components/admin/OnboardingEmailDialog.tsx` - Create/edit dialog
3. `src/components/admin/OnboardingEmailPreview.tsx` - Preview component
4. `src/hooks/useOnboardingEmails.ts` - React Query hooks
5. `src/lib/onboardingEmails.ts` - API functions
6. `supabase/functions/process-onboarding-emails/index.ts` - Cron processor

### Modified Files
1. `src/App.tsx` - Add route
2. `src/components/admin/AdminSidebar.tsx` - Add nav item
3. `src/i18n/locales/en/admin.json` - Translations
4. `src/i18n/locales/nl/admin.json` - Translations

## Technical Details

### Database Migration
```sql
-- Create tables with RLS policies for admin-only access
-- Create database function to queue emails on triggers
-- Create pg_cron job to call edge function hourly
```

### Edge Function Flow
1. Query `onboarding_email_queue` for pending emails
2. Join with templates to get content
3. Replace template variables
4. Send via Resend API
5. Update queue status
6. Log to audit table

### Security
- Admin-only RLS on all tables
- Edge function validates admin role
- Rate limiting on cron job

## User Experience

### Admin Workflow
1. Navigate to Admin > Settings > Onboarding Emails
2. Click "Add Email" button
3. Fill in template details:
   - Name: "Trainer Welcome - Day 1"
   - User Type: Trainer
   - Trigger: Signup
   - Delay: 0 days
   - Subject: "Welcome to PadelTrainer! 🎾"
   - Body: HTML content with placeholders
4. Toggle active
5. Click Save

### Email Examples
- **Day 0 (Signup)**: Welcome email with getting started guide
- **Day 3**: Tips for completing profile
- **Day 7**: Feature highlight email
- **Day 14**: Engagement check-in
- **Day 1 (Paid Plan)**: Thank you + premium features guide
- **Day 7 (Paid Plan)**: Advanced features tutorial
