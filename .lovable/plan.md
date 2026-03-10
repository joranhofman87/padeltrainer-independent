

# Branded Registration Page Under Academy/Club Profile

## Concept

Create a new route `/:lang/academies/:slug/register/:cycleId` (and `/:lang/clubs/:slug/register/:cycleId`) that shows the registration form with the academy's or club's branding (banner, logo, name) at the top — using the same `ProfileLayout` component that the public profile pages use.

The existing standalone `/:lang/register/:cycleId` route stays as a fallback.

## Route Structure

```text
/:lang/academies/:slug/register/:cycleId  → Branded registration (academy)
/:lang/clubs/:slug/register/:cycleId      → Branded registration (club)  
/:lang/register/:cycleId                  → Generic registration (existing, unchanged)
```

## Changes

### 1. New page: `src/pages/BrandedCycleRegistration.tsx`

A wrapper page that:
- Reads `:slug` and `:cycleId` from URL params
- Fetches the academy/club profile (name, logo, banner, slug) for branding
- Renders inside `ProfileLayout` with banner + breadcrumbs (Home → Academies → Academy Name → Registration)
- Shows a compact hero section with owner logo + name (not the full profile hero)
- Renders cycle details (name, dates, deadline, location, description, price table) expanded by default
- Renders `CycleApplicationForm` directly below (no collapsible), supporting both authenticated and guest flows
- Shows success state inline

This reuses the existing `CycleApplicationForm`, `CycleDetailDisplay`, and `ProfileLayout` components — no duplication of form logic.

### 2. Update routes in `DomainRouter.tsx`

Add two new routes before the existing `register/:cycleId`:
```
academies/:slug/register/:cycleId → BrandedCycleRegistration (ownerType="academy")
clubs/:slug/register/:cycleId     → BrandedCycleRegistration (ownerType="club")
```

### 3. Update share link generation

Update the cycle share link in `CycleCard` / wherever share links are generated to produce `/:lang/academies/:slug/register/:cycleId` instead of `/:lang/register/:cycleId` when the cycle belongs to an academy (and similarly for clubs). This requires passing the owner slug through.

### 4. Update `AcademyOpenCycles` "Apply" button

The "Apply" button on the academy profile page currently expands inline. Add a link/option to navigate to the dedicated branded registration page (`/:lang/academies/:slug/register/:cycleId`) for a full-page experience, while keeping the inline expand as-is.

## Files to create/edit

| File | Action |
|---|---|
| `src/pages/BrandedCycleRegistration.tsx` | **Create** — new branded registration page |
| `src/components/DomainRouter.tsx` | **Edit** — add 2 nested routes |
| `src/components/academy/AcademyOpenCycles.tsx` | **Edit** — "Apply" button links to branded page |
| `src/pages/CycleRegistration.tsx` | **Keep** — unchanged, serves as fallback |

