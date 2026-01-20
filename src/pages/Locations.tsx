import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Search, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LocationCard } from '@/components/locations/LocationCard';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { getActiveLocations, getLocationTrainerCounts, getUniqueCities, getUniqueCountries, getClaimedLocationIds, type Location } from '@/lib/locations';
import { useTranslation } from 'react-i18next';

export default function Locations() {
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());
  const [cities, setCities] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [trainersAvailable, setTrainersAvailable] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [locationsData, countsData, citiesData, countriesData, claimedData] = await Promise.all([
          getActiveLocations(),
          getLocationTrainerCounts(),
          getUniqueCities(),
          getUniqueCountries(),
          getClaimedLocationIds(),
        ]);
        setLocations(locationsData);
        setTrainerCounts(countsData);
        setCities(citiesData);
        setCountries(countriesData);
        setClaimedIds(claimedData);
      } catch (error) {
        console.error('Error fetching locations:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  // Filter cities based on selected country
  const filteredCities = useMemo(() => {
    if (selectedCountry === 'all') return cities;
    const countryCities = locations
      .filter(l => l.country === selectedCountry)
      .map(l => l.city);
    return [...new Set(countryCities)].sort();
  }, [cities, locations, selectedCountry]);

  const filteredLocations = useMemo(() => {
    return locations.filter(location => {
      const matchesSearch =
        location.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        location.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (location.street_address?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);

      const matchesCity = selectedCity === 'all' || location.city === selectedCity;
      const matchesCountry = selectedCountry === 'all' || location.country === selectedCountry;
      const matchesTrainers = !trainersAvailable || (trainerCounts[location.id] || 0) > 0;

      return matchesSearch && matchesCity && matchesCountry && matchesTrainers;
    });
  }, [locations, searchQuery, selectedCity, selectedCountry, trainersAvailable, trainerCounts]);

  const totalTrainers = Object.values(trainerCounts).reduce((a, b) => a + b, 0);

  // Structured data for location list
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('locations.seoTitle'),
    "description": t('locations.seoDescription', { count: locations.length }),
    "numberOfItems": locations.length,
    "itemListElement": filteredLocations.slice(0, 10).map((location, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "SportsClub",
        "name": location.name,
        "address": {
          "@type": "PostalAddress",
          "streetAddress": location.street_address,
          "addressLocality": location.city,
          "postalCode": location.postal_code,
          "addressCountry": "NL"
        }
      }
    }))
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('locations.seoTitle')}
        description={t('locations.seoDescription', { count: locations.length })}
        url="/locations"
        type="website"
        structuredData={structuredData}
      />
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        {/* Hero Section */}
        <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b">
          <div className="container mx-auto px-4 py-12">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-primary/10 rounded-xl">
                <MapPin className="h-8 w-8 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">{t('locations.title')}</h1>
                <p className="text-muted-foreground">
                  {t('locations.subtitle', { count: locations.length })}
                </p>
              </div>
            </div>

            {/* Search and Filters */}
            <div className="space-y-4 mt-6">
              {/* Search box */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('locations.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              {/* Filter row */}
              <div className="flex flex-col sm:flex-row gap-4">
                <Select value={selectedCountry} onValueChange={(value) => {
                  setSelectedCountry(value);
                  setSelectedCity('all'); // Reset city when country changes
                }}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder={t('locations.filterByCountry')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('locations.allCountries')}</SelectItem>
                    {countries.map(country => (
                      <SelectItem key={country} value={country}>{country}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={selectedCity} onValueChange={setSelectedCity}>
                  <SelectTrigger className="w-full sm:w-[200px]">
                    <SelectValue placeholder={t('locations.filterByCity')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('locations.allCities')}</SelectItem>
                    {filteredCities.map(city => (
                      <SelectItem key={city} value={city}>{city}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="trainers-available"
                    checked={trainersAvailable}
                    onCheckedChange={(checked) => setTrainersAvailable(checked === true)}
                  />
                  <Label 
                    htmlFor="trainers-available" 
                    className="text-sm font-medium cursor-pointer"
                  >
                    {t('locations.trainersAvailableFilter')}
                  </Label>
                </div>
              </div>
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
              <h3 className="text-lg font-medium mb-2">{t('locations.noResults')}</h3>
              <p className="text-muted-foreground mb-4">
                {t('locations.tryDifferentSearch')}
              </p>
              <Button variant="outline" onClick={() => {
                setSearchQuery('');
                setSelectedCity('all');
                setSelectedCountry('all');
                setTrainersAvailable(false);
              }}>
                {t('clearFilters')}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-6">
                <p className="text-sm text-muted-foreground">
                  {t('locations.showingCount', { count: filteredLocations.length })}
                  {totalTrainers > 0 && ` · ${totalTrainers} ${t('locations.trainersAvailable')}`}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredLocations.map(location => (
                  <LocationCard
                    key={location.id}
                    location={location}
                    trainerCount={trainerCounts[location.id] || 0}
                    isClaimed={claimedIds.has(location.id)}
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
