

## Add Club Branding to Registration Links

### Problem
When a club manager copies a registration link from the Registrations page, it generates a generic `/register/:cycleId` URL that leads to an unbranded page. Academies already get branded URLs like `/academies/:slug/register/:cycleId`.

### What changes

**1. `CyclesTable` — generate branded links for clubs and academies**

Update `handleCopyLink` to build the correct branded URL based on `ownerType`:
- For `club`: `/clubs/:clubId/register/:cycleId`
- For `academy`: `/academies/:slug/register/:cycleId`
- For `trainer`: keep generic `/register/:cycleId`

This requires passing the owner's slug/ID into `CyclesTable`. Add an optional `ownerSlug` prop.

**2. `ClubCycles` — pass the club ID as `ownerSlug`**

Pass `activeClub.id` to `CyclesTable` so it can build the branded URL.

**3. `BrandedCycleRegistration` — fix club name display**

Currently the club branch fetches the location name as the "owner name", which works but could be improved. The branding (logo, banner, welcome message) is already being fetched correctly — no changes needed there as long as the club ID matches the `:slug` param.

### Files to change
- `src/components/cycles/CyclesTable.tsx` — add `ownerSlug` prop, update `handleCopyLink`
- `src/pages/club/ClubCycles.tsx` — pass `ownerSlug={activeClub.id}`
- Verify academy cycles page also passes its slug (likely already works)

### Scope check
The `BrandedCycleRegistration` component already renders with banner, logo, and full branding for clubs — the only gap is the link generation in `CyclesTable`.

