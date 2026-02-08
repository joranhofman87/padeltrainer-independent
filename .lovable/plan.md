

# Sync Admin Location Edit with Club Profile Data

## Problem
The club owner saves their description (and contact info, social links) to the `club_profiles` table, but the admin's Location Edit Dialog only shows fields from the `locations` table. So when a club owner updates their description, the admin sees stale or empty data because they're looking at a different table.

## Solution
Expand the "Club Management" section in the Location Edit Dialog to also fetch and display the club profile's description, contact email, phone, and social links. This way the admin sees exactly what the club owner has set, and can edit it too.

## Changes to `src/components/admin/LocationEditDialog.tsx`

1. **Expand ClubData interface** -- add `description`, `contact_email`, `phone`, `social_instagram`, `social_facebook`, `social_tiktok`, `social_youtube`, `social_linkedin` fields.

2. **Update the fetch query** -- include these new fields in the `select()` call when loading the linked club profile.

3. **Expand the Club Management UI section** -- add form fields for:
   - Club Description (textarea)
   - Contact Email
   - Phone
   - Social links (Instagram, Facebook, TikTok, YouTube, LinkedIn)

4. **Update the save logic** -- include these new fields in the `club_profiles` update call.

This ensures the admin always sees and can edit the same data the club owner manages.

