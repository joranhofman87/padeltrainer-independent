import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { MapPin, Users, ExternalLink, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import type { Location } from '@/lib/locations';

// Force dependency rebuild after React 19 upgrade

// Fix for default marker icons in Leaflet with webpack/vite
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Custom marker icon with primary color
const createCustomIcon = (isClaimed: boolean) => {
  const color = isClaimed ? '#f97316' : '#6b7280'; // primary orange or gray
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

interface LocationsMapProps {
  locations: Location[];
  trainerCounts: Record<string, number>;
  claimedIds: Set<string>;
  clubLogos: Record<string, string>;
}

// Component to fit bounds when locations change
function FitBounds({ locations }: { locations: Location[] }) {
  const map = useMap();
  
  useEffect(() => {
    const validLocations = locations.filter(l => l.latitude && l.longitude);
    if (validLocations.length === 0) return;
    
    if (validLocations.length === 1) {
      map.setView(
        [validLocations[0].latitude!, validLocations[0].longitude!],
        13
      );
    } else {
      const bounds = L.latLngBounds(
        validLocations.map(l => [l.latitude!, l.longitude!] as L.LatLngTuple)
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
    }
  }, [locations, map]);
  
  return null;
}

export function LocationsMap({ locations, trainerCounts, claimedIds, clubLogos }: LocationsMapProps) {
  const { t } = useTranslation('common');
  const getLocalizedPath = useLocalizedPathFn();
  
  // Filter locations with valid coordinates
  const mappableLocations = useMemo(() => 
    locations.filter(l => l.latitude !== null && l.longitude !== null),
    [locations]
  );
  
  const unmappableCount = locations.length - mappableLocations.length;
  
  // Default center on Netherlands
  const defaultCenter: L.LatLngTuple = [52.1326, 5.2913];
  const defaultZoom = 7;

  return (
    <div className="relative">
      {/* Map container */}
      <div className="h-[500px] md:h-[600px] rounded-lg overflow-hidden border bg-muted">
        <MapContainer
          center={defaultCenter}
          zoom={defaultZoom}
          className="h-full w-full"
          scrollWheelZoom={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds locations={mappableLocations} />
          
          {mappableLocations.map(location => {
            const isClaimed = claimedIds.has(location.id);
            const trainerCount = trainerCounts[location.id] || 0;
            const logoUrl = clubLogos[location.id];
            
            return (
              <Marker
                key={location.id}
                position={[location.latitude!, location.longitude!]}
                icon={createCustomIcon(isClaimed)}
              >
                <Popup className="location-popup" minWidth={250} maxWidth={300}>
                  <div className="p-1">
                    {/* Header with logo */}
                    <div className="flex items-start gap-3 mb-2">
                      {logoUrl ? (
                        <img
                          src={logoUrl}
                          alt={location.name}
                          className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <MapPin className="h-6 w-6 text-primary" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <h3 className="font-semibold text-sm line-clamp-1">{location.name}</h3>
                          {isClaimed && (
                            <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {location.city}, {location.country}
                        </p>
                      </div>
                    </div>
                    
                    {/* Stats */}
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
                    
                    {/* Action button */}
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
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
      
      {/* Info bar */}
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
