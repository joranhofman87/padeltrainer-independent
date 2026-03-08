

# Analysis: How Easy Is It to Find and Book a Trainer?

## The Current Player Journey

I traced every path a new visitor can take from landing on the site to completing a booking. Here's what I found:

```text
Homepage → Trainers Directory → Trainer Profile → Book Page → Signup → Book Page (again) → Select Slot → Confirm
   │              │                    │                │
   │              │                    │                └── 4 steps on this page alone
   │              │                    └── 3 CTAs compete (Book / Follow / Contact / Share)
   │              └── No "Book Now" on trainer cards, only click-through
   └── Featured trainers section (good entry point)
```

## What Works Well

1. **Multiple discovery paths** — Homepage featured sections, trainer directory with filters/search/sort, city pages, club pages, academy pages, and open slots on profiles. Players won't struggle to *find* trainers.

2. **Rich trainer profiles** — Rating, hourly rate, experience, specializations, locations, coaching style, video, reviews. Plenty of information to make a decision.

3. **Booking page is well-structured** — Cycle bundles and individual slots are clearly separated, prices visible, slot selection is intuitive with visual feedback.

4. **Auth redirect preserves intent** — Unauthenticated users get redirected to signup with a `?redirect=` back to the booking page. This is critical and it's implemented correctly.

## Friction Points (Ranked by Impact)

### 1. HIGH: No "Book" or availability indicator on trainer cards in the directory
The trainer cards in `/trainers` show name, rating, price, and experience — but **no indication of availability**. A player has to click into every profile to discover if the trainer even has open slots. The `hasAvailability` boolean is fetched but **never rendered** on the card.

**Impact:** Players bounce between profiles blindly. This is the single biggest conversion killer.

### 2. HIGH: Booking requires signup before seeing slots
When an unauthenticated user clicks "Book Lesson" on a trainer profile, they're redirected to `/app/signup/player`. The booking page (`BookLesson.tsx` line 102-103) immediately redirects non-authenticated users away. Players can't even *see* what's available before committing to an account.

The trainer profile sidebar does show `TrainerOpenSlots`, which helps — but it's positioned below the fold in the sidebar column, easy to miss.

### 3. MEDIUM: Trainer directory has no "availability" filter
Filters include location, price, rating, experience, specializations, certifications, and verified status. But there's no filter for "has available slots" — the most relevant filter for someone ready to book.

### 4. MEDIUM: Too many CTAs on trainer profile compete for attention
The hero card has 4 buttons stacked vertically: Book Lesson, Follow, Contact, Share. Then the sidebar has "Book to Connect". Then there's a separate "Book a Lesson" card in the main column. The open slots section also links to the booking page. This dilutes the primary action.

### 5. LOW: Booking page header says "Book a Lesson" — not localized
`BookLesson.tsx` line 766: hardcoded English "Book a Lesson" and "with {name}" instead of using translation keys. Same for success states (lines 701, 726).

### 6. LOW: "Browse Other Trainers" on success goes to `/app/player` not `/trainers`
After booking (line 710-712), the "Browse Other Trainers" button navigates to the player dashboard, not the trainer directory.

## Recommendations

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1 | Show availability badge on trainer cards ("Available this week" / "No openings") using the existing `hasAvailability` field | Small | High |
| 2 | Add "Has availability" toggle filter to trainer directory | Small | Medium |
| 3 | Let anonymous users view the booking page (slots visible, "Sign up to book" on the confirm button) instead of redirecting them to signup | Medium | High |
| 4 | Reduce hero CTAs to 2 primary actions: "Book Lesson" (primary) and "Follow" (secondary). Move Contact/Share to a compact row or overflow menu | Small | Medium |
| 5 | Localize hardcoded strings in BookLesson.tsx | Small | Low |
| 6 | Fix post-booking "Browse Other Trainers" to navigate to trainer directory | Trivial | Low |

## Verdict

The bones are solid — the data model, payment flow, and profile richness are all there. The main gap is **discoverability of availability**. A player currently has to: find a trainer → click profile → scroll to open slots → click book → sign up → come back → pick a slot → confirm. The fastest wins would be surfacing availability on the trainer cards and letting anonymous users see slots before signing up.

