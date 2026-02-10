import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { MapPin, Plus, ExternalLink, Eye, EyeOff, Trash2, CalendarDays, FileText, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import {
  getAcademyLocationsWithDetails,
  updateAcademyLocation,
  removeAcademyLocation,
  type AcademyLocationWithDetails,
} from '@/lib/academy';
import { AddAcademyLocationDialog } from '@/components/academy/AddAcademyLocationDialog';
import { EditAcademyLocationDialog } from '@/components/academy/EditAcademyLocationDialog';
import { RequestLocationDialog } from '@/components/academy/RequestLocationDialog';
import { getUserClubProfiles } from '@/lib/club';
import { toast } from 'sonner';
import { format } from 'date-fns';

export default function AcademyLocations() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { user } = useAuth();
  const { activeAcademy } = useAcademyContext();
  const [locations, setLocations] = useState<AcademyLocationWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [clubLocationMap, setClubLocationMap] = useState<Map<string, string>>(new Map());

  const fetchLocations = async () => {
    if (!activeAcademy) return;

    try {
      const data = await getAcademyLocationsWithDetails(activeAcademy.id);
      setLocations(data);
    } catch (error) {
      console.error('Error fetching locations:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLocations();
  }, [activeAcademy]);

  // Fetch user's club profiles to determine which locations they manage as a club
  useEffect(() => {
    const fetchClubProfiles = async () => {
      if (!user?.id) return;
      try {
        const clubs = await getUserClubProfiles(user.id);
        const map = new Map<string, string>();
        for (const club of clubs) {
          map.set(club.location_id, club.id);
        }
        setClubLocationMap(map);
      } catch (error) {
        console.error('Error fetching club profiles:', error);
      }
    };
    fetchClubProfiles();
  }, [user?.id]);

  const handleVisibilityToggle = async (
    locationId: string,
    field: 'show_on_academy_page' | 'show_on_club_page',
    value: boolean
  ) => {
    const success = await updateAcademyLocation(locationId, { [field]: value });

    if (success) {
      setLocations((prev) =>
        prev.map((loc) =>
          loc.id === locationId ? { ...loc, [field]: value } : loc
        )
      );
      toast.success(t('locations.updated'));
    } else {
      toast.error(t('common:error'));
    }
  };

  const handleRemoveLocation = async (locationId: string) => {
    const success = await removeAcademyLocation(locationId);
    if (success) {
      setLocations((prev) => prev.filter((l) => l.id !== locationId));
      toast.success(t('locations.removed'));
    } else {
      toast.error(t('common:error'));
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Skeleton className="h-10 w-48 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  const activeLocations = locations.filter((l) => l.is_active);
  const inactiveLocations = locations.filter((l) => !l.is_active);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">{t('locations.title')}</h2>
          <p className="text-muted-foreground">{t('locations.description')}</p>
        </div>
        {activeAcademy && (
          <div className="flex items-center gap-2">
            <AddAcademyLocationDialog
              academyProfileId={activeAcademy.id}
              existingLocationIds={locations.map((l) => l.location_id)}
              onLocationAdded={fetchLocations}
            />
            <RequestLocationDialog
              academyProfileId={activeAcademy.id}
            />
          </div>
        )}
      </div>

      {locations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('locations.empty')}</h3>
            <p className="text-muted-foreground mb-6">{t('locations.emptyDescription')}</p>
            {activeAcademy && (
              <AddAcademyLocationDialog
                academyProfileId={activeAcademy.id}
                existingLocationIds={[]}
                onLocationAdded={fetchLocations}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Active Locations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeLocations.map((academyLocation) => (
              <LocationCard
                key={academyLocation.id}
                academyLocation={academyLocation}
                managedClubId={clubLocationMap.get(academyLocation.location_id) || null}
                onVisibilityToggle={handleVisibilityToggle}
                onRemove={handleRemoveLocation}
                onUpdate={fetchLocations}
                localizePath={localizePath}
                navigate={navigate}
              />
            ))}
          </div>

          {/* Inactive Locations */}
          {inactiveLocations.length > 0 && (
            <>
              <h3 className="text-lg font-medium text-muted-foreground mt-8">
                {t('locations.inactiveContracts')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-60">
                {inactiveLocations.map((academyLocation) => (
                  <LocationCard
                    key={academyLocation.id}
                    academyLocation={academyLocation}
                    managedClubId={clubLocationMap.get(academyLocation.location_id) || null}
                    onVisibilityToggle={handleVisibilityToggle}
                    onRemove={handleRemoveLocation}
                    onUpdate={fetchLocations}
                    localizePath={localizePath}
                    navigate={navigate}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface LocationCardProps {
  academyLocation: AcademyLocationWithDetails;
  managedClubId: string | null;
  onVisibilityToggle: (id: string, field: 'show_on_academy_page' | 'show_on_club_page', value: boolean) => void;
  onRemove: (id: string) => void;
  onUpdate: () => void;
  localizePath: (path: string) => string;
  navigate: (path: string) => void;
}

function LocationCard({
  academyLocation,
  managedClubId,
  onVisibilityToggle,
  onRemove,
  onUpdate,
  localizePath,
  navigate,
}: LocationCardProps) {
  const { t } = useTranslation('academy');
  const location = academyLocation.location;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-4">
          {location.logo_url ? (
            <img
              src={location.logo_url}
              alt={location.name}
              className="h-14 w-14 rounded-lg object-cover"
            />
          ) : (
            <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center">
              <Building2 className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg truncate">{location.name}</CardTitle>
            <CardDescription className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {location.city}
              {location.street_address && ` · ${location.street_address}`}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Contract Info */}
        <div className="flex flex-wrap gap-2">
          <Badge variant={academyLocation.contract_type === 'exclusive' ? 'default' : 'secondary'}>
            <FileText className="h-3 w-3 mr-1" />
            {academyLocation.contract_type === 'exclusive'
              ? t('locations.exclusive')
              : t('locations.nonExclusive')}
          </Badge>
          {academyLocation.contract_start && (
            <Badge variant="outline">
              <CalendarDays className="h-3 w-3 mr-1" />
              {format(new Date(academyLocation.contract_start), 'MMM yyyy')}
              {academyLocation.contract_end && (
                <> - {format(new Date(academyLocation.contract_end), 'MMM yyyy')}</>
              )}
            </Badge>
          )}
          {!academyLocation.is_active && (
            <Badge variant="destructive">{t('locations.inactive')}</Badge>
          )}
        </div>

        {/* Visibility Toggles */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <Label htmlFor={`academy-vis-${academyLocation.id}`} className="text-sm flex items-center gap-2">
              {academyLocation.show_on_academy_page ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
              {t('locations.showOnAcademyPage')}
            </Label>
            <Switch
              id={`academy-vis-${academyLocation.id}`}
              checked={academyLocation.show_on_academy_page}
              onCheckedChange={(checked) =>
                onVisibilityToggle(academyLocation.id, 'show_on_academy_page', checked)
              }
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor={`club-vis-${academyLocation.id}`} className="text-sm flex items-center gap-2">
              {academyLocation.show_on_club_page ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
              {t('locations.showOnClubPage')}
            </Label>
            <Switch
              id={`club-vis-${academyLocation.id}`}
              checked={academyLocation.show_on_club_page}
              onCheckedChange={(checked) =>
                onVisibilityToggle(academyLocation.id, 'show_on_club_page', checked)
              }
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-2">
          <EditAcademyLocationDialog
            academyLocation={academyLocation}
            onLocationUpdated={onUpdate}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(localizePath(`/locations/${location.slug}`))}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            {t('locations.viewClub')}
          </Button>
          {managedClubId && (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                localStorage.setItem('activeClubId', managedClubId);
                navigate('/app/club');
              }}
            >
              <Building2 className="h-4 w-4 mr-2" />
              {t('locations.manageClub')}
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('locations.removeTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('locations.removeDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRemove(academyLocation.id)}>
                  {t('locations.remove')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
