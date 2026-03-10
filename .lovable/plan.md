

# Growth Hacks & Quick Wins Plan

## Current State Analysis

I've examined the codebase and identified several untapped growth opportunities:

**Strengths:**
- Solid SEO foundation with sitemap, structured data, hreflang
- PostHog analytics and event tracking in place
- Social sharing on trainer profiles (WhatsApp, LinkedIn, Twitter)
- Follow functionality for trainers
- PWA manifest exists
- Referral system integrated (Reditus)
- Sponsor banner system just implemented

**Gaps:**
- No review request flow after bookings
- Google Reviews data exists but not displayed
- No email capture on marketing pages
- No exit-intent capture
- BookingSuccess page doesn't ask for reviews or encourage shares
- No viral referral mechanics in booking flow
- PWA not optimized for app-like experience
- No social proof widgets (live booking feed, counter)
- Newsletter/lead magnets missing

---

## Recommended Growth Hacks (by impact)

### 1. **Post-Booking Review Request** (HIGH IMPACT)
**Problem:** After a successful booking, players see a generic success page. No review collection, no social sharing prompt.

**Solution:**
- Add a "How was your experience?" card to `BookingSuccess.tsx` 
- For first booking: Ask for Google/platform review with direct link
- For return bookings: Show trainer-specific review form
- Include social share buttons: "I just booked a padel lesson with [Trainer]!"
- Add referral incentive: "Get €5 off your next lesson when a friend books"

**Implementation:**
- Modify `BookingSuccess.tsx` to include review CTA
- Add review dialog component
- Create edge function `request-review-email` (7-day follow-up)
- Track conversion with PostHog

---

### 2. **Display Google Reviews on Location Pages** (HIGH IMPACT)
**Problem:** The database stores `google_rating` and `google_review_count` for 1400+ locations but this social proof isn't displayed anywhere.

**Solution:**
- Show Google rating stars + review count on `LocationDetail.tsx`
- Add "Read reviews on Google" link with UTM tracking
- Show top review snippets if available
- Include in location cards on `Trainers.tsx` search results

**Files:** `src/pages/LocationDetail.tsx`, `src/components/locations/LocationCard.tsx`

---

### 3. **Exit-Intent Email Capture** (MEDIUM-HIGH IMPACT)
**Problem:** Marketing pages have no email capture. Visitors leave without any follow-up mechanism.

**Solution:**
- Add exit-intent modal on `/nl`, `/en`, `/trainers` pages
- Offer lead magnet: "Free Padel Training Guide" or "€10 off first lesson"
- Simple form: email + language preference
- Store in new `email_subscribers` table with double opt-in
- Send weekly newsletter with new trainers, tips, promotions

**Implementation:**
- Create `<ExitIntentModal>` component with `beforeunload` / mouse-leave detection
- Add `email_subscribers` table with RLS
- Create `subscribe-newsletter` edge function
- Add to `Home.tsx`, `Trainers.tsx`, `TrainersCity.tsx`

---

### 4. **Live Social Proof Widget** (MEDIUM IMPACT)
**Problem:** Static testimonials don't create urgency or FOMO.

**Solution:**
- Add floating toast notification: "Anna just booked a lesson in Amsterdam" (real-time)
- Show counter: "1,234 lessons booked this month"
- Display on homepage and trainer directory
- Use `banner_events` table impressions + clicks OR create new `social_proof_events` stream

**Implementation:**
- Create `<LiveBookingToast>` component with Supabase Realtime subscription to `bookings` table
- Add aggregate query for monthly booking count
- Show on `Home.tsx` and `Trainers.tsx`

---

### 5. **Enhanced PWA with Install Prompt** (MEDIUM IMPACT)
**Problem:** PWA manifest exists but no install prompts or app-like features.

**Solution:**
- Add "Install App" banner for mobile users (iOS + Android)
- Improve manifest: better icons, shortcuts, categories
- Add offline fallback page
- Push notifications for followed trainers' new slots (requires user opt-in)

**Implementation:**
- Create `<InstallPWAPrompt>` component with `beforeinstallprompt` event
- Update `manifest.json` with shortcuts (bookings, trainers, account)
- Add service worker for offline support
- Request notification permission after first booking

---

### 6. **Booking Success Viral Loop** (MEDIUM IMPACT)
**Problem:** BookingSuccess page has "Book Another Lesson" but no social/referral mechanics.

