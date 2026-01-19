import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Search, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocationCard } from '@/components/locations/LocationCard';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { getActiveLocations, getLocationTrainerCounts, getUniqueCities, type Location } from '@/lib/locations';
import { useTranslation } from 'react-i18next';

export default function Locations() {
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [cities, setCities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');

  useEffect(() => {
    async function fetchData() {
      try {
        const [locationsData, countsData, citiesData] = await Promise.all([
          getActiveLocations(),
          getLocationTrainerCounts(),
          getUniqueCities(),
        ]);
        setLocations(locationsData);
        setTrainerCounts(countsData);
        setCities(citiesData);
      } catch (error) {
        console.error('Error fetching locations:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const filteredLocations = useMemo(() => {
    return locations.filter(location => {
      const matchesSearch =
        location.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        location.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (location.street_address?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);

      const matchesCity = selectedCity === 'all' || location.city === selectedCity;

      return matchesSearch && matchesCity;
    });
  }, [locations, searchQuery, selectedCity]);

  const totalTrainers = Object.values(trainerCounts).reduce((a, b) => a + b, 0);

  return (
    <MarketingLayout>
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        {/* Hero Section */}
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b">
          <div className="container mx-auto px-4 py-12">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-primary/10 rounded-xl">
                <MapPin className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">{t('locations.title', 'Padel Locations')}</h1>
                <p className="text-muted-foreground">
                  {t('locations.subtitle', 'Find trainers at {{count}} venues across the Netherlands', { count: locations.length })}
                </p>
              </div>
            </div>

            {/* Search and Filter */}
            <div className="flex flex-col sm:flex-row gap-4 mt-6">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('locations.searchPlaceholder', 'Search by name or city...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={selectedCity} onValueChange={setSelectedCity}>
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue placeholder={t('locations.filterByCity', 'Filter by city')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('locations.allCities', 'All cities')}</SelectItem>
                  {cities.map(city => (
                    <SelectItem key={city} value={city}>{city}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="container mx-auto px-4 py-8">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : filteredLocations.length === 0 ? (
            <div className="text-center py-16">
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('locations.noResults', 'No locations found')}</h3>
              <p className="text-muted-foreground mb-4">
                {t('locations.tryDifferentSearch', 'Try a different search term or filter')}
              </p>
              <Button variant="outline" onClick={() => {
                setSearchQuery('');
                setSelectedCity('all');
              }}>
                {t('clearFilters', 'Clear Filters')}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-6">
                <p className="text-sm text-muted-foreground">
                  {t('locations.showingCount', 'Showing {{count}} locations', { count: filteredLocations.length })}
                  {totalTrainers > 0 && ` · ${totalTrainers} ${t('locations.trainersAvailable', 'trainers available')}`}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredLocations.map(location => (
                  <LocationCard
                    key={location.id}
                    location={location}
                    trainerCount={trainerCounts[location.id] || 0}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </MarketingLayout>
  );
}
