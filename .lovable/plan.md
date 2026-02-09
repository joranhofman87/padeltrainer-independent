

## Fix 5 Remaining Cleanup Items

### 1. Fix the 404: Remove `/app/club/lessons` nav link from ClubSidebar

**File:** `src/components/club/ClubSidebar.tsx`
- Remove the `/app/club/lessons` sub-menu item (lines 310-319)
- Remove `/app/club/lessons` from the `scheduleOpen` state initializer (line 76)
- Remove `/app/club/lessons` from the `isActive` check in the schedule group trigger (line 284)
- Since "Calendar" becomes the only sub-item under "Schedule", simplify to a direct nav link (remove the collapsible wrapper) or keep it as a single-item group

### 2. DB Migration: Drop `max_lessons` column

Run a migration:
```sql
ALTER TABLE subscription_plans DROP COLUMN IF EXISTS max_lessons;
```

### 3. Translation Updates -- Replace "lesson" with "training session" / "trainingssessie"

Most visible user-facing strings to update across 10 translation files:

**EN marketing.json:**
- `home.stats.lessons`: "Lessons Booked" -> "Sessions Booked"

**NL marketing.json:**
- `home.stats.lessons`: "Geboekte Lessen" -> "Geboekte Sessies"

**EN common.json:**
- `locations.bookLesson`: "Book Lesson" -> "Book Session"

**NL common.json:**
- `locations.bookLesson`: "Boek Les" -> "Boek Sessie"

**EN trainer.json (key changes):**
- `nav.lessons`: "Lessons" -> "Sessions"
- `dashboard.subtitle`: "Manage your lessons..." -> "Manage your training sessions..."
- `dashboard.createLesson`: "Create Lesson" -> "Create Session"
- `dashboard.stats.upcomingLessons`: "Upcoming Lessons" -> "Upcoming Sessions"
- `dashboard.setup.steps.lessons.title`: "Create Lessons" -> "Create Schedule"
- `dashboard.setup.steps.lessons.description`: "Add your first lesson type" -> "Add your first training session"
- `lessons.title`: "My Lessons" -> "My Sessions"
- `lessons.createNew`: "Create New Lesson" -> "Create New Session"
- All `lessons.form.*` labels updated
- `players.subtitle`/`addPlayerDescription`/`createFirst`/`bookLesson`: "lessons" -> "sessions"
- `bookings.emptyDescription`: "book your lessons" -> "book your sessions"
- `calendar.addSlotDescription`: "for lessons" -> "for sessions"
- `calendar.linkLesson`/`noLesson`: update wording
- `openSlots.noLesson`: "No lesson linked" -> "No session linked"
- `availability.noSlotsDescription`: "for lessons" -> "for sessions"

**NL trainer.json:**
- Mirror all above changes with Dutch equivalents ("Lessen" -> "Sessies", "Les" -> "Sessie", etc.)

**EN player.json:**
- `trainerProfile.lessons`: "Available Lessons" -> "Available Sessions"
- `trainerProfile.noLessons`: "No lessons available" -> "No sessions available"
- `trainerProfile.bookLesson`: "Book Lesson" -> "Book Session"
- `booking.title`: "Book a Lesson" -> "Book a Session"
- `booking.noSlots`: "for this lesson" -> "for this session"
- `booking.lesson`/`booking.success.description`: update
- `bookings.emptyDescription`: "Book your first lesson" -> "Book your first session"
- `players.bookLesson`: "Book Lesson" -> "Book Session"

**NL player.json:**
- Mirror with Dutch equivalents

**EN club.json:**
- `nav.lessons`: "Lessons" -> "Sessions"
- `lessons.*` section: update all "Lesson" -> "Session"
- `calendar.noLessonsForTrainer`: update

**NL club.json:**
- Mirror with Dutch equivalents

**EN/NL cycles.json:**
- `application.title`: "Apply for Lessons" -> "Apply for Training"
- `application.applyButton`: "Apply for Lessons" -> "Apply for Training"
- `form.lessonTypes`: Keep as "Lesson Types" (this is a training format selector -- private/duo/group -- not a reference to the deleted table)

**EN/NL admin.json:**
- `maxLessons`: Remove this key

### 4. Rename `usePlatformStats`: `lessons` to `sessions`

**File:** `src/hooks/usePlatformStats.ts`
- Rename `lessons` to `sessions` in the `PlatformStats` interface
- Rename the variable in the query and state setter
- Update the comment from "lessons delivered" to "sessions completed"

**File:** `src/pages/marketing/Home.tsx`
- Update `platformStats.lessons` to `platformStats.sessions`

### 5. Logger Migration: Move `console.error/warn` to `logger` in lib files

Replace `console.error`/`console.warn` with `logger.error`/`logger.warn` in these 10 files (excluding `logger.ts` itself which legitimately uses console):

- `src/lib/lessons.ts` (1 call)
- `src/lib/contentful.ts` (4 calls)
- `src/lib/tournaments.ts` (5 calls)
- `src/lib/email.ts` (3 calls)
- `src/lib/cities.ts` (3 calls)
- `src/lib/waitingList.ts` (2 calls)
- `src/lib/ratingSystems.ts` (1 call)
- `src/lib/academyPayments.ts` (1 call)
- `src/lib/auth.ts` (4 calls)
- `src/lib/calendar.ts` (1+ calls)

Each file will need `import { logger } from '@/lib/logger';` added (if not already imported), and each `console.error('msg', error)` replaced with `logger.error('msg', error as Error, { component: 'filename' })` or `logger.warn(...)` as appropriate.

