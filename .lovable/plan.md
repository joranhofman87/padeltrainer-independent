

# Custom Welcome Message for Players

## Overview
When a player books a session, joins a waiting list, or registers for a cycle, they'll see a personalized message from the trainer, academy, or club. This lets owners share things like WhatsApp group links, preparation tips, or community invitations.

## How it works

**For trainers/academies/clubs (setting side):**
- A new "Welcome Message" card appears in their settings page
- They can write a short message (plain text with links) that players see after completing an action
- Example: "Thanks for signing up! Join our WhatsApp community: https://chat.whatsapp.com/..."

**For players (display side):**
- After a successful booking, waiting list signup, or cycle registration, the welcome message appears as a highlighted card on the confirmation screen
- If no message is configured, nothing extra shows -- the existing flow stays the same

## Technical Details

### 1. Database Migration
Add a `welcome_message` text column to three tables:
- `trainer_profiles` -- shown after booking a lesson or joining a trainer's waiting list
- `academy_profiles` -- shown after cycle registration or joining an academy's waiting list
- `club_profiles` -- shown after joining a club's waiting list

All nullable, no default value needed.

### 2. Settings Pages (input side)
Add a "Welcome Message" card with a textarea to:
- **`src/pages/TrainerBookingSettings.tsx`** -- natural fit alongside booking approval settings
- **`src/pages/academy/AcademySettings.tsx`** -- alongside general terms
- **`src/pages/club/ClubSettings.tsx`** -- alongside existing club settings

Each card will have a simple textarea and save button, following the existing patterns in those pages.

### 3. Confirmation Screens (display side)
Show the welcome message (if present) on these success screens:
- **`src/pages/BookingSuccess.tsx`** -- fetch from the trainer's profile after payment verification
- **`src/components/waitingList/WaitingListForm.tsx`** -- show in the success state (pass message as prop from parent or fetch after submit)
- **`src/pages/CycleRegistration.tsx`** -- show in the success state, fetched alongside cycle owner data

The message will render in a styled card with a "Message from [name]" header, auto-linking any URLs.

### 4. Translations
Add translation keys for:
- `welcomeMessage` (label)
- `welcomeMessageDescription` (helper text)
- `welcomeMessagePlaceholder` (textarea placeholder)
- `messageFrom` (display header)

Across all 5 languages (en, nl, de, es, fr).

### Files to modify
- `src/pages/TrainerBookingSettings.tsx` -- add welcome message textarea
- `src/pages/academy/AcademySettings.tsx` -- add welcome message card
- `src/pages/club/ClubSettings.tsx` -- add welcome message card
- `src/pages/BookingSuccess.tsx` -- display message after successful booking
- `src/components/waitingList/WaitingListForm.tsx` -- display message on success + accept message prop
- `src/components/waitingList/WaitingListCard.tsx` -- pass welcome message to form
- `src/pages/CycleRegistration.tsx` -- display message on registration success
- Translation files for all 5 languages (trainer, academy, club, waitingList namespaces)

