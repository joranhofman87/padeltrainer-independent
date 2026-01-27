import { useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import { MapPin, Users, ExternalLink, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import type { Location } from '@/lib/locations';
import { createRoot } from 'react-dom/client';

// Import leaflet CSS
import 'leaflet/dist/leaflet.css';

// Fix for default marker icons in Leaflet with webpack/vite
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Custom marker icon with primary color
const createCustomIcon = (isClaimed: boolean) => {
  const color = isClaimed ? '#f97316' : '#6b7280';
  return L.divIcon({
    className: 'custom-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 32px;
        height: 32px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        border: 3px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <div style="
          transform: rotate(45deg);
          color: white;
          font-size: 14px;
        ">●</div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  });
};

interface LeafletMapProps {
  locations: Location[];
  trainerCounts: Record<string, number>;
  claimedIds: Set<string>;
  clubLogos: Record<string, string>;
}

// Popup content component
function PopupContent({ 
  location, 
  isClaimed, 
  trainerCount, 
  logoUrl,
  t,
  getLocalizedPath 
}: { 
  location: Location;
  isClaimed: boolean;
  trainerCount: number;
  logoUrl?: string;
  t: (key: string) => string;
  getLocalizedPath: (path: string) => string;
}) {
  return (
    <div className="p-1">
      <div className="flex items-start gap-3 mb-2">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={location.name}
            className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-orange-100 flex items-center justify-center flex-shrink-0">
            <MapPin className="h-6 w-6 text-orange-500" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-sm line-clamp-1">{location.name}</h3>
            {isClaimed && (
              <CheckCircle className="h-4 w-4 text-orange-500 flex-shrink-0" />
            )}
          </div>
          <p className="text-xs text-gray-500 line-clamp-1">
            {location.city}, {location.country}
          </p>
        </div>
      </div>
      
      <div className="flex items-center gap-2 mb-3">
        {trainerCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            <Users className="h-3 w-3 mr-1" />
            {trainerCount} {trainerCount === 1 ? t('locations.trainer') : t('locations.trainers')}
          </Badge>
        )}
        {location.indoor_courts != null && location.indoor_courts > 0 && (
          <Badge variant="outline" className="text-xs">
            {location.indoor_courts} {t('locations.indoorCourts')}
          </Badge>
        )}
      </div>
      
      <Button
        size="sm"
        className="w-full"
        onClick={() => {
          window.location.href = getLocalizedPath(`/locations/${location.slug}`);
        }}
      >
        {t('locations.viewProfile')}
        <ExternalLink className="h-3 w-3 ml-1" />
      </Button>
    </div>
  );
}

export function LeafletMap({ locations, trainerCounts, claimedIds, clubLogos }: LeafletMapProps) {
  const { t } = useTranslation('common');
  const getLocalizedPath = useLocalizedPathFn();
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.Marker[]>([]);
  
  // Filter locations with valid coordinates
  const mappableLocations = useMemo(() => 
    locations.filter(l => l.latitude !== null && l.longitude !== null),
    [locations]
  );
  
  const unmappableCount = locations.length - mappableLocations.length;
  
  // Default center on Netherlands
  const defaultCenter: L.LatLngTuple = [52.1326, 5.2913];
  const defaultZoom = 7;

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapRef.current = L.map(containerRef.current).setView(defaultCenter, defaultZoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(mapRef.current);

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Update markers when locations change
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear existing markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // Add new markers
    mappableLocations.forEach(location => {
      const isClaimed = claimedIds.has(location.id);
      const trainerCount = trainerCounts[location.id] || 0;
      const logoUrl = clubLogos[location.id];

      const marker = L.marker(
        [location.latitude!, location.longitude!],
        { icon: createCustomIcon(isClaimed) }
      ).addTo(mapRef.current!);

      // Create popup content container
      const popupContainer = document.createElement('div');
      popupContainer.style.minWidth = '250px';
      popupContainer.style.maxWidth = '300px';
      
      const popup = L.popup({
        minWidth: 250,
        maxWidth: 300,
        className: 'location-popup'
      }).setContent(popupContainer);

      marker.bindPopup(popup);

      // Render React component into popup when opened
      marker.on('popupopen', () => {
        const root = createRoot(popupContainer);
        root.render(
          <PopupContent
            location={location}
            isClaimed={isClaimed}
            trainerCount={trainerCount}
            logoUrl={logoUrl}
            t={t}
            getLocalizedPath={getLocalizedPath}
          />
        );
      });

      markersRef.current.push(marker);
    });

    // Fit bounds
    if (mappableLocations.length === 1) {
      mapRef.current.setView(
        [mappableLocations[0].latitude!, mappableLocations[0].longitude!],
        13
      );
    } else if (mappableLocations.length > 1) {
      const bounds = L.latLngBounds(
        mappableLocations.map(l => [l.latitude!, l.longitude!] as L.LatLngTuple)
      );
      mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
    }
  }, [mappableLocations, trainerCounts, claimedIds, clubLogos, t, getLocalizedPath]);

  return (
    <div className="relative">
      <div className="h-[500px] md:h-[600px] rounded-lg overflow-hidden border bg-muted">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      
      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none">
        <div className="pointer-events-auto">
          <Badge variant="secondary" className="bg-background/95 backdrop-blur shadow-sm">
            {mappableLocations.length} {t('locations.locationsOnMap')}
          </Badge>
        </div>
        {unmappableCount > 0 && (
          <div className="pointer-events-auto">
            <Badge variant="outline" className="bg-background/95 backdrop-blur shadow-sm text-muted-foreground">
              {unmappableCount} {t('locations.locationsNotMapped')}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

export default LeafletMap;
