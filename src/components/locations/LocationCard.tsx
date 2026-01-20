import { MapPin, ExternalLink, Users, CheckCircle, LayoutGrid } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Location } from '@/lib/locations';

interface LocationCardProps {
  location: Location;
  trainerCount?: number;
  isClaimed?: boolean;
  onClick?: () => void;
}

export function LocationCard({ location, trainerCount = 0, isClaimed = false, onClick }: LocationCardProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('common');

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate(`/locations/${location.slug}`);
    }
  };

  return (
    <Card 
      className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
      onClick={handleClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CardTitle className="text-lg line-clamp-1">{location.name}</CardTitle>
            {isClaimed && (
              <CheckCircle className="h-4 w-4 text-primary shrink-0" aria-label={t('locations.verified')} />
            )}
          </div>
          {location.website_url && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                window.open(location.website_url!, '_blank');
              }}
              aria-label={t('locations.visitWebsite')}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
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
        
        <div className="flex items-center gap-3">
          {location.number_of_courts != null && location.number_of_courts > 0 && (
            <Badge variant="outline" className="flex items-center gap-1">
              <LayoutGrid className="h-3 w-3" />
              {location.number_of_courts} {location.number_of_courts === 1 ? t('locations.court') : t('locations.courts')}
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
