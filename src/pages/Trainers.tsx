import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Star, ArrowLeft, TrendingUp, CalendarCheck, CheckCircle } from 'lucide-react';
import { TrainerFilters, TrainerFiltersState, DEFAULT_FILTERS } from '@/components/trainers/TrainerFilters';
import { searchPublicTrainers, getPublicTrainerDirectoryFacets } from '@/lib/publicTrainerDirectory';
import { useMarketingNamespace } from '@/hooks/useMarketingNamespace';
import { SEO } from '@/components/SEO';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getPopularCities } from '@/lib/cities';
import { Location } from '@/lib/locations';
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

type SortOption = 'rating' | 'experience';

export default function Trainers() {
  const { t } = useTranslation(['trainer', 'common', 'marketing']);
  // The marketing namespace is lazy-loaded; without this the directory strings
  // render their English defaults on /nl.
  useMarketingNamespace();
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang || 'en';
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Fetch popular cities (result not rendered here; query kept so the fetch/cache behavior is unchanged)
  useQuery({
    queryKey: ['popular-cities'],
    queryFn: () => getPopularCities(8),
    staleTime: 10 * 60 * 1000,
  });

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

  // Filter OPTIONS (distinct locations / specializations / certifications) come
  // from a single bounded aggregate RPC — not derived from a full trainer scan.
  const { data: facets } = useQuery({
    queryKey: ['trainer-directory-facets'],
    queryFn: () => getPublicTrainerDirectoryFacets(),
    staleTime: 10 * 60 * 1000,
  });
  const clubLocations = useMemo<Location[]>(
    () => [...(facets?.locations ?? [])].sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)) as Location[],
    [facets],
  );
  const allSpecializations = facets?.specializations ?? [];
  const allCertifications = facets?.certifications ?? [];

  // The directory itself is a BOUNDED, server-side query: one page + total_count.
  // All filtering, sorting and pagination happen in the DB (search_public_trainers),
  // keyed on the URL params so results are cached per distinct view.
  const { data: searchResult, isLoading: loading } = useQuery({
    queryKey: ['public-trainers', searchQuery, sortBy, currentPage, filters],
    queryFn: () => searchPublicTrainers({
      search: searchQuery,
      locationId: filters.locationId,
      minRating: filters.minRating,
      minExperience: filters.minExperience,
      specializations: filters.specializations,
      certifications: filters.certifications,
      verified: filters.verifiedOnly,
      ratingSystem: filters.ratingSystem,
      minTrainerRating: filters.minTrainerRating,
      hasAvailability: filters.hasAvailability,
      sort: sortBy,
      page: currentPage,
      pageSize: TRAINERS_PER_PAGE,
    }),
    staleTime: 60 * 1000,
    placeholderData: (prev) => prev, // keep the old page visible while the next loads
  });

  const totalCount = searchResult?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / TRAINERS_PER_PAGE));

  // The server already returns exactly one page, shaped to the card's needs.
  const paginatedTrainers = useMemo(
    () => (searchResult?.trainers ?? []).map((c) => ({
      id: c.trainer_profile_id,
      slug: c.slug,
      is_verified: c.is_verified,
      experience_years: c.experience_years,
      averageRating: c.average_rating,
      reviewCount: c.review_count,
      hasAvailability: c.has_availability,
      profile: { full_name: c.full_name, avatar_url: c.avatar_url, bio: c.bio, location: c.location },
    })),
    [searchResult],
  );

  // Reset to page 1 when the current page falls out of bounds (e.g. after a filter
  // change). Gated on a RESOLVED result so a bookmarked deep-page URL isn't snapped
  // to page 1 during the initial load (when totalCount is still 0).
  useEffect(() => {
    if (searchResult && currentPage > totalPages) {
      setCurrentPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchResult, totalPages, currentPage]);

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('marketing:trainersDirectory.listName', 'Padel Trainers'),
    "description": t('marketing:trainersDirectory.listDescription', 'Find certified padel trainers worldwide. Browse profiles, compare rates, and book lessons.'),
    "numberOfItems": totalCount,
    "itemListElement": paginatedTrainers.slice(0, 10).map((trainer, index) => ({
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

  const breadcrumbSchema = buildBreadcrumbList([
    { name: t('marketing:cityPage.home', 'Home'), url: `/${currentLang}` },
    { name: t('marketing:cityPage.trainers', 'Trainers'), url: `/${currentLang}/trainers` },
  ]);

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title={t('marketing:trainersDirectory.seoTitle', 'Find Padel Trainers')}
        description={t('marketing:trainersDirectory.seoDescription', 'Discover certified padel trainers worldwide. Compare rates, read reviews, and book lessons that match your skill level.')}
        url="/trainers"
        structuredData={[structuredData, breadcrumbSchema]}
      />
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label={t('marketing:trainersDirectory.goBack', 'Go back')} onClick={() => navigate('/app/player')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-lg sm:text-xl">{t('marketing:trainersDirectory.findTrainers', 'Find Trainers')}</span>
          </div>
          {!user && (
            <Button onClick={() => navigate(localizePath('/auth'))}>{t('common:signIn', 'Sign In')}</Button>
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

        {/* NOTE: a "Featured trainers" section used to live here, but it filtered
            `trainer.subscription_status === 'active'` while that column was never
            selected — so it was always empty and never rendered. Removed as dead
            code rather than left silently broken; a real featured concept needs an
            explicit public-safe priority field + product decision. */}

        {/* Search and Sort */}
        <div className="mb-6 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('marketing:cityPage.searchPlaceholder', 'Search trainers by name, specialty...')}
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <TrendingUp className="h-4 w-4 mr-2" />
                <SelectValue placeholder={t('marketing:trainersDirectory.sortBy', 'Sort by')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rating">{t('marketing:cityPage.sortTopRated', 'Top Rated')}</SelectItem>
                <SelectItem value="experience">{t('marketing:cityPage.sortExperience', 'Most Experienced')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm text-muted-foreground">
            {totalPages > 1
              ? t('showingResults', {
                  start: ((currentPage - 1) * TRAINERS_PER_PAGE) + 1,
                  end: Math.min(currentPage * TRAINERS_PER_PAGE, totalCount),
                  total: totalCount
                })
              : t('marketing:trainersDirectory.trainersFound', {
                  count: totalCount,
                  defaultValue_one: '{{count}} trainer found',
                  defaultValue_other: '{{count}} trainers found',
                })
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
        ) : totalCount === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">{t('marketing:trainersDirectory.noTrainersFound', 'No trainers found')}</p>
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
                          {trainer.profile?.full_name || t('marketing:trainersDirectory.trainerFallback', 'Trainer')}
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
                          {t('marketing:trainersDirectory.available', 'Available')}
                        </Badge>
                      )}
                    </div>
                    {trainer.experience_years && (
                      <span className="text-muted-foreground text-xs">
                        {t('marketing:trainersDirectory.yearsExp', '{{years}}y exp', { years: trainer.experience_years })}
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