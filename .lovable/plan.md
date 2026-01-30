
# Plan: Create Full Location Edit Dialog for Admin

## Overview

The current location edit dialog in the admin panel only shows basic fields (name, city, address, courts). The user wants the ability to edit ALL location fields including logo, description, contact info, and social links - similar to how the ClubEditDialog works.

## Current State

The inline dialog in `AdminLocations.tsx` (lines 328-444) only edits:
- Name, City, Country
- Street Address, Postal Code
- Website URL, Slug
- Indoor/Outdoor Courts
- Active status

**Missing fields from the Location type:**
- `description` (text)
- `logo_url` (image URL)
- `phone`, `email` (contact info)
- `facebook_url`, `instagram_url` (social links)
- `google_maps_url`, `google_rating`, `google_review_count` (Google data)
- `opening_hours` (text)
- `latitude`, `longitude` (coordinates)

## Solution

Create a new `LocationEditDialog` component following the same tabbed pattern as `ClubEditDialog`:

| Tab | Fields |
|-----|--------|
| **Basic** | Name, City, Country, Street Address, Postal Code, Slug, Active |
| **Details** | Description, Website URL, Courts (Indoor/Outdoor), Opening Hours |
| **Contact** | Phone, Email |
| **Media** | Logo URL (with preview) |
| **Social & Maps** | Facebook, Instagram, Google Maps URL, Google Rating, Google Review Count |
| **Location** | Latitude, Longitude |

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/admin/LocationEditDialog.tsx` | Create | New dialog component with all location fields in tabs |
| `src/pages/admin/AdminLocations.tsx` | Modify | Replace inline dialog with new `LocationEditDialog` component |

## Component Structure

```typescript
interface LocationEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;  // null = add mode
  onSuccess: () => void;
}
```

**Tab Layout:**

```text
+------------------------------------------------------------------+
| Edit Location: T.P.V. Udenhout                                   |
+------------------------------------------------------------------+
| [Basic] [Details] [Contact] [Media] [Social] [Coords]            |
+------------------------------------------------------------------+
|                                                                  |
| Basic Tab:                    Details Tab:                       |
| - Name *                      - Description (textarea)           |
| - City *                      - Website URL                      |
| - Country                     - Indoor Courts                    |
| - Street Address              - Outdoor Courts                   |
| - Postal Code                 - Opening Hours (textarea)         |
| - Slug                                                           |
| - Active (switch)             Media Tab:                         |
|                               - Logo URL + preview               |
| Contact Tab:                                                     |
| - Phone                       Social Tab:                        |
| - Email                       - Facebook URL                     |
|                               - Instagram URL                    |
| Coords Tab:                   - Google Maps URL                  |
| - Latitude                    - Google Rating                    |
| - Longitude                   - Google Review Count              |
+------------------------------------------------------------------+
|                                  [Cancel]  [Save]                |
+------------------------------------------------------------------+
```

## Implementation Details

1. **Create LocationEditDialog.tsx**
   - Follow ClubEditDialog pattern with Tabs component
   - Include all Location fields organized by category
   - Logo URL field with image preview
   - Validation for required fields (name, city)
   - Auto-generate slug from name + city if empty

2. **Update AdminLocations.tsx**
   - Import and use `LocationEditDialog`
   - Replace inline Dialog with the new component
   - Simplify `openEditDialog` and `openAddDialog` to just set state
   - Move save logic to the dialog component

## Visual Result

The admin will have a comprehensive edit dialog with all location fields organized in tabs, matching the pattern already established for clubs and academies.
