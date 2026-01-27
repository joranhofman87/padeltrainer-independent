import { Suspense, lazy } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import type { Location } from '@/lib/locations';

// Lazy load the Leaflet map component
const LeafletMap = lazy(() => import('./LeafletMap'));

interface LocationsMapProps {
  locations: Location[];
  trainerCounts: Record<string, number>;
  claimedIds: Set<string>;
  clubLogos: Record<string, string>;
}

function MapLoadingFallback() {
  return (
    <div className="h-[500px] md:h-[600px] rounded-lg overflow-hidden border bg-muted flex items-center justify-center">
      <Skeleton className="h-full w-full" />
    </div>
  );
}

export function LocationsMap(props: LocationsMapProps) {
  return (
    <Suspense fallback={<MapLoadingFallback />}>
      <LeafletMap {...props} />
    </Suspense>
  );
}

export default LocationsMap;
