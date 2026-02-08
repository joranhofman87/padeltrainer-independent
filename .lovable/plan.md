
# Show Academy Banner on Trainer Profile

## What changes
When a trainer belongs to an academy that has a banner image, that banner will be displayed at the top of the trainer's public profile page -- using the existing banner slot in `ProfileLayout`.

## Technical Details
This is a minimal change. All the data and UI infrastructure already exists:

- `trainerAcademy` is already fetched from `academy_profiles_public` (which includes `banner_url`)
- `ProfileLayout` already accepts a `bannerUrl` prop and renders a full-width banner image

### File: `src/pages/TrainerProfile.tsx`
Pass the academy's `banner_url` to `ProfileLayout`:

```tsx
<ProfileLayout
  bannerUrl={trainerAcademy?.banner_url}
  headerAction={...}
>
```

That's it -- no database changes, no new components, no new queries needed.
