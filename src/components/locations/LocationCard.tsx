import { MapPin, ExternalLink, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import type { Location } from '@/lib/locations';

interface LocationCardProps {
  location: Location;
  trainerCount?: number;
  onClick?: () => void;
}

export function LocationCard({ location, trainerCount = 0, onClick }: LocationCardProps) {
  const navigate = useNavigate();

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
        <div className="flex items-start justify-between">
          <CardTitle className="text-lg line-clamp-1">{location.name}</CardTitle>
          {trainerCount > 0 && (
            <Badge variant="secondary" className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {trainerCount}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            {location.street_address && <div>{location.street_address}</div>}
            <div>{location.postal_code} {location.city}</div>
          </div>
        </div>
        {location.website_url && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              window.open(location.website_url!, '_blank');
            }}
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Website
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
