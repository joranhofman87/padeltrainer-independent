

## Support Multiple Videos on Trainer and Academy Profiles

### Current State
- Trainers have a single `video_url` text column on `trainer_profiles`, labeled "Intro Video" in the edit form
- The public trainer profile shows one embedded video in a "Meet Your Coach" section
- Academy profiles have no video support at all
- The `parseVideoUrl()` utility already supports YouTube, Vimeo, and TikTok

### What Changes

**1. New database table: `profile_videos`**

Instead of expanding the single `video_url` column, we create a dedicated table that supports multiple videos for both trainers and academies:

```text
profile_videos
- id (uuid, PK)
- trainer_profile_id (uuid, nullable, FK -> trainer_profiles)
- academy_profile_id (uuid, nullable, FK -> academy_profiles)
- video_url (text, not null)
- title (text, nullable) -- e.g. "Forehand technique", "Academy tour"
- sort_order (int, default 0)
- created_at (timestamptz)
```

A CHECK constraint ensures exactly one of `trainer_profile_id` or `academy_profile_id` is set. RLS policies allow owners/managers to manage their own videos, and public read for published profiles.

**2. Rename "Intro Video" to "Videos" in the trainer edit form**

In `EditProfile.tsx`, replace the single URL input with a mini video list:
- Show existing videos with title, thumbnail preview, and delete button
- "Add Video" button to add another entry (URL + optional title)
- Keep supporting YouTube, Vimeo, and TikTok via the existing `parseVideoUrl()` utility
- Help text updated: "Add YouTube, Vimeo, or TikTok videos to showcase your coaching"

**3. Migrate existing `video_url` data**

A migration will copy any existing `trainer_profiles.video_url` values into the new `profile_videos` table so no data is lost. The old column remains for backward compatibility but the UI will read from the new table.

**4. Update the public trainer profile page**

In `TrainerProfile.tsx`, the "Meet Your Coach" section becomes a video gallery:
- If one video: show it full-width as today
- If multiple: show them in a grid or vertical stack with titles
- Section title changes from "Meet Your Coach" to "Videos" (or the trainer's custom title for each)

**5. Add video support to academy profiles**

- **Academy edit page** (`AcademyProfile.tsx`): Add a "Videos" card section (same component as trainers) where academy managers can add/remove videos
- **Academy public profile** (`AcademyPublicProfile.tsx`): Display embedded videos in the same gallery format

**6. Instagram Reels support**

Update `parseVideoUrl()` in `videoEmbed.ts` to recognize Instagram post/reel URLs and generate embed URLs using `https://www.instagram.com/p/{id}/embed/` or `https://www.instagram.com/reel/{id}/embed/`. Help text updates to mention Instagram as well.

### Technical Details

**Database migration:**
```sql
CREATE TABLE profile_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_profile_id uuid REFERENCES trainer_profiles(id) ON DELETE CASCADE,
  academy_profile_id uuid REFERENCES academy_profiles(id) ON DELETE CASCADE,
  video_url text NOT NULL,
  title text,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT one_profile CHECK (
    (trainer_profile_id IS NOT NULL AND academy_profile_id IS NULL) OR
    (trainer_profile_id IS NULL AND academy_profile_id IS NOT NULL)
  )
);

-- Migrate existing data
INSERT INTO profile_videos (trainer_profile_id, video_url, title)
SELECT id, video_url, 'Intro'
FROM trainer_profiles
WHERE video_url IS NOT NULL AND video_url != '';

-- RLS
ALTER TABLE profile_videos ENABLE ROW LEVEL SECURITY;
-- Public read, owner/manager write policies
```

**Files to create:**
- `src/components/profiles/VideoGallery.tsx` -- Shared component for displaying embedded videos
- `src/components/profiles/VideoManager.tsx` -- Shared edit component (add/remove/reorder videos)

**Files to modify:**
- `src/lib/videoEmbed.ts` -- Add Instagram URL parsing
- `src/pages/EditProfile.tsx` -- Replace single video input with VideoManager
- `src/pages/TrainerProfile.tsx` -- Use VideoGallery instead of single embed
- `src/pages/academy/AcademyProfile.tsx` -- Add VideoManager section
- `src/pages/AcademyPublicProfile.tsx` -- Add VideoGallery section
- `src/i18n/locales/en/trainer.json` -- Rename "Intro Video" to "Videos", update help text
- `src/i18n/locales/nl/trainer.json` -- Same translations
- `src/i18n/locales/en/academy.json` -- Add video-related keys
- `src/i18n/locales/nl/academy.json` -- Same

