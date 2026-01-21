import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, MapPin, Star, ArrowLeft, TrendingUp, ChevronRight } from 'lucide-react';
import { TrainerFilters, TrainerFiltersState, DEFAULT_FILTERS } from '@/components/trainers/TrainerFilters';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getTrainerAverageRating } from '@/lib/reviews';
import { SEO } from '@/components/SEO';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { getPopularCities, type CityWithTrainerCount } from '@/lib/cities';
import { Location } from '@/lib/locations';

interface TrainerWithProfile {
  id: string;
  user_id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  knltb_rating: number | null;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
  } | null;
  averageRating: number;
  reviewCount: number;
}

type SortOption = 'rating' | 'price-low' | 'price-high' | 'experience';

export default function Trainers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [clubLocations, setClubLocations] = useState<Location[]>([]);
  const [trainerLocationMap, setTrainerLocationMap] = useState<Map<string, string[]>>(new Map());
  const [allSpecializations, setAllSpecializations] = useState<string[]>([]);
  const [allCertifications, setAllCertifications] = useState<string[]>([]);
  const [popularCities, setPopularCities] = useState<CityWithTrainerCount[]>([]);
  const navigate = useNavigate();
  const { user } = useAuth();

  // Parse filters from URL
  const searchQuery = searchParams.get('search') || '';
  const sortBy = (searchParams.get('sort') as SortOption) || 'rating';
  const filters: TrainerFiltersState = useMemo(() => ({
    locationId: searchParams.get('locationId') || 'all',
    priceRange: [
      Number(searchParams.get('minPrice')) || 0,
      Number(searchParams.get('maxPrice')) || 200
    ] as [number, number],
    minRating: Number(searchParams.get('minRating')) || 0,
    minExperience: Number(searchParams.get('minExperience')) || 0,
    specializations: searchParams.get('specializations')?.split(',').filter(Boolean) || [],
    certifications: searchParams.get('certifications')?.split(',').filter(Boolean) || [],
    verifiedOnly: searchParams.get('verified') === 'true',
    minKnltbRating: Number(searchParams.get('minKnltb')) || 0,
  }), [searchParams]);

  // Update URL when search changes
  const setSearchQuery = (query: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (query) {
      newParams.set('search', query);
    } else {
      newParams.delete('search');
    }
    setSearchParams(newParams, { replace: true });
  };

  // Update URL when sort changes
  const setSortBy = (sort: SortOption) => {
    const newParams = new URLSearchParams(searchParams);
    if (sort !== 'rating') {
      newParams.set('sort', sort);
    } else {
      newParams.delete('sort');
    }
    setSearchParams(newParams, { replace: true });
  };

  // Update URL when filters change
  const setFilters = (newFilters: TrainerFiltersState) => {
    const newParams = new URLSearchParams(searchParams);
    
    // Location
    if (newFilters.locationId !== 'all') {
      newParams.set('locationId', newFilters.locationId);
    } else {
      newParams.delete('locationId');
    }
    
    // Price range
    if (newFilters.priceRange[0] > 0) {
      newParams.set('minPrice', String(newFilters.priceRange[0]));
    } else {
      newParams.delete('minPrice');
    }
    if (newFilters.priceRange[1] < 200) {
      newParams.set('maxPrice', String(newFilters.priceRange[1]));
    } else {
      newParams.delete('maxPrice');
    }
    
    // Rating
    if (newFilters.minRating > 0) {
      newParams.set('minRating', String(newFilters.minRating));
    } else {
      newParams.delete('minRating');
    }
    
    // Experience
    if (newFilters.minExperience > 0) {
      newParams.set('minExperience', String(newFilters.minExperience));
    } else {
      newParams.delete('minExperience');
    }
    
    // Specializations
    if (newFilters.specializations.length > 0) {
      newParams.set('specializations', newFilters.specializations.join(','));
    } else {
      newParams.delete('specializations');
    }
    
    // Certifications
    if (newFilters.certifications.length > 0) {
      newParams.set('certifications', newFilters.certifications.join(','));
    } else {
      newParams.delete('certifications');
    }
    
    // Verified
    if (newFilters.verifiedOnly) {
      newParams.set('verified', 'true');
    } else {
      newParams.delete('verified');
    }
    
    // KNLTB
    if (newFilters.minKnltbRating > 0) {
      newParams.set('minKnltb', String(newFilters.minKnltbRating));
    } else {
      newParams.delete('minKnltb');
    }
    
    setSearchParams(newParams, { replace: true });
  };

  const clearFilters = () => {
    setSearchParams({}, { replace: true });
  };

  useEffect(() => {
    fetchTrainers();
    getPopularCities(8).then(setPopularCities);
  }, []);

  const fetchTrainers = async () => {
    setLoading(true);
    
    // Fetch trainer profiles with their general profiles
    const { data: trainerProfiles, error: trainerError } = await supabase
      .from('trainer_profiles')
      .select('id, user_id, hourly_rate, experience_years, certifications, specializations, is_verified, knltb_rating');
    
    if (trainerError) {
      console.error('Error fetching trainers:', trainerError);
      setLoading(false);
      return;
    }

    // Fetch profiles for all trainers (using public view to protect PII)
    const userIds = trainerProfiles.map(t => t.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles_public')
      .select('user_id, full_name, avatar_url, bio, location')
      .in('user_id', userIds);

    if (profilesError) {
      console.error('Error fetching profiles:', profilesError);
      setLoading(false);
      return;
    }

    // Fetch trainer locations (which clubs they teach at)
    const trainerIds = trainerProfiles.map(t => t.id);
    const { data: trainerLocationData, error: tlError } = await supabase
      .from('trainer_locations')
      .select(`
        trainer_id,
        location:locations(id, name, city, country, slug)
      `)
      .in('trainer_id', trainerIds);

    if (tlError) {
      console.error('Error fetching trainer locations:', tlError);
    }

    // Build a map of trainer_id -> location_ids
    const locationMap = new Map<string, string[]>();
    const uniqueLocationsMap = new Map<string, Location>();
    
    trainerLocationData?.forEach(tl => {
      if (tl.location) {
        const loc = tl.location as unknown as Location;
        const existing = locationMap.get(tl.trainer_id) || [];
        existing.push(loc.id);
        locationMap.set(tl.trainer_id, existing);
        uniqueLocationsMap.set(loc.id, loc);
      }
    });
    
    setTrainerLocationMap(locationMap);
    setClubLocations(Array.from(uniqueLocationsMap.values()).sort((a, b) => 
      a.city.localeCompare(b.city) || a.name.localeCompare(b.name)
    ));

    // Fetch ratings for all trainers
    const trainersWithRatings = await Promise.all(
      trainerProfiles.map(async (trainer) => {
        const { average, count } = await getTrainerAverageRating(trainer.id);
        return {
          ...trainer,
          profile: profiles.find(p => p.user_id === trainer.user_id) || null,
          averageRating: average || 0,
          reviewCount: count,
        };
      })
    );

    setTrainers(trainersWithRatings);

    // Extract unique specializations and certifications
    const specs = trainerProfiles.flatMap(t => t.specializations || []);
    const uniqueSpecs = [...new Set(specs)].sort();
    setAllSpecializations(uniqueSpecs);
    
    const certs = trainerProfiles.flatMap(t => t.certifications || []);
    const uniqueCerts = [...new Set(certs)].sort();
    setAllCertifications(uniqueCerts);
    
    setLoading(false);
  };

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.locationId !== 'all') count++;
    if (filters.priceRange[0] > 0 || filters.priceRange[1] < 200) count++;
    if (filters.minRating > 0) count++;
    if (filters.minExperience > 0) count++;
    if (filters.specializations.length > 0) count++;
    if (filters.certifications.length > 0) count++;
    if (filters.verifiedOnly) count++;
    if (filters.minKnltbRating > 0) count++;
    return count;
  }, [filters]);

  const filteredAndSortedTrainers = useMemo(() => {
    let result = trainers.filter(trainer => {
      // Search query
      const matchesSearch = !searchQuery || 
        trainer.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.profile?.bio?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.specializations?.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()));
      
      // Location filter - now matches trainer_locations
      const matchesLocation = filters.locationId === 'all' || 
        trainerLocationMap.get(trainer.id)?.includes(filters.locationId);
      
      // Price range filter
      const rate = trainer.hourly_rate || 0;
      const matchesPrice = rate >= filters.priceRange[0] && rate <= filters.priceRange[1];
      
      // Rating filter
      const matchesRating = trainer.averageRating >= filters.minRating;
      
      // Experience filter
      const experience = trainer.experience_years || 0;
      const matchesExperience = experience >= filters.minExperience;
      
      // Specializations filter
      const matchesSpecializations = filters.specializations.length === 0 ||
        filters.specializations.some(s => trainer.specializations?.includes(s));
      
      // Certifications filter
      const matchesCertifications = filters.certifications.length === 0 ||
        filters.certifications.some(c => trainer.certifications?.includes(c));
      
      // KNLTB Rating filter
      const trainerKnltb = trainer.knltb_rating || 0;
      const matchesKnltbRating = trainerKnltb >= filters.minKnltbRating;
      
      // Verified filter
      const matchesVerified = !filters.verifiedOnly || trainer.is_verified;
      
      return matchesSearch && matchesLocation && matchesPrice && matchesRating && 
             matchesExperience && matchesSpecializations && matchesCertifications && matchesKnltbRating && matchesVerified;
    });

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'rating':
          return b.averageRating - a.averageRating;
        case 'price-low':
          return (a.hourly_rate || 0) - (b.hourly_rate || 0);
        case 'price-high':
          return (b.hourly_rate || 0) - (a.hourly_rate || 0);
        case 'experience':
          return (b.experience_years || 0) - (a.experience_years || 0);
        default:
          return 0;
      }
    });

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainers, searchQuery, filters, sortBy, trainerLocationMap]);

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Trainers in the Netherlands",
    "description": "Find certified padel trainers across the Netherlands. Browse profiles, compare rates, and book lessons.",
    "numberOfItems": filteredAndSortedTrainers.length,
    "itemListElement": filteredAndSortedTrainers.slice(0, 10).map((trainer, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Person",
        "name": trainer.profile?.full_name || "Padel Trainer",
        "jobTitle": "Padel Trainer",
        "image": trainer.profile?.avatar_url,
        "address": trainer.profile?.location ? {
          "@type": "PostalAddress",
          "addressLocality": trainer.profile.location
        } : undefined
      }
    }))
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      <SEO
        title="Find Padel Trainers"
        description="Discover certified padel trainers across the Netherlands. Compare rates, read reviews, and book lessons that match your skill level."
        url="/trainers"
        structuredData={structuredData}
      />
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigate('/player')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-lg sm:text-xl">Find Trainers</span>
          </div>
          {!user && (
            <Button onClick={() => navigate('/auth')}>Sign In</Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Search and Filters */}
        <div className="mb-8 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search trainers by name, specialty..."
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <TrainerFilters
                filters={filters}
                onChange={setFilters}
                locations={clubLocations}
                allSpecializations={allSpecializations}
                allCertifications={allCertifications}
                activeFilterCount={activeFilterCount}
              />
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <TrendingUp className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rating">Top Rated</SelectItem>
                  <SelectItem value="price-low">Price: Low to High</SelectItem>
                  <SelectItem value="price-high">Price: High to Low</SelectItem>
                  <SelectItem value="experience">Most Experienced</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Active filters display */}
          {activeFilterCount > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-sm text-muted-foreground">Active filters:</span>
              {filters.locationId !== 'all' && (
                <Badge variant="secondary" className="gap-1">
                  <MapPin className="h-3 w-3" /> {clubLocations.find(l => l.id === filters.locationId)?.name || 'Location'}
                </Badge>
              )}
              {(filters.priceRange[0] > 0 || filters.priceRange[1] < 200) && (
                <Badge variant="secondary">
                  €{filters.priceRange[0]} - €{filters.priceRange[1]}
                </Badge>
              )}
              {filters.minRating > 0 && (
                <Badge variant="secondary" className="gap-1">
                  {filters.minRating}+ <Star className="h-3 w-3 fill-current" />
                </Badge>
              )}
              {filters.minExperience > 0 && (
                <Badge variant="secondary">
                  {filters.minExperience}+ years
                </Badge>
              )}
              {filters.specializations.map(spec => (
                <Badge key={spec} variant="secondary">{spec}</Badge>
              ))}
              {filters.certifications.map(cert => (
                <Badge key={cert} variant="secondary">{cert}</Badge>
              ))}
              {filters.minKnltbRating > 0 && (
                <Badge variant="secondary">KNLTB {filters.minKnltbRating}+</Badge>
              )}
              {filters.verifiedOnly && (
                <Badge variant="secondary">Verified only</Badge>
              )}
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-6 text-xs"
                onClick={() => setFilters(DEFAULT_FILTERS)}
              >
                Clear all
              </Button>
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            {filteredAndSortedTrainers.length} trainer{filteredAndSortedTrainers.length !== 1 ? 's' : ''} found
          </p>
        </div>

        {/* Trainers Grid */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredAndSortedTrainers.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">No trainers found</p>
              {searchQuery || activeFilterCount > 0 ? (
                <Button variant="outline" onClick={() => { setSearchQuery(''); setFilters(DEFAULT_FILTERS); }}>
                  Clear Filters
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Be the first trainer to join!
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAndSortedTrainers.map((trainer) => (
              <Card 
                key={trainer.id} 
                className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50"
                onClick={() => navigate(`/trainer/${trainer.user_id}`)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                      <AvatarFallback className="text-lg">
                        {getInitials(trainer.profile?.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-lg truncate">
                          {trainer.profile?.full_name || 'Trainer'}
                        </CardTitle>
                        {trainer.is_verified && (
                          <Badge variant="secondary" className="shrink-0">
                            Verified
                          </Badge>
                        )}
                        <div className="ml-auto">
                          <FollowButton trainerProfileId={trainer.id} />
                        </div>
                      </div>
                      {trainer.profile?.location && (
                        <CardDescription className="flex items-center gap-1 mt-1">
                          <MapPin className="h-3 w-3" />
                          {trainer.profile.location}
                        </CardDescription>
                      )}
                      {trainer.reviewCount > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                          <span className="font-medium">{trainer.averageRating.toFixed(1)}</span>
                          <span className="text-sm text-muted-foreground">
                            ({trainer.reviewCount} review{trainer.reviewCount !== 1 ? 's' : ''})
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {trainer.profile?.bio && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {trainer.profile.bio}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-between text-sm">
                    {trainer.hourly_rate && (
                      <span className="font-semibold text-primary">
                        €{trainer.hourly_rate}/hour
                      </span>
                    )}
                    <div className="flex items-center gap-3 text-muted-foreground">
                      {trainer.knltb_rating && (
                        <span className="font-medium text-foreground">
                          KNLTB {trainer.knltb_rating}
                        </span>
                      )}
                      {trainer.experience_years && (
                        <span>
                          {trainer.experience_years}y exp.
                        </span>
                      )}
                    </div>
                  </div>

                  {trainer.specializations && trainer.specializations.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {trainer.specializations.slice(0, 3).map((spec, i) => (
                        <Badge key={i} variant="outline" className="text-xs">
                          {spec}
                        </Badge>
                      ))}
                      {trainer.specializations.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{trainer.specializations.length - 3}
                        </Badge>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}