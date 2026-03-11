import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, MapPin, Star, ArrowLeft, TrendingUp, ChevronRight, ChevronDown, MessageSquare, CalendarCheck, Clock, CheckCircle, Trophy } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TrainerFilters, TrainerFiltersState, DEFAULT_FILTERS, RatingSystem } from '@/components/trainers/TrainerFilters';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getBatchTrainerRatings } from '@/lib/reviews';
import { getTrainerIdsInPaidAcademies } from '@/lib/academy';
import { SEO } from '@/components/SEO';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { logger } from '@/lib/logger';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { getPopularCities, type CityWithTrainerCount } from '@/lib/cities';
import { Location } from '@/lib/locations';
import { FeaturedSection, FeaturedBadge, shuffleArray } from '@/components/featured/FeaturedSection';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from '@/components/ui/pagination';

const TRAINERS_PER_PAGE = 48;
const MAX_FEATURED = 6;

interface TrainerWithProfile {
  id: string;
  user_id: string;
  slug: string | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
  subscription_status: string | null;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    bio: string | null;
    location: string | null;
    skill_rating: number | null;
    rating_system: string | null;
  } | null;
  averageRating: number;
  reviewCount: number;
  hasAvailability: boolean;
}

type SortOption = 'rating' | 'experience';

