

# Add Test Email & Manual Recipient Management to Email Campaigns

## Summary
Two additions to the Compose view: (1) a "Send test" button that sends the email to a single address before launching the full campaign, and (2) the ability to manually add/remove individual recipients from the filtered list.

## Changes — `src/components/academy/EmailCampaignTab.tsx`

### 1. Manual recipient list management
- Replace the current `filteredRecipients` direct usage with a `recipients` state (`useState`) that gets initialized/reset whenever filters change
- Each player row in the recipients list gets a small X button to remove them
- Add a mini "Add recipient" row at the bottom of the list: a text input for email + name, with an "Add" button that appends a manual entry to the `recipients` list
- The "Selected recipients" count and the send button use this `recipients` state instead of `filteredRecipients`
- When filters change, reset `recipients` to the new `filteredRecipients` result (so manual edits are per-filter-session)

### 2. Send test email
- Add state: `testEmail` (string), `isSendingTest` (boolean)
- Next to the "Preview" button, add a "Send test" button
- Clicking it shows a small inline input for the test email address + a send button
- On submit: invoke the existing `send-campaign-emails` edge function in test mode — or simpler: call Resend directly via a new lightweight edge function call
- **Simpler approach**: reuse the existing edge function. Create a temporary campaign with `status: 'test'`, insert one recipient row with the test email, invoke the function, then clean up (delete the test campaign + recipient after)
- **Even simpler**: Add a `test_mode` flag to `send-campaign-emails` — when `{ testMode: true, testEmail, subject, bodyHtml }` is sent, it sends a single email without creating a campaign record. The edge function already has Resend configured.

### 3. Edge function update — `supabase/functions/send-campaign-emails/index.ts`
- Add handling for `testMode: true` in the request body
- When test mode: skip campaign lookup, skip recipient lookup, just send one email to `testEmail` with the provided `subject` and `bodyHtml` (replacing `{{name}}` with "Test User")
- Still verify auth + academy manager role
- Return `{ success: true, test: true }`

## Result
- Admin can type a test email address and send a single preview before committing
- Admin can remove players from the recipient list or manually add email addresses that aren't in the player database

