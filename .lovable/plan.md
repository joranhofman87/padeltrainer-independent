

# Fix "Trainer not found" on Booking Page

## Problem

The booking page (`/nl/book/trainer-test`) receives `trainer-test` as the `trainerId` URL parameter. However, the `BookLesson.tsx` code assumes this is always a `user_id` and queries:

```
trainer_profiles_safe.eq('user_id', 'trainer-test')  -- 400 Bad Request
```

This fails because `trainer-test` is a **slug**, not a UUID. The trainer profile page already handles this correctly by checking if the param is a UUID and falling back to a slug lookup.

## Solution

Apply the same slug-vs-UUID resolution logic from `TrainerProfile.tsx` to `BookLesson.tsx`.

## Technical Changes

### `src/pages/BookLesson.tsx` -- `fetchData()` function (~lines 112-133)

1. Add UUID detection (same regex used in TrainerProfile):
   ```
   const isUUID = /^[0-9a-f]{8}-...$/i.test(trainerId)
   ```

2. If UUID: query `trainer_profiles_safe` with `.eq('user_id', trainerId)` (existing behavior, for backward compat)
3. If slug: query `trainer_profiles_safe` with `.eq('slug', trainerId)` (new path)

4. After resolving the trainer profile, use `trainerData.user_id` for the `profiles_public` and `profiles` lookups (instead of the raw `trainerId` param)

5. Also fix the auth redirect on line 99 which currently navigates to `/auth` (missing `/app/` prefix):
   ```
   navigate(`/app/auth?redirect=/book/${trainerId}`)
   ```

6. Fix line 101 which navigates to `/trainer` (should be `/app/trainer`):
   ```
   navigate('/app/trainer')
   ```

These changes ensure the booking page works when linked from the trainer profile using the SEO-friendly slug URL.

