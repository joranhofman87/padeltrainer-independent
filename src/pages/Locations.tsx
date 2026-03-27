import { useState, useEffect, useMemo, useCallback } from 'react';
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
import { logger } from '@/lib/logger';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from '@/components/ui/pagination';
import { LocationCard } from '@/components/locations/LocationCard';
import { LocationsMap } from '@/components/locations/LocationsMap';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { searchLocationsPage, searchLocationsAll, getLocationTrainerCounts, getUniqueCities, getUniqueCountries, getClaimedLocationIds, type LocationListItem, type Location } from '@/lib/locations';
import { supabase } from '@/lib/supabaseClient';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { FeaturedSection, FeaturedBadge, shuffleArray } from '@/components/featured/FeaturedSection';

const MAX_FEATURED = 8;
const PAGE_SIZE = 48;

export default function Locations() {
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const [locations, setLocations] = useState<LocationListItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());
  const [clubLogos, setClubLogos] = useState<Record<string, string>>({});
  const [featuredLocations, setFeaturedLocations] = useState<LocationListItem[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [trainersAvailable, setTrainersAvailable] = useState(false);
  const [indoorCourtsOnly, setIndoorCourtsOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'map'>('grid');
  const [countryOpen, setCountryOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [allMapLocations, setAllMapLocations] = useState<LocationListItem[]>([]);
  const [mapLoading, setMapLoading] = useState(false);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCity, selectedCountry, trainersAvailable, indoorCourtsOnly]);

  // Fetch metadata once (cities, countries, trainer counts, claimed, featured)
  useEffect(() => {
    async function fetchMetadata() {
      try {
        const [countsData, citiesData, countriesData, claimedData] = await Promise.all([
          getLocationTrainerCounts(),
          getUniqueCities(),
          getUniqueCountries(),
          getClaimedLocationIds(),
        ]);
        setTrainerCounts(countsData);
        setCities(citiesData);
        setCountries(countriesData);
        setClaimedIds(claimedData);

        // Fetch club profiles for logos + featured
        const { data: clubProfiles } = await supabase
          .from('club_profiles_public')
          .select('location_id, logo_url, subscription_status');

        if (clubProfiles) {
          const logosMap: Record<string, string> = {};
          const featuredIds: string[] = [];
          clubProfiles.forEach(cp => {
            if (cp.location_id && cp.logo_url) {
              logosMap[cp.location_id] = cp.logo_url;
            }
            if (cp.location_id && cp.subscription_status === 'active') {
              featuredIds.push(cp.location_id);
            }
          });
          setClubLogos(logosMap);

          // Fetch featured locations data
          if (featuredIds.length > 0) {
            const { data: featuredData } = await supabase
              .from('locations')
              .select('id, name, slug, city, country, street_address, postal_code, indoor_courts, outdoor_courts, logo_url, latitude, longitude')
              .in('id', featuredIds)
              .eq('is_active', true);
            if (featuredData) {
              setFeaturedLocations(shuffleArray(featuredData as LocationListItem[]).slice(0, MAX_FEATURED));
            }
          }
        }
      } catch (error) {
        logger.error('Error fetching location metadata', error instanceof Error ? error : new Error(String(error)), { component: 'Locations' });
      }
    }
    fetchMetadata();
  }, []);

  // Fetch paginated locations when filters/page change
  useEffect(() => {
    async function fetchLocations() {
      setLoading(true);
      try {
        const result = await searchLocationsPage({
          search: debouncedSearch,
          country: selectedCountry,
          city: selectedCity,
          trainersAvailable,
          indoorOnly: indoorCourtsOnly,
          page: currentPage,
          pageSize: PAGE_SIZE,
        });
        setLocations(result.data);
        setTotalCount(result.totalCount);

        // Add location logos from location data itself
        setClubLogos(prev => {
          const updated = { ...prev };
          result.data.forEach(loc => {
            if (loc.logo_url && !updated[loc.id]) {
              updated[loc.id] = loc.logo_url;
            }
          });
          return updated;
        });
      } catch (error) {
        logger.error('Error fetching locations', error instanceof Error ? error : new Error(String(error)), { component: 'Locations' });
      } finally {
        setLoading(false);
      }
    }
    fetchLocations();
  }, [debouncedSearch, selectedCountry, selectedCity, trainersAvailable, indoorCourtsOnly, currentPage]);

  // Fetch all locations when map view is active
  useEffect(() => {
    if (viewMode !== 'map') return;
    async function fetchAllForMap() {
      setMapLoading(true);
      try {
        const all = await searchLocationsAll({
          search: debouncedSearch,
          country: selectedCountry,
          city: selectedCity,
          trainersAvailable,
          indoorOnly: indoorCourtsOnly,
        });
        setAllMapLocations(all);
      } catch (error) {
        logger.error('Error fetching all locations for map', error instanceof Error ? error : new Error(String(error)), { component: 'Locations' });
      } finally {
        setMapLoading(false);
      }
    }
    fetchAllForMap();
  }, [viewMode, debouncedSearch, selectedCountry, selectedCity, trainersAvailable, indoorCourtsOnly]);

  const filteredCities = useMemo(() => {
    // When a country is selected, we can't filter cities from the paginated data
    // We rely on the full cities list; ideally filtered by country but we don't have that mapping in metadata
    // For now return all cities (the search in the dropdown helps)
    return cities;
  }, [cities]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const totalTrainers = Object.values(trainerCounts).reduce((a, b) => a + b, 0);

  const hasActiveFilters = 
    searchQuery !== '' || 
    selectedCity !== 'all' || 
    selectedCountry !== 'all' || 
    trainersAvailable || 
    indoorCourtsOnly;

  const clearAllFilters = () => {
    setSearchQuery('');
    setDebouncedSearch('');
    setSelectedCity('all');
    setSelectedCountry('all');
    setTrainersAvailable(false);
    setIndoorCourtsOnly(false);
    setCurrentPage(1);
  };

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('ellipsis');
      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
        pages.push(i);
      }
      if (currentPage < totalPages - 2) pages.push('ellipsis');
      pages.push(totalPages);
    }
    return pages;
  };

  // Cast LocationListItem to Location-like shape for LocationCard (it only uses the fields we have)
  const asLocation = (item: LocationListItem): Location => item as unknown as Location;

  // Structured data for location list
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('locations.seoTitle'),
    "description": t('locations.seoDescription', { count: totalCount }),
    "numberOfItems": totalCount,
    "itemListElement": locations.slice(0, 10).map((location, index) => ({
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
        description={t('locations.seoDescription', { count: totalCount })}
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
                  {t('locations.subtitle', { count: totalCount })}
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
                    location={asLocation(location)}
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
          ) : locations.length === 0 ? (
            <div className="text-center py-16">
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('locations.noResults')}</h3>
              <p className="text-muted-foreground mb-4">
                {t('locations.tryDifferentSearch')}
              </p>
              <Button variant="outline" onClick={clearAllFilters}>
                {t('clearFilters')}
              </Button>
            </div>
          ) : viewMode === 'map' ? (
            <LocationsMap
              locations={locations.map(asLocation)}
              trainerCounts={trainerCounts}
              claimedIds={claimedIds}
              clubLogos={clubLogos}
            />
          ) : (
            <>
              <div className="flex items-center justify-between mb-6">
                <p className="text-sm text-muted-foreground">
                  {t('locations.showingCount', { count: totalCount })}
                  {totalTrainers > 0 && ` · ${totalTrainers} ${t('locations.trainersAvailable')}`}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {locations.map(location => (
                  <LocationCard
                    key={location.id}
                    location={asLocation(location)}
                    trainerCount={trainerCounts[location.id] || 0}
                    isClaimed={claimedIds.has(location.id)}
                    logoUrl={clubLogos[location.id]}
                  />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-8">
                  <Pagination>
                    <PaginationContent>
                      {currentPage > 1 && (
                        <PaginationItem>
                          <PaginationPrevious
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              setCurrentPage(p => Math.max(1, p - 1));
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          />
                        </PaginationItem>
                      )}

                      {getPageNumbers().map((page, i) => (
                        <PaginationItem key={i}>
                          {page === 'ellipsis' ? (
                            <PaginationEllipsis />
                          ) : (
                            <PaginationLink
                              href="#"
                              isActive={page === currentPage}
                              onClick={(e) => {
                                e.preventDefault();
                                setCurrentPage(page);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              }}
                            >
                              {page}
                            </PaginationLink>
                          )}
                        </PaginationItem>
                      ))}

                      {currentPage < totalPages && (
                        <PaginationItem>
                          <PaginationNext
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              setCurrentPage(p => Math.min(totalPages, p + 1));
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          />
                        </PaginationItem>
                      )}
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </MarketingLayout>
  );
}
