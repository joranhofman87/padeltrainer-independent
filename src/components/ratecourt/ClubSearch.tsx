import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchLocations } from '@/lib/locations';
import { Input } from '@/components/ui/input';
import { MapPin, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ClubSearchProps {
  onSelect: (location: { id: string; name: string; city: string; country: string; slug: string }) => void;
}

export function ClubSearch({ onSelect }: ClubSearchProps) {
  const { t } = useTranslation('marketing');
  const [search, setSearch] = useState('');

  const { data: locations = [], isLoading } = useQuery({
    queryKey: ['location-search', search],
    queryFn: () => searchLocations(search, 20),
    enabled: true,
  });

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('rateMyCourtPage.searchPlaceholder', 'Search by club name or city...')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="grid gap-2 max-h-[400px] overflow-y-auto">
        {isLoading && (
          <p className="text-muted-foreground text-sm text-center py-4">
            {t('rateMyCourtPage.searching', 'Searching...')}
          </p>
        )}
        {locations.map((loc) => (
          <button
            key={loc.id}
            onClick={() => onSelect({ id: loc.id, name: loc.name, city: loc.city, country: loc.country, slug: loc.slug })}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent transition-colors text-left w-full"
          >
            <MapPin className="h-4 w-4 text-primary shrink-0" />
            <div>
              <p className="font-medium text-foreground">{loc.name}</p>
              <p className="text-sm text-muted-foreground">{loc.city}, {loc.country}</p>
            </div>
          </button>
        ))}
        {!isLoading && locations.length === 0 && search.length >= 2 && (
          <p className="text-muted-foreground text-sm text-center py-4">
            {t('rateMyCourtPage.noResults', 'No clubs found. Try a different search.')}
          </p>
        )}
      </div>
    </div>
  );
}
