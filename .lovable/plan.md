

# Show Only Club Name in Registration Header

## Change
In `src/pages/BrandedCycleRegistration.tsx` line 289, remove the `, {cycleLocation.city}` part so only the location name is displayed.

### `src/pages/BrandedCycleRegistration.tsx`
- Line 289: Change `{cycleLocation.name}, {cycleLocation.city}` → `{cycleLocation.name}`

