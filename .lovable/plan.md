

# Academy Public Profile: Visual Cleanup & Cycle Location

## Changes

### 1. `src/pages/AcademyPublicProfile.tsx` — Hero cleanup + side-by-side stats

**Remove from ProfileHeroCard:**
- `socialLinks` prop (line 305)
- `isVerified` prop (line 304) — move verified badge to quick stats
- Website button (lines 320-330)
- Share dropdown (lines 331-357)

**Keep:** Only the Follow button (if applicable) or no children at all.

**Layout change:** Wrap hero card + quick stats side-by-side like trainer profile:
```
<div className="flex flex-col lg:flex-row gap-4 mb-8">
  <div className="lg:flex-1">
    <ProfileHeroCard ... />
  </div>
  <div className="lg:w-[320px] flex-shrink-0 space-y-4">
    <ProfileQuickStatsCard ... />  ← moved from sidebar
    {/* About card */}
  </div>
</div>
```

Add verified status as a stat in quickStats array (with CheckCircle icon).

**Remove Quick Stats and About from sidebar** — they move next to the hero.

**Remove the Contact Info card** from sidebar (if present).

### 2. `src/components/academy/AcademyOpenCycles.tsx` — Show location on cycle cards

Add location name display to each cycle card. The data is already available via `cycle.location?.name`.

Add a MapPin icon + location name in the metadata row (line 121-148 area):
```tsx
{cycle.location?.name && (
  <span className="flex items-center gap-1">
    <MapPin className="h-4 w-4" />
    {cycle.location.name}
  </span>
)}
```

### 3. Spacing/padding

Ensure `gap-4` or `gap-6` between all major card sections. The content grid and full-width sections already use spacing — verify `space-y-4` on cycle items and `gap-4`/`gap-6` on grids.

## Files
- `src/pages/AcademyPublicProfile.tsx` — Hero cleanup, side-by-side layout with stats
- `src/components/academy/AcademyOpenCycles.tsx` — Add location to cycle cards

