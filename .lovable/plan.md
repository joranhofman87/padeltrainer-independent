

# Show Location Logos in Admin Table

## Overview
Add logo display to the location management table to help admins quickly identify which locations have logos configured.

---

## Changes Required

### File: `src/pages/admin/AdminLocations.tsx`

Update the Name column cell to show the logo when available, falling back to the MapPin icon:

**Current Code (line 347-351):**
```tsx
<TableCell>
  <div className="flex items-center gap-2">
    <MapPin className="h-4 w-4 text-muted-foreground" />
    <span className="font-medium">{location.name}</span>
  </div>
</TableCell>
```

**New Code:**
```tsx
<TableCell>
  <div className="flex items-center gap-2">
    {location.logo_url ? (
      <img
        src={location.logo_url}
        alt=""
        className="h-4 w-4 object-contain"
      />
    ) : (
      <MapPin className="h-4 w-4 text-muted-foreground" />
    )}
    <span className="font-medium">{location.name}</span>
  </div>
</TableCell>
```

---

## Visual Result

| Before | After |
|--------|-------|
| 📍 Padel Club Amsterdam | [logo] Padel Club Amsterdam |
| 📍 Tennis & Padel Rotterdam | 📍 Tennis & Padel Rotterdam |

- Locations with logos show the actual logo (4×4 pixels, same as emoticons)
- Locations without logos show the MapPin icon as before
- `object-contain` ensures logos aren't distorted

---

## Summary
Single file change to `AdminLocations.tsx` - conditionally render logo image or MapPin icon based on whether `logo_url` exists.

