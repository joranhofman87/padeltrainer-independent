
# Continue: Custom Welcome Message Feature

## What's already done
- Database migration: `welcome_message` column added to `trainer_profiles`, `academy_profiles`, and `club_profiles`
- Translation keys added for trainer namespace (all 5 languages)
- Translation keys added for academy namespace (EN, DE only)
- Translation keys added for club namespace (EN only)
- Translation keys added for waitingList namespace (EN, NL only -- `messageFrom`)

## What still needs to be done

### 1. Missing translations
- **Academy**: add `welcomeMessage` keys to NL, ES, FR
- **Club**: add `welcomeMessage` keys to NL, DE, ES, FR
- **WaitingList**: add `messageFrom` key to DE, ES, FR

### 2. Settings pages (input side)
Add a "Welcome Message" card with textarea + save button to:
- **`src/pages/TrainerBookingSettings.tsx`** -- new Card below the approval card with a textarea, fetching/saving `welcome_message` from `trainer_profiles`
- **`src/pages/academy/AcademySettings.tsx`** -- new Card after the General Terms card, fetching/saving `welcome_message` from `academy_profiles`
- **`src/pages/club/ClubSettings.tsx`** -- new Card before the Language card, fetching/saving `welcome_message` from `club_profiles`

### 3. Confirmation screens (display side)
Show the welcome message (when present) on success screens:

- **`src/pages/BookingSuccess.tsx`** -- after payment is verified and trainer details are fetched, also fetch `welcome_message` from `trainer_profiles`. Display it in a styled card below the "What's next?" section with a "Message from [trainer name]" header. URLs in the message will be auto-linked.

- **`src/components/waitingList/WaitingListForm.tsx`** -- accept an optional `welcomeMessage` and `ownerName` prop. In the success state, if `welcomeMessage` is present, show it in a card below the success checkmark with a "Message from [name]" header.

- **`src/components/waitingList/WaitingListCard.tsx`** -- fetch `welcome_message` from the owner's profile table based on `ownerType`/`ownerId` and pass it down to `WaitingListForm`.

- **`src/pages/CycleRegistration.tsx`** -- when fetching owner info, also fetch `welcome_message`. On the success screen, show it in a styled card below the "What's next?" steps.

### 4. URL auto-linking utility
Create a small helper that converts plain-text URLs in the welcome message into clickable `<a>` tags so WhatsApp links and similar are clickable without requiring the trainer to know HTML.

## Files to modify
- 7 translation files (NL/ES/FR academy, NL/DE/ES/FR club, DE/ES/FR waitingList)
- `src/pages/TrainerBookingSettings.tsx`
- `src/pages/academy/AcademySettings.tsx`
- `src/pages/club/ClubSettings.tsx`
- `src/pages/BookingSuccess.tsx`
- `src/components/waitingList/WaitingListForm.tsx`
- `src/components/waitingList/WaitingListCard.tsx`
- `src/pages/CycleRegistration.tsx`
