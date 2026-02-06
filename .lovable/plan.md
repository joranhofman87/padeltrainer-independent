
# Fix BookingSuccess: Calendar Link + Book Another Lesson Route

## Two Issues

### 1. "Add to your calendar" is not clickable
Currently it's just static text inside a `<li>`. It needs to be a clickable element that generates a Google Calendar / ICS link. To do this properly, we need the booking's slot details (date/time, trainer name). The component will fetch this data alongside the payment status check.

### 2. "Book Another Lesson" goes to `/app/trainers` (trainer listing) instead of the specific trainer's booking page
The user wants to return to the trainer they just booked with. We need to fetch the trainer's slug from the booking and navigate to `/:lang/book/:slug`.

## Changes

### File: `src/pages/BookingSuccess.tsx`

**a) Fetch booking details alongside payment status**

When polling the `bookings` table, expand the query to also retrieve:
- `availability_slots.start_time`, `availability_slots.end_time`, `availability_slots.trainer_id`
- `trainer_profiles.slug`, `trainer_profiles.full_name` (via the trainer_id)

Store this data in state so both buttons can use it.

**b) Make "Add to your calendar" a clickable link**

Generate a Google Calendar URL using the slot's start/end times and trainer name. Format:
```
https://calendar.google.com/calendar/render?action=TEMPLATE&text=Padel+Lesson+with+TrainerName&dates=START/END&details=...
```

Wrap the list item in an `<a>` tag that opens this URL in a new tab.

**c) Fix "Book Another Lesson" to navigate to the trainer's booking page**

Use the fetched trainer slug to navigate to `/:lang/book/:slug` (the public booking page). Fall back to `/app/trainers` if the slug isn't available.

### File: `supabase/functions/create-mollie-payment/index.ts`

No changes needed -- all data can be fetched client-side from the booking ID.

## Technical Details

- The booking query becomes: `bookings(payment_status, availability_slots(start_time, end_time, trainer_id, trainer_profiles(slug, full_name)))`
- Google Calendar URL format uses ISO dates without dashes/colons (e.g., `20250206T140000Z`)
- Language prefix for the booking link will use `i18next` current language or default to `nl`
- The "Add to your calendar" item will visually change to look clickable (underline/hover effect)

## Files to Change

1. `src/pages/BookingSuccess.tsx` -- fetch booking details, add calendar link, fix trainer navigation
