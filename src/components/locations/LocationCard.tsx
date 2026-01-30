import { MapPin, Users, CheckCircle, Home, Sun, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import type { Location } from '@/lib/locations';

interface LocationCardProps {
  location: Location;
  trainerCount?: number;
  isClaimed?: boolean;
  logoUrl?: string | null;
  onClick?: () => void;
}

export function LocationCard({ location, trainerCount = 0, isClaimed = false, logoUrl, onClick }: LocationCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const localizePath = useLocalizedPathFn();

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate(localizePath(`/locations/${location.slug}`));
    }
  };

  // Get initials for avatar fallback
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Card 
      className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50 relative"
      onClick={handleClick}
    >
      {isClaimed && (
        <div className="absolute top-3 right-3">
          <CheckCircle className="h-4 w-4 text-primary" aria-label={t('locations.verified')} />
        </div>
      )}
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {isClaimed && (
            <Avatar className="h-10 w-10 shrink-0">
              <AvatarImage src={logoUrl || undefined} alt={location.name} />
              <AvatarFallback className="bg-primary/10 text-primary text-xs">
                {logoUrl ? <Building2 className="h-5 w-5" /> : getInitials(location.name)}
              </AvatarFallback>
            </Avatar>
          )}
          <CardTitle className="text-lg break-words pr-6">{location.name}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            {location.street_address && <div>{location.street_address}</div>}
            <div>{location.postal_code} {location.city}</div>
          </div>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap">
          {(location.indoor_courts != null && location.indoor_courts > 0) && (
            <Badge variant="outline" className="flex items-center gap-1">
              <Home className="h-3 w-3" />
              {location.indoor_courts} {t('locations.indoorCourts')}
            </Badge>
          )}
          {(location.outdoor_courts != null && location.outdoor_courts > 0) && (
            <Badge variant="outline" className="flex items-center gap-1">
              <Sun className="h-3 w-3" />
              {location.outdoor_courts} {t('locations.outdoorCourts')}
            </Badge>
          )}
          {trainerCount > 0 && (
            <Badge variant="secondary" className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {trainerCount} {trainerCount === 1 ? t('locations.trainer') : t('locations.trainers')}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