export default function Trainers() {
  const { t } = useTranslation(['trainer', 'common']);
  const [searchParams, setSearchParams] = useSearchParams();
  const [featuredOpen, setFeaturedOpen] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();
  const localizePath = useLocalizedPathFn();

  // Parse filters from URL
  const searchQuery = searchParams.get('search') || '';
  const sortBy = (searchParams.get('sort') as SortOption) || 'rating';
  const filters: TrainerFiltersState = useMemo(() => ({
    locationId: searchParams.get('locationId') || 'all',
    minRating: Number(searchParams.get('minRating')) || 0,
    minExperience: Number(searchParams.get('minExperience')) || 0,
    specializations: searchParams.get('specializations')?.split(',').filter(Boolean) || [],
    certifications: searchParams.get('certifications')?.split(',').filter(Boolean) || [],
    verifiedOnly: searchParams.get('verified') === 'true',
    ratingSystem: searchParams.get('ratingSystem') || '',
    minTrainerRating: Number(searchParams.get('minTrainerRating')) || 0,
    hasAvailability: searchParams.get('hasAvailability') === 'true',
  }), [searchParams]);

  // Parse current page from URL
  const currentPage = Number(searchParams.get('page')) || 1;

  // Update URL when page changes
  const setCurrentPage = (page: number) => {
    const newParams = new URLSearchParams(searchParams);
    if (page > 1) {
      newParams.set('page', String(page));
    } else {
      newParams.delete('page');
    }
    setSearchParams(newParams, { replace: true });
  };

  // Update URL when search changes
  const setSearchQuery = (query: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (query) {
      newParams.set('search', query);
    } else {
      newParams.delete('search');
    }
    // Reset to page 1 when search changes
    newParams.delete('page');
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
    
    // Rating system filter
    if (newFilters.ratingSystem) {
      newParams.set('ratingSystem', newFilters.ratingSystem);
    } else {
      newParams.delete('ratingSystem');
    }
    if (newFilters.minTrainerRating > 0) {
      newParams.set('minTrainerRating', String(newFilters.minTrainerRating));
    } else {
      newParams.delete('minTrainerRating');
    }

    // Has availability
    if (newFilters.hasAvailability) {
      newParams.set('hasAvailability', 'true');
    } else {
      newParams.delete('hasAvailability');
    }
    
    // Reset to page 1 when filters change
    newParams.delete('page');
    setSearchParams(newParams, { replace: true });
  };

  const clearFilters = () => {
    setSearchParams({}, { replace: true });
  };

  // Fetch rating systems
  const { data: ratingSystems = [] } = useQuery({
    queryKey: ['rating-systems'],
    queryFn: async () => {
      const { data } = await supabase
        .from('rating_systems')
        .select('code, name, min_rating, max_rating, lower_is_better, step')
        .eq('is_active', true)
        .order('display_order');
      return data || [];
    },
    staleTime: 10 * 60 * 1000,
  });

  // Fetch popular cities
  const { data: popularCities = [] } = useQuery({
    queryKey: ['popular-cities'],
    queryFn: () => getPopularCities(8),
    staleTime: 10 * 60 * 1000,
  });

  // Main trainers data query
  const { data: trainersData, isLoading: loading } = useQuery({
    queryKey: ['trainers-page-data'],
    queryFn: async () => {
      const now = new Date().toISOString();
      const { data: allPublicTrainers, error: trainerError } = await supabase
        .from('trainer_profiles_safe')
        .select('id, user_id, slug, experience_years, certifications, specializations, is_verified, is_public, subscription_status, trial_ends_at')
        .eq('is_public', true);
      
      if (trainerError) {
        logger.error('Error fetching trainers', new Error(trainerError.message), { component: 'Trainers' });
        return { trainers: [], clubLocations: [], trainerLocationMap: new Map<string, string[]>(), allSpecializations: [], allCertifications: [] };
      }

      const allTrainerIds = allPublicTrainers.map(t => t.id);
      const paidAcademyTrainerIds = await getTrainerIdsInPaidAcademies(allTrainerIds);

      const trainerProfiles = allPublicTrainers.filter(t =>
        t.subscription_status === 'active' ||
        (t.trial_ends_at && t.trial_ends_at > now) ||
        paidAcademyTrainerIds.has(t.id)
      );

      const userIds = trainerProfiles.map(t => t.user_id);
      const trainerIds = trainerProfiles.map(t => t.id);

      const [profilesResult, trainerLocationResult, ratingsMap, availabilityResult] = await Promise.all([
        supabase.from('profiles_public').select('user_id, full_name, avatar_url, bio, location, skill_rating, rating_system').in('user_id', userIds),
        supabase.from('trainer_locations').select('trainer_id, location:locations(id, name, city, country, slug)').in('trainer_id', trainerIds),
        getBatchTrainerRatings(trainerIds),
        supabase.from('availability_slots').select('trainer_id').in('trainer_id', trainerIds).gt('start_time', new Date().toISOString()).eq('is_public', true),
      ]);

      const profiles = profilesResult.data;
      const trainerLocationData = trainerLocationResult.data;

      // Build location map
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

      const trainersWithAvailability = new Set(availabilityResult.data?.map(a => a.trainer_id) || []);

      const trainers = trainerProfiles.map(trainer => {
        const ratings = ratingsMap.get(trainer.id) || { average: 0, count: 0 };
        return {
          ...trainer,
          profile: (profiles || []).find(p => p.user_id === trainer.user_id) || null,
          averageRating: ratings.average,
          reviewCount: ratings.count,
          hasAvailability: trainersWithAvailability.has(trainer.id),
        };
      });

      const specs = trainerProfiles.flatMap(t => t.specializations || []);
      const certs = trainerProfiles.flatMap(t => t.certifications || []);

      return {
        trainers,
        clubLocations: Array.from(uniqueLocationsMap.values()).sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)),
        trainerLocationMap: locationMap,
        allSpecializations: [...new Set(specs)].sort(),
        allCertifications: [...new Set(certs)].sort(),
      };
    },
    staleTime: 5 * 60 * 1000,
  });

  const trainers = trainersData?.trainers || [];
  const clubLocations = trainersData?.clubLocations || [];
  const trainerLocationMap = trainersData?.trainerLocationMap || new Map<string, string[]>();
  const allSpecializations = trainersData?.allSpecializations || [];
  const allCertifications = trainersData?.allCertifications || [];

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.locationId !== 'all') count++;
    
    if (filters.minRating > 0) count++;
    if (filters.minExperience > 0) count++;
    if (filters.specializations.length > 0) count++;
    if (filters.certifications.length > 0) count++;
    if (filters.verifiedOnly) count++;
    if (filters.ratingSystem) count++;
    if (filters.minTrainerRating > 0) count++;
    if (filters.hasAvailability) count++;
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
      
      // Trainer rating system filter (now uses profile.rating_system and profile.skill_rating)
      let matchesTrainerRating = true;
      if (filters.ratingSystem && filters.minTrainerRating > 0) {
        // Only apply if trainer uses the selected rating system
        if (trainer.profile?.rating_system === filters.ratingSystem) {
          const trainerRating = trainer.profile?.skill_rating || 0;
          const ratingSystemDef = ratingSystems.find(rs => rs.code === filters.ratingSystem);
          if (ratingSystemDef?.lower_is_better) {
            // Lower is better (e.g., KNLTB): trainer rating should be <= filter value
            matchesTrainerRating = trainerRating > 0 && trainerRating <= filters.minTrainerRating;
          } else {
            // Higher is better: trainer rating should be >= filter value
            matchesTrainerRating = trainerRating >= filters.minTrainerRating;
          }
        } else {
          matchesTrainerRating = false; // Trainer doesn't use selected system
        }
      } else if (filters.ratingSystem && !filters.minTrainerRating) {
        // Just filter by system, any rating
        matchesTrainerRating = trainer.profile?.rating_system === filters.ratingSystem;
      }
      
      // Verified filter
      const matchesVerified = !filters.verifiedOnly || trainer.is_verified;

      // Availability filter
      const matchesAvailability = !filters.hasAvailability || trainer.hasAvailability;
      
      return matchesSearch && matchesLocation && matchesRating && 
             matchesExperience && matchesSpecializations && matchesCertifications && matchesTrainerRating && matchesVerified && matchesAvailability;
    });

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'rating':
          return b.averageRating - a.averageRating;
        case 'experience':
          return (b.experience_years || 0) - (a.experience_years || 0);
        default:
          return 0;
      }
    });

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainers, searchQuery, filters, sortBy, trainerLocationMap]);

  // Featured trainers (paid/active subscription)
  const featuredTrainers = useMemo(() => {
    const featured = trainers.filter(t => t.subscription_status === 'active');
    return shuffleArray(featured).slice(0, MAX_FEATURED);
  }, [trainers]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredAndSortedTrainers.length / TRAINERS_PER_PAGE);
  
  const paginatedTrainers = useMemo(() => {
    const startIndex = (currentPage - 1) * TRAINERS_PER_PAGE;
    return filteredAndSortedTrainers.slice(startIndex, startIndex + TRAINERS_PER_PAGE);
  }, [filteredAndSortedTrainers, currentPage]);

  // Reset to page 1 when filters change and current page is out of bounds
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(1);
    }
  }, [filteredAndSortedTrainers.length, totalPages, currentPage]);

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
            <Button variant="ghost" size="icon" onClick={() => navigate('/app/player')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-lg sm:text-xl">Find Trainers</span>
          </div>
          {!user && (
            <Button onClick={() => navigate(localizePath('/auth'))}>Sign In</Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {/* Filters at top */}
        <div className="mb-6">
          <TrainerFilters
            filters={filters}
            onChange={setFilters}
            locations={clubLocations}
            allSpecializations={allSpecializations}
            allCertifications={allCertifications}
            ratingSystems={ratingSystems}
            activeFilterCount={activeFilterCount}
          />
        </div>

        {/* Featured Trainers Section */}
        {!loading && featuredTrainers.length > 0 && !searchQuery && activeFilterCount === 0 && (
          <Collapsible open={featuredOpen} onOpenChange={setFeaturedOpen} className="mb-8">
            <section className="py-6 px-4 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 rounded-xl border border-primary/10">
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center justify-between gap-2 cursor-pointer group">
                  <div className="flex items-center gap-2">
                    <Star className="h-5 w-5 text-primary fill-primary/50" />
                    <h2 className="text-lg font-semibold">{t('common:featured.trainers')}</h2>
                    <span className="text-sm text-muted-foreground">
                      ({featuredTrainers.length})
                    </span>
                  </div>
                  <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${featuredOpen ? 'rotate-180' : ''}`} />
                </button>
              </CollapsibleTrigger>
              
              <CollapsibleContent>
                <p className="text-sm text-muted-foreground mt-2 mb-4">
                  {t('common:featured.trainersDescription')}
                </p>
                <div className="overflow-x-auto pb-2 -mx-4 px-4">
                  <div className="flex gap-6 min-w-max lg:grid lg:grid-cols-3 lg:min-w-0">
                    {featuredTrainers.map((trainer) => (
                    <Card 
                      key={trainer.id} 
                      className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50 w-[260px] lg:w-auto flex-shrink-0"
                      onClick={() => navigate(localizePath(`/trainer/${trainer.slug || trainer.id}`))}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start gap-3">
                          <Avatar className="h-12 w-12">
                            <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                            <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <CardTitle className="text-base truncate">
                                {trainer.profile?.full_name || 'Trainer'}
                              </CardTitle>
                              {trainer.is_verified && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{t('common:verifiedProfile', 'Verified profile')}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                            {trainer.reviewCount > 0 && (
                              <div className="flex items-center gap-1 mt-1">
                                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                                <span className="font-medium text-sm">{trainer.averageRating.toFixed(1)}</span>
                                <span className="text-xs text-muted-foreground">({trainer.reviewCount})</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="flex items-center justify-between text-sm">
                          {trainer.experience_years && (
                            <span className="text-muted-foreground text-xs">
                              {trainer.experience_years}y exp
                            </span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                    ))}
                  </div>
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        )}

        {/* Search and Sort */}
        <div className="mb-6 space-y-4">
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
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <TrendingUp className="h-4 w-4 mr-2" />
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rating">Top Rated</SelectItem>
                <SelectItem value="experience">Most Experienced</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            {totalPages > 1 
              ? t('showingResults', {
                  start: ((currentPage - 1) * TRAINERS_PER_PAGE) + 1,
                  end: Math.min(currentPage * TRAINERS_PER_PAGE, filteredAndSortedTrainers.length),
                  total: filteredAndSortedTrainers.length
                })
              : `${filteredAndSortedTrainers.length} trainer${filteredAndSortedTrainers.length !== 1 ? 's' : ''} found`
            }
          </p>
        </div>

        {/* Trainers Grid */}
        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="h-[140px]">
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <div className="h-12 w-12 rounded-full bg-muted animate-pulse" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                      <div className="h-3 w-16 bg-muted animate-pulse rounded" />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="h-3 w-12 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredAndSortedTrainers.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">No trainers found</p>
              {searchQuery || activeFilterCount > 0 ? (
                <Button variant="outline" onClick={() => { setSearchQuery(''); setFilters(DEFAULT_FILTERS); }}>
                  {t('clearFilters')}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('noTrainersYet')}
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {paginatedTrainers.map((trainer) => (
              <Card 
                key={trainer.id} 
                className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50"
                onClick={() => navigate(localizePath(`/trainer/${trainer.slug || trainer.id}`))}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                      <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base truncate">
                          {trainer.profile?.full_name || 'Trainer'}
                        </CardTitle>
                        {trainer.is_verified && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{t('common:verifiedProfile', 'Verified profile')}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                      {trainer.reviewCount > 0 && (
                        <div className="flex items-center gap-1 mt-1">
                          <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                          <span className="font-medium text-sm">{trainer.averageRating.toFixed(1)}</span>
                          <span className="text-xs text-muted-foreground">({trainer.reviewCount})</span>
                        </div>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      {trainer.hasAvailability && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 gap-0.5">
                          <CalendarCheck className="h-3 w-3" />
                          Available
                        </Badge>
                      )}
                    </div>
                    {trainer.experience_years && (
                      <span className="text-muted-foreground text-xs">
                        {trainer.experience_years}y exp
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <Pagination className="mt-8">
              <PaginationContent>
                {currentPage > 1 && (
                  <PaginationItem>
                    <PaginationPrevious 
                      onClick={() => setCurrentPage(currentPage - 1)}
                      className="cursor-pointer"
                    />
                  </PaginationItem>
                )}
                
                {/* First page */}
                <PaginationItem>
                  <PaginationLink
                    onClick={() => setCurrentPage(1)}
                    isActive={currentPage === 1}
                    className="cursor-pointer"
                  >
                    1
                  </PaginationLink>
                </PaginationItem>
                
                {/* Ellipsis before current */}
                {currentPage > 3 && (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                )}
                
                {/* Pages around current */}
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(page => page !== 1 && page !== totalPages && Math.abs(page - currentPage) <= 1)
                  .map(page => (
                    <PaginationItem key={page}>
                      <PaginationLink
                        onClick={() => setCurrentPage(page)}
                        isActive={currentPage === page}
                        className="cursor-pointer"
                      >
                        {page}
                      </PaginationLink>
                    </PaginationItem>
                  ))
                }
                
                {/* Ellipsis after current */}
                {currentPage < totalPages - 2 && (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                )}
                
                {/* Last page */}
                {totalPages > 1 && (
                  <PaginationItem>
                    <PaginationLink
                      onClick={() => setCurrentPage(totalPages)}
                      isActive={currentPage === totalPages}
                      className="cursor-pointer"
                    >
                      {totalPages}
                    </PaginationLink>
                  </PaginationItem>
                )}
                
                {currentPage < totalPages && (
                  <PaginationItem>
                    <PaginationNext 
                      onClick={() => setCurrentPage(currentPage + 1)}
                      className="cursor-pointer"
                    />
                  </PaginationItem>
                )}
              </PaginationContent>
            </Pagination>
          )}
          </>
        )}
      </main>
    </div>
  );
}