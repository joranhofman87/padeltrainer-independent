import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { MapPin } from 'lucide-react';

interface BookingTrainerCardProps {
  fullName: string;
  avatarUrl: string | null;
  location: string | null;
  specializations: string[] | null;
}

export function BookingTrainerCard({ fullName, avatarUrl, location, specializations }: BookingTrainerCardProps) {
  const initials = fullName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'T';

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <Avatar className="h-16 w-16">
            <AvatarImage src={avatarUrl || undefined} alt={fullName} />
            <AvatarFallback className="text-xl">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <h2 className="text-xl font-semibold">{fullName}</h2>
            {location && (
              <p className="text-muted-foreground flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {location}
              </p>
            )}
            {specializations && specializations.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {specializations.map((spec, i) => (
                  <span
                    key={i}
                    className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded"
                  >
                    {spec}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
