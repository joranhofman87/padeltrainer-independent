

# Add Map Toggle to Locations Page

## Overview
Add a "Search on Map" toggle button to the Locations page (similar to Funda's "Zoek op kaart" button) that switches between the current card grid view and an interactive map view showing all padel clubs with markers.

## Current State
- **575 locations** with geocoded coordinates (latitude/longitude)
- Card grid view with filters (search, country, city, trainers, indoor courts)
- No map library currently installed
- Location interface already includes `latitude` and `longitude` fields

## Implementation Approach

### 1. Install Map Library
We'll use **Leaflet** with **react-leaflet** - a lightweight, open-source solution that's:
- Free (no API key required)
- Uses OpenStreetMap tiles
- Well-maintained with React bindings

**Dependencies to add:**
- `leaflet` - Core map library
- `react-leaflet` - React wrapper components

### 2. Create Map Component
**New file: `src/components/locations/LocationsMap.tsx`**

An interactive map component that:
- Centers on Netherlands by default (52.1326, 5.2913)
- Shows markers for all filtered locations with coordinates
- Clusters nearby markers when zoomed out (optional enhancement)
- Popup on marker click showing: club name, address, trainer count, and "View Details" link
- Auto-adjusts bounds to show all visible markers

### 3. Modify Locations Page
**File: `src/pages/Locations.tsx`**

Add:
- `viewMode` state: `'grid' | 'map'`
- Toggle button next to search bar (like Funda reference)
- Conditional rendering: show grid OR map based on viewMode
- Map respects all active filters

### 4. Add Translations
**Files: `src/i18n/locales/en/common.json` and `nl/common.json`**

New translation keys under `locations`:
- `viewOnMap` / `zoekOpKaart`: "Search on Map" / "Zoek op kaart"
- `viewAsList` / `bekijkAlsLijst`: "View as List" / "Bekijk als lijst"
- `mapView` / `kaartweergave`: "Map View" / "Kaartweergave"

### 5. Leaflet CSS
Leaflet requires its CSS to be imported. We'll add:
```css
@import 'leaflet/dist/leaflet.css';
```
To `src/index.css`

## UI Design (Based on Funda Reference)

```
┌─────────────────────────────────────────────────────────────────┐
│  🗺 Padel Locations                                             │
│  Find trainers at 575 venues                                    │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐ ┌───────────────────────┐   │
│ │ 🔍 Search by name or city...    │ │ 🗺 Search on Map     │   │
│ └─────────────────────────────────┘ └───────────────────────┘   │
│                                                                  │
│ [Country ▼] [City ▼] ☑ Trainers available  ☑ Indoor courts     │
└─────────────────────────────────────────────────────────────────┘
```

The toggle button will:
- Show map icon + "Search on Map" when in grid view
- Show list icon + "View as List" when in map view
- Be styled as an outline button with primary accent (like Funda's orange button)

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Add leaflet, react-leaflet dependencies |
| `src/index.css` | Modify | Import Leaflet CSS |
| `src/components/locations/LocationsMap.tsx` | Create | Interactive map component |
| `src/pages/Locations.tsx` | Modify | Add viewMode state and toggle |
| `src/i18n/locales/en/common.json` | Modify | Add map translation keys |
| `src/i18n/locales/nl/common.json` | Modify | Add map translation keys |

## Technical Details

### LocationsMap Component Props
```typescript
interface LocationsMapProps {
  locations: Location[];
  trainerCounts: Record<string, number>;
  claimedIds: Set<string>;
  clubLogos: Record<string, string>;
}
```

### Map Configuration
- **Default center**: Netherlands (52.1326, 5.2913)
- **Default zoom**: 7 (shows full country)
- **Tile provider**: OpenStreetMap (free, no API key)
- **Marker style**: Custom padel/tennis icon or default blue marker
- **Popup content**: Club name, city, trainer count, "View Details" button

### Marker Popup Example
```
┌──────────────────────────┐
│ ✓ Club Name              │
│ 📍 City, Netherlands     │
│ 👥 3 trainers            │
│ [View Details →]         │
└──────────────────────────┘
```

### Handling Missing Coordinates
Some locations may lack coordinates. The map will:
- Only display markers for locations with valid lat/lng
- Show count of "locations not shown" if any are missing coordinates

## Responsive Design
- **Desktop**: Map takes full content width with good height (500-600px)
- **Mobile**: Map stacks below filters, maintains usable touch interaction
- **Map controls**: Zoom buttons visible on all screen sizes

