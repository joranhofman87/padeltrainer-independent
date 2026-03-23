

# Translate Hardcoded English Strings in EditProfile

## Problem
The Edit Profile page (`/app/trainer/profile`) has ~30 hardcoded English strings that don't go through i18n.

## Hardcoded Strings Found

**Header & buttons:**
- "Edit Profile" (line 490)
- "Saving..." / "Save" (line 494)
- "Save Changes" / "Saving..." (line 1076)

**Avatar section:**
- "Your Name" fallback (line 561)
- "User" fallback (line 562)
- "Uploading..." / "Change photo" (line 569)

**Basic Information card:**
- "Basic Information" title (line 581)
- "Full Name" label (line 587)
- "Phone" label (line 613)
- "Location" label (line 622)
- "Bio" label (line 633)
- Placeholder "Tell us about yourself..." (line 638)

**Player Details card:**
- "Player Details" title (line 649)
- "Your padel skill information" description (line 650)
- "Padel Rating" label (line 712)
- "(lower is better)" text (line 727)
- "Your official ... registration number" (line 706)

**Trainer Details card:**
- "Trainer Details" title (line 941)
- "Your professional information" description (line 942)
- "Hourly Rate (€)" label (line 947)
- "Coaching Since (year)" label (line 962)
- "Your Padel Rating" label (line 979)
- "Rating System" labels (lines 870, 982)
- "Rating" label (line 1007)
- "Certifications" label (line 1039)
- "Specializations" label (line 1048)
- "Teaching Locations" label (line 1059)
- "Where do you offer training?..." description (line 1062)
- "(lower is better)" (line 1028)
- "Level range:" (line 907)

**Toast messages:**
- "Avatar updated" / "Your profile picture has been updated." (lines 333-334)
- "Profile updated" / "Your changes have been saved." (lines 443-444)
- "Upload failed" (line 339)
- "Invalid file type" / "File too large" (lines 283, 293)

## Changes

### `src/i18n/locales/en/player.json` + `nl/player.json`
Add keys under `editProfile.*` for all shared and player-specific strings.

### `src/i18n/locales/en/trainer.json` + `nl/trainer.json`
Add keys under `editProfile.*` for trainer-specific strings (details card, locations, certifications).

### `src/pages/EditProfile.tsx`
Replace all hardcoded strings with `t()` / `tTrainer()` calls using the new keys. No layout or logic changes.

