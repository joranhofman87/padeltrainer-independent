

# Add Logo Upload for Locations in Admin Dialog

## Overview
Enable admins to upload logo images directly for locations, instead of only being able to paste URLs. This follows the same pattern used for trainer avatars and academy logos.

---

## Changes Required

### 1. Add Storage RLS Policies for Locations Folder
**Type: Database Migration**

Create policies to allow admins to upload, update, and delete images in the `locations/` folder of the `avatars` bucket:

```sql
-- Allow admins to upload location images
CREATE POLICY "Admins can upload location images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);

-- Allow admins to update location images
CREATE POLICY "Admins can update location images"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);

-- Allow admins to delete location images
CREATE POLICY "Admins can delete location images"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars' 
  AND (storage.foldername(name))[1] = 'locations'
  AND public.is_admin(auth.uid())
);
```

---

### 2. Update LocationEditDialog Component
**File: `src/components/admin/LocationEditDialog.tsx`**

Add image upload functionality following the pattern from `AcademyEditDialog`:

**Add imports:**
- `useRef` (already imported via useState)
- `Upload` icon from lucide-react
- `supabase` client

**Add state/refs:**
```typescript
const logoInputRef = useRef<HTMLInputElement>(null);
const [logoUploading, setLogoUploading] = useState(false);
```

**Add upload handler:**
```typescript
const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    toast({ title: "Error", description: "Please upload an image file.", variant: "destructive" });
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    toast({ title: "Error", description: "File size must be under 5MB.", variant: "destructive" });
    return;
  }

  setLogoUploading(true);
  try {
    const fileExt = file.name.split(".").pop();
    // Use location id if editing, or a temp id for new locations
    const locationId = location?.id || `temp-${Date.now()}`;
    const filePath = `locations/${locationId}/logo.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, file, { upsert: true });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    const newUrl = publicUrlData.publicUrl + "?t=" + Date.now();
    updateField('logo_url', newUrl);
    toast({ title: "Logo uploaded", description: "Logo image uploaded successfully." });
  } catch (error: any) {
    console.error("Error uploading logo:", error);
    toast({ title: "Error", description: error.message || "Failed to upload logo.", variant: "destructive" });
  } finally {
    setLogoUploading(false);
  }
};
```

**Update Media section UI (lines 356-380):**

Replace the simple Logo URL input with an input + upload button:

```tsx
<div className="space-y-4">
  <h3 className="text-sm font-medium text-muted-foreground">Media</h3>
  <div className="space-y-2">
    <Label htmlFor="logo_url">Logo</Label>
    <div className="flex gap-2">
      <Input
        id="logo_url"
        value={formData.logo_url}
        onChange={e => updateField('logo_url', e.target.value)}
        placeholder="URL or upload"
        className="flex-1"
      />
      <input
        ref={logoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleLogoUpload}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => logoInputRef.current?.click()}
        disabled={logoUploading}
      >
        {logoUploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
      </Button>
    </div>
    {formData.logo_url && (
      <div className="mt-2">
        <img
          src={formData.logo_url}
          alt="Logo preview"
          className="h-16 w-16 object-contain rounded-md border"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      </div>
    )}
  </div>
</div>
```

---

## Files to Modify

| File | Change |
|------|--------|
| Database migration | Add RLS policies for `locations/` folder in `avatars` bucket |
| `src/components/admin/LocationEditDialog.tsx` | Add upload button, ref, state, and handler |

---

## Result
- Admins can upload logos directly by clicking the upload button
- Uploaded logos are stored in `avatars/locations/{location_id}/logo.{ext}`
- Existing URL input still works for pasting external URLs
- Preview shows the uploaded/entered logo
- Same UX pattern as AcademyEditDialog for consistency

