import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Search, Loader2, Check, ChevronsUpDown, Home, X, Map, List, Star } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { LocationCard } from '@/components/locations/LocationCard';
import { LocationsMap } from '@/components/locations/LocationsMap';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { getActiveLocations, getLocationTrainerCounts, getUniqueCities, getUniqueCountries, getClaimedLocationIds, type Location } from '@/lib/locations';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { FeaturedSection, FeaturedBadge, shuffleArray } from '@/components/featured/FeaturedSection';

const MAX_FEATURED = 8;

export default function Locations() {
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());
  const [clubLogos, setClubLogos] = useState<Record<string, string>>({});
  const [featuredLocationIds, setFeaturedLocationIds] = useState<Set<string>>(new Set());
  const [cities, setCities] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [trainersAvailable, setTrainersAvailable] = useState(false);
  const [indoorCourtsOnly, setIndoorCourtsOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'map'>('grid');
  const [countryOpen, setCountryOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);

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
        
        // Fetch club profiles including subscription status
        const { data: clubProfiles } = await supabase
          .from('club_profiles_public')
          .select('location_id, logo_url, subscription_status');
        
        if (clubProfiles) {
          const logosMap: Record<string, string> = {};
          const featuredIds = new Set<string>();
          clubProfiles.forEach(cp => {
            if (cp.location_id && cp.logo_url) {
              logosMap[cp.location_id] = cp.logo_url;
            }
            if (cp.location_id && cp.subscription_status === 'active') {
              featuredIds.add(cp.location_id);
            }
          });
          // Also add logos from locations table for unclaimed locations
          locationsData.forEach(loc => {
            if (loc.logo_url && !logosMap[loc.id]) {
              logosMap[loc.id] = loc.logo_url;
            }
          });
          setClubLogos(logosMap);
          setFeaturedLocationIds(featuredIds);
        }
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
      const matchesIndoor = !indoorCourtsOnly || (location.indoor_courts != null && location.indoor_courts > 0);

      return matchesSearch && matchesCity && matchesCountry && matchesTrainers && matchesIndoor;
    });
  }, [locations, searchQuery, selectedCity, selectedCountry, trainersAvailable, indoorCourtsOnly, trainerCounts]);

  // Featured locations (clubs with active subscription)
  const featuredLocations = useMemo(() => {
    const featured = locations.filter(loc => featuredLocationIds.has(loc.id));
    return shuffleArray(featured).slice(0, MAX_FEATURED);
  }, [locations, featuredLocationIds]);

  const totalTrainers = Object.values(trainerCounts).reduce((a, b) => a + b, 0);

  const hasActiveFilters = 
    searchQuery !== '' || 
    selectedCity !== 'all' || 
    selectedCountry !== 'all' || 
    trainersAvailable || 
    indoorCourtsOnly;

  const clearAllFilters = () => {
    setSearchQuery('');
    setSelectedCity('all');
    setSelectedCountry('all');
    setTrainersAvailable(false);
    setIndoorCourtsOnly(false);
  };

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
              {/* Search box with map toggle */}
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('locations.searchPlaceholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Button
                  variant={viewMode === 'map' ? 'default' : 'outline'}
                  onClick={() => setViewMode(viewMode === 'grid' ? 'map' : 'grid')}
                  className="gap-2 whitespace-nowrap"
                >
                  {viewMode === 'grid' ? (
                    <>
                      <Map className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('locations.viewOnMap')}</span>
                    </>
                  ) : (
                    <>
                      <List className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('locations.viewAsList')}</span>
                    </>
                  )}
                </Button>
              </div>

              {/* Filter row */}
              <div className="flex flex-col sm:flex-row gap-4">
                {/* Country selector with search */}
                <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={countryOpen}
                      className="w-full sm:w-[180px] justify-between"
                    >
                      {selectedCountry === 'all'
                        ? t('locations.allCountries')
                        : selectedCountry}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full sm:w-[180px] p-0">
                    <Command>
                      <CommandInput placeholder={t('locations.searchCountry')} />
                      <CommandList>
                        <CommandEmpty>{t('locations.noCountryFound')}</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="all"
                            onSelect={() => {
                              setSelectedCountry('all');
                              setSelectedCity('all');
                              setCountryOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedCountry === 'all' ? "opacity-100" : "opacity-0"
                              )}
                            />
                            {t('locations.allCountries')}
                          </CommandItem>
                          {countries.map(country => (
                            <CommandItem
                              key={country}
                              value={country}
                              onSelect={() => {
                                setSelectedCountry(country);
                                setSelectedCity('all');
                                setCountryOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedCountry === country ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {country}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

                {/* City selector with search */}
                <Popover open={cityOpen} onOpenChange={setCityOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={cityOpen}
                      className="w-full sm:w-[200px] justify-between"
                    >
                      {selectedCity === 'all'
                        ? t('locations.allCities')
                        : selectedCity}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-full sm:w-[200px] p-0">
                    <Command>
                      <CommandInput placeholder={t('locations.searchCity')} />
                      <CommandList>
                        <CommandEmpty>{t('locations.noCityFound')}</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="all"
                            onSelect={() => {
                              setSelectedCity('all');
                              setCityOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedCity === 'all' ? "opacity-100" : "opacity-0"
                              )}
                            />
                            {t('locations.allCities')}
                          </CommandItem>
                          {filteredCities.map(city => (
                            <CommandItem
                              key={city}
                              value={city}
                              onSelect={() => {
                                setSelectedCity(city);
                                setCityOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedCity === city ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {city}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

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

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="indoor-courts"
                    checked={indoorCourtsOnly}
                    onCheckedChange={(checked) => setIndoorCourtsOnly(checked === true)}
                  />
                  <Label 
                    htmlFor="indoor-courts" 
                    className="text-sm font-medium cursor-pointer flex items-center gap-1"
                  >
                    <Home className="h-3.5 w-3.5" />
                    {t('locations.indoorCourtsFilter')}
                  </Label>
                </div>
              </div>

              {/* Active filter badges */}
              {hasActiveFilters && (
                <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t">
                  <span className="text-sm text-muted-foreground">{t('filters')}:</span>
                  
                  {searchQuery && (
                    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                      <Search className="h-3 w-3" />
                      <span className="max-w-[150px] truncate">"{searchQuery}"</span>
                      <button
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                        onClick={() => setSearchQuery('')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  
                  {selectedCountry !== 'all' && (
                    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                      <span>{selectedCountry}</span>
                      <button
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                        onClick={() => {
                          setSelectedCountry('all');
                          setSelectedCity('all');
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  
                  {selectedCity !== 'all' && (
                    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                      <MapPin className="h-3 w-3" />
                      <span>{selectedCity}</span>
                      <button
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                        onClick={() => setSelectedCity('all')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  
                  {trainersAvailable && (
                    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                      <span>{t('locations.trainersAvailableFilter')}</span>
                      <button
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                        onClick={() => setTrainersAvailable(false)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  
                  {indoorCourtsOnly && (
                    <Badge variant="secondary" className="flex items-center gap-1 pr-1">
                      <Home className="h-3 w-3" />
                      <span>{t('locations.indoorCourtsFilter')}</span>
                      <button
                        className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"
                        onClick={() => setIndoorCourtsOnly(false)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground h-auto py-1 px-2"
                    onClick={clearAllFilters}
                  >
                    {t('clearAll')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="container mx-auto px-4 py-8">
          {/* Featured Locations Section */}
          {!loading && featuredLocations.length > 0 && !hasActiveFilters && viewMode === 'grid' && (
            <FeaturedSection
              title={t('featured.locations')}
              description={t('featured.locationsDescription')}
              className="mb-8"
            >
              {featuredLocations.map(location => (
                <div key={location.id} className="w-[280px] lg:w-auto flex-shrink-0">
                  <LocationCard
                    location={location}
                    trainerCount={trainerCounts[location.id] || 0}
                    isClaimed={claimedIds.has(location.id)}
                    logoUrl={clubLogos[location.id]}
                  />
                </div>
              ))}
            </FeaturedSection>
          )}

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
                setIndoorCourtsOnly(false);
              }}>
                {t('clearFilters')}
              </Button>
            </div>
          ) : viewMode === 'map' ? (
            <LocationsMap
              locations={filteredLocations}
              trainerCounts={trainerCounts}
              claimedIds={claimedIds}
              clubLogos={clubLogos}
            />
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
                    logoUrl={clubLogos[location.id]}
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