**Solution:**
- Add prominent "Share & Get €5 Off" card
- Pre-filled social share: "I just booked a padel lesson with [Trainer] on @padeltrainer! 🎾"
- Show referral code: "Your friends get €10 off, you get €5 off"
- Gamify: "Invite 3 friends → 1 free lesson"

**Files:** `src/pages/BookingSuccess.tsx`

---

### 7. **Trainer Profile QR Codes** (LOW-MEDIUM IMPACT)
**Problem:** Trainers can't easily share their profiles offline (courts, clubs, flyers).

**Solution:**
- Add "Download QR Code" button on `TrainerProfile.tsx` (trainer view)
- Generate QR with profile URL + UTM params
- Include in confirmation emails: "Share your profile with players at the club!"

**Implementation:**
- Add QR generation library (`qrcode.react`)
- Create download function with canvas → PNG
- Add to trainer settings page

---

### 8. **Content Hub with SEO Blog** (HIGH LONG-TERM)
**Already exists** (`/blog`) but not heavily promoted:
- Add blog CTA on homepage
- Link to articles from trainer profiles ("Read about padel techniques")
- Create content series: "Beginner's Guide to Padel in [City]"
- Internal linking from city pages to relevant blog posts

**Quick Win:** Add blog link to footer + marketing nav

---

### 9. **Waitlist Viral Mechanics** (LOW-MEDIUM IMPACT)
**Problem:** Waitlist exists for cycles but no referral incentive.

**Solution:**
- "Move up the waitlist by inviting friends"
- Show position: "You're #12 in line. Share to jump ahead!"
- Track referrals and bump positions

**Files:** `src/pages/TrainerWaitingList.tsx`, `src/pages/CycleRegistration.tsx`

---

### 10. **Google My Business Integration** (MEDIUM IMPACT)
**Problem:** Location pages have Google Maps URLs but no GMB API integration.

**Solution:**
- Fetch reviews via Google Places API
- Display on `LocationDetail.tsx`
- Auto-update `google_rating` weekly via cron edge function

**Implementation:**
- Add Google Places API key to secrets
- Create `sync-google-reviews` edge function
- Schedule with `pg_cron` or external cron job

---

## Priority Matrix

| Priority | Effort | Impact | Feature |
|----------|--------|--------|---------|
| P0 | Low | High | Post-Booking Review Request |
| P0 | Low | High | Display Google Reviews |
| P1 | Medium | High | Exit-Intent Email Capture |
| P2 | Medium | Medium | Live Social Proof Widget |
| P2 | Medium | Medium | Booking Success Viral Loop |
| P3 | Low | Medium | Enhanced PWA Install |
| P3 | Low | Low | Trainer QR Codes |
| P4 | High | High | Google Places API Integration |

---

## Quick Wins (Next 2 Hours)

1. **Display Google Reviews** — Already in DB, just render on location pages
2. **Post-Booking Review CTA** — Add 1 card to `BookingSuccess.tsx`
3. **Blog Promo** — Add blog links to footer + nav
4. **Social Share Buttons** — Enhance `BookingSuccess.tsx` with pre-filled tweets

---

## Implementation Order

**Phase 1 (Week 1):**
1. Display Google Reviews on location pages
2. Post-booking review request flow
3. Blog promotion on homepage

**Phase 2 (Week 2):**
4. Exit-intent email capture
5. Booking success viral loop
6. Live social proof widget

**Phase 3 (Week 3):**
7. Enhanced PWA with install prompts
8. Trainer QR codes
9. Google Places API sync

---

## Files to Create/Modify

**New Components:**
- `src/components/growth/ExitIntentModal.tsx`
- `src/components/growth/LiveBookingToast.tsx`
- `src/components/growth/ReviewRequestCard.tsx`
- `src/components/growth/InstallPWAPrompt.tsx`
- `src/components/growth/SocialShareCard.tsx`

**Modify:**
- `src/pages/BookingSuccess.tsx` (review + share CTAs)
- `src/pages/LocationDetail.tsx` (Google reviews display)
- `src/pages/marketing/Home.tsx` (exit-intent, live proof)
- `src/components/locations/LocationCard.tsx` (rating stars)
- `src/components/marketing/MarketingLayout.tsx` (blog links)

**Database:**
- `email_subscribers` table (email, locale, subscribed_at, confirmed, source)
- `review_requests` table (booking_id, requested_at, completed_at, rating)

**Edge Functions:**
- `supabase/functions/subscribe-newsletter/index.ts`
- `supabase/functions/request-review-email/index.ts`
- `supabase/functions/sync-google-reviews/index.ts` (optional)

