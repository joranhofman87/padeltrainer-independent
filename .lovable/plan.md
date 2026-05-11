## Shorten forward-invoice signed URL TTL

Yes — `supabase/functions/forward-invoice/index.ts:137` issues a 7-day signed URL for the invoice PDF. Anyone with the link has unauthenticated access for a week, longer than necessary.

### Change
- Replace `604800` with `86400` (24 hours) and update the trailing comment.

No other files affected.
