
# Plan: Academy Banner Upload

## Overview

Add the ability for academy managers to upload a custom banner image for their academy profile. The banner will be displayed on the public academy profile page (already supported in the UI) and can be managed from the Academy Profile settings page.

## How It Works

```text
+------------------+     +----------------------+     +-------------------+
|  Academy Manager | --> |  AcademyProfile.tsx  | --> |  Supabase Storage |
|  (Profile Page)  |     |  (Upload UI)         |     |  avatars/academies/|
+------------------+     +----------------------+     +-------------------+
         |                         |                           |
         |  1. Select banner       |  2. Validate dimensions   |  3. Store file
         |     image               |     & upload to storage    |     & update DB
         v                         v                           v
    File picker UI         Image validation          Public URL saved
                           (800-2400px width,        to banner_url field
                            2.5:1 - 5:1 ratio)
```

## Implementation

### 1. Database Migration: Storage RLS Policies for Academies

Add storage policies so academy managers can upload to `academies/` folder in the avatars bucket:

| Policy | Command | Purpose |
|--------|---------|---------|
| Academy managers can upload | INSERT | Allow uploading logo/banner to `academies/{academy_id}/` |
| Academy managers can update | UPDATE | Allow replacing existing images |

### 2. Update Academy Profile Page

**File:** `src/pages/academy/AcademyProfile.tsx`

Add a banner upload section similar to the existing club profile implementation:
- Show current banner preview if one exists
- Upload button with file picker
- Image dimension validation (width: 800-2400px, aspect ratio 2.5:1 to 5:1)
- Loading state during upload
- Store file at path: `academies/{academy_id}/banner.{ext}`

### 3. Add Translations

**Files:** `src/i18n/locales/en/academy.json` and `src/i18n/locales/nl/academy.json`

Add banner-related translation keys to the profile section:
- `profile.banner` - Section title
- `profile.bannerDescription` - Explanation text
- `profile.bannerSizeHint` - Size recommendations
- `profile.uploadBanner` / `profile.changeBanner` - Button labels
- `profile.bannerUpdated` - Success message
- Validation error messages

## Technical Details

### Storage Path Structure
```text
avatars/
  academies/
    {academy_id}/
      logo.png
      banner.jpg
```

### Image Validation Rules (matching club banner)
| Constraint | Value |
|------------|-------|
| Min width | 800px |
| Max width | 2400px |
| Aspect ratio | 2.5:1 to 5:1 (wide banner) |
| Max file size | 10MB |
| Accepted formats | image/* |

### RLS Policy SQL
```sql
-- Academy managers can upload to academies folder
CREATE POLICY "Academy managers can upload academy images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'academies' AND
  ((storage.foldername(name))[2])::uuid IN (
    SELECT get_user_academy_ids(auth.uid())
  )
);

-- Academy managers can update their academy images
CREATE POLICY "Academy managers can update academy images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' AND
  (storage.foldername(name))[1] = 'academies' AND
  ((storage.foldername(name))[2])::uuid IN (
    SELECT get_user_academy_ids(auth.uid())
  )
);
```

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| Database migration | Create | Add storage RLS policies for academy uploads |
| `src/pages/academy/AcademyProfile.tsx` | Modify | Add banner upload UI with validation |
| `src/i18n/locales/en/academy.json` | Modify | Add English banner translations |
| `src/i18n/locales/nl/academy.json` | Modify | Add Dutch banner translations |

## UI Preview

The banner upload section will appear as a new card in the Academy Profile page:

```text
+--------------------------------------------------+
|  Banner                                          |
|  Displayed at the top of your public profile     |
|  Recommended: 1200×400px (3:1 ratio), max 10MB   |
|                                                  |
|  +--------------------------------------------+  |
|  |            [Current Banner Preview]         |  |
|  +--------------------------------------------+  |
|                                                  |
|  [Upload Banner] or [Change Banner]              |
+--------------------------------------------------+
```

## Expected Outcome

After implementation:
- Academy managers can upload a banner from their profile settings
- Banner displays on the public academy profile page (already rendering `banner_url`)
- Images are securely stored with proper RLS policies
- Consistent UX with the existing club banner upload feature
