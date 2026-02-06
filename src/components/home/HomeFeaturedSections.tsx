import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Star, MapPin, CheckCircle, Users, ArrowRight, Building2, Home, Sun } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/lib/supabaseClient';
import { getPublicAcademies, type AcademyProfile } from '@/lib/academy';
import { getActiveLocations, getClaimedLocationIds, type Location } from '@/lib/locations';
import { getBatchTrainerRatings } from '@/lib/reviews';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { shuffleArray } from '@/components/featured/FeaturedSection';

const MAX_FEATURED = 8;

interface TrainerWithProfile {
  id: string;
  user_id: string;
  slug: string | null;
  hourly_rate: number | null;
  experience_years: number | null;
  is_verified: boolean;
  subscription_status: string | null;
  profile: {
    full_name: string | null;
    avatar_url: string | null;
    location: string | null;
  } | null;
  averageRating: number;
  reviewCount: number;
}

export function HomeFeaturedSections() {
  const { t } = useTranslation('common');
  const localizePath = useLocalizedPathFn();
  
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [academies, setAcademies] = useState<Partial<AcademyProfile>[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [clubLogos, setClubLogos] = useState<Record<string, string>>({});
  const [featuredLocationIds, setFeaturedLocationIds] = useState<Set<string>>(new Set());
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const now = new Date().toISOString();
        
        // Fetch all data in parallel
        const [trainersResult, academiesData, locationsData, claimedData] = await Promise.all([
          supabase
            .from('trainer_profiles_safe')
            .select('id, user_id, slug, hourly_rate, experience_years, is_verified, subscription_status')
            .eq('is_public', true)
            .eq('subscription_status', 'active'),
          getPublicAcademies(),
          getActiveLocations(),
          getClaimedLocationIds(),
        ]);

        // Process trainers
        if (trainersResult.data) {
          const userIds = trainersResult.data.map(t => t.user_id);
          const trainerIds = trainersResult.data.map(t => t.id);
          
          const [profilesResult, ratingsMap] = await Promise.all([
            supabase
              .from('profiles_public')
              .select('user_id, full_name, avatar_url, location')
              .in('user_id', userIds),
            getBatchTrainerRatings(trainerIds),
          ]);

          const trainersWithProfiles = trainersResult.data.map(trainer => {
            const ratings = ratingsMap.get(trainer.id) || { average: 0, count: 0 };
            return {
              ...trainer,
              profile: profilesResult.data?.find(p => p.user_id === trainer.user_id) || null,
              averageRating: ratings.average,
              reviewCount: ratings.count,
            };
          });
          
          setTrainers(trainersWithProfiles);
        }

        setAcademies(academiesData);
        setLocations(locationsData);
        setClaimedIds(claimedData);

        // Fetch club profiles for logos and featured status
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
          // Add logos from locations table for unclaimed locations
          locationsData.forEach(loc => {
            if (loc.logo_url && !logosMap[loc.id]) {
              logosMap[loc.id] = loc.logo_url;
            }
          });
          setClubLogos(logosMap);
          setFeaturedLocationIds(featuredIds);
        }
      } catch (error) {
        console.error('Error fetching featured data:', error);
      } finally {
        setLoading(false);
      }
    }
    
    fetchData();
  }, []);

  // Featured items (shuffled and limited)
  const featuredTrainers = useMemo(() => {
    return shuffleArray(trainers).slice(0, MAX_FEATURED);
  }, [trainers]);

  const featuredAcademies = useMemo(() => {
    const featured = academies.filter(a => a.subscription_status === 'active');
    return shuffleArray(featured).slice(0, MAX_FEATURED);
  }, [academies]);

  const featuredLocations = useMemo(() => {
    const featured = locations.filter(loc => featuredLocationIds.has(loc.id));
    return shuffleArray(featured).slice(0, MAX_FEATURED);
  }, [locations, featuredLocationIds]);

  const getInitials = (name: string | null) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  if (loading) {
    return (
      <>
        <FeaturedSectionSkeleton />
        <FeaturedSectionSkeleton />
        <FeaturedSectionSkeleton />
      </>
    );
  }

  // Don't render if no featured items
  if (featuredTrainers.length === 0 && featuredAcademies.length === 0 && featuredLocations.length === 0) {
    return null;
  }

  return (
    <>
      {/* Featured Trainers */}
      {featuredTrainers.length > 0 && (
        <section className="py-16 md:py-20">
          <div className="container mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="flex items-center justify-between mb-8"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Star className="h-5 w-5 text-primary fill-primary/30" />
                </div>
                <div>
                  <h2 className="text-2xl md:text-3xl font-bold">{t('featured.trainers')}</h2>
                  <p className="text-muted-foreground text-sm">{t('featured.trainersDescription')}</p>
                </div>
              </div>
              <Button variant="ghost" asChild className="hidden sm:flex">
                <Link to={localizePath('/trainers')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </motion.div>

            <div className="overflow-x-auto pb-4 -mx-4 px-4">
              <div className="flex gap-4 min-w-max lg:grid lg:grid-cols-4 lg:min-w-0">
                {featuredTrainers.map((trainer, index) => (
                  <motion.div
                    key={trainer.id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50 w-[260px] lg:w-auto flex-shrink-0"
                      onClick={() => window.location.href = localizePath(`/trainer/${trainer.slug || trainer.id}`)}
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
                                <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                              )}
                            </div>
                            {trainer.profile?.location && (
                              <CardDescription className="flex items-center gap-1 mt-0.5 text-xs">
                                <MapPin className="h-3 w-3" />
                                {trainer.profile.location}
                              </CardDescription>
                            )}
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
                          {trainer.hourly_rate && (
                            <span className="font-semibold text-primary">€{trainer.hourly_rate}/hr</span>
                          )}
                          {trainer.experience_years && (
                            <span className="text-muted-foreground text-xs">
                              {trainer.experience_years}y exp
                            </span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="sm:hidden mt-4 text-center">
              <Button variant="outline" asChild>
                <Link to={localizePath('/trainers')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Featured Academies */}
      {featuredAcademies.length > 0 && (
        <section className="py-16 md:py-20 bg-accent/30">
          <div className="container mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="flex items-center justify-between mb-8"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h2 className="text-2xl md:text-3xl font-bold">{t('featured.academies')}</h2>
                  <p className="text-muted-foreground text-sm">{t('featured.academiesDescription')}</p>
                </div>
              </div>
              <Button variant="ghost" asChild className="hidden sm:flex">
                <Link to={localizePath('/academies')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </motion.div>

            <div className="overflow-x-auto pb-4 -mx-4 px-4">
              <div className="flex gap-4 min-w-max lg:grid lg:grid-cols-4 lg:min-w-0">
                {featuredAcademies.map((academy, index) => (
                  <motion.div
                    key={academy.id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50 w-[260px] lg:w-auto flex-shrink-0 h-full"
                      onClick={() => window.location.href = localizePath(`/academies/${academy.slug}`)}
                    >
                      <CardContent className="pt-6">
                        <div className="flex items-start gap-3">
                          <Avatar className="h-12 w-12 rounded-lg">
                            <AvatarImage src={academy.logo_url || ''} className="object-contain" />
                            <AvatarFallback className="rounded-lg">{getInitials(academy.name || '')}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold truncate">{academy.name}</h3>
                              {(academy.is_verified || academy.subscription_status === 'active') && (
                                <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                              )}
                            </div>
                            {academy.description && (
                              <p className="text-sm text-muted-foreground line-clamp-2">
                                {academy.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="sm:hidden mt-4 text-center">
              <Button variant="outline" asChild>
                <Link to={localizePath('/academies')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Featured Locations */}
      {featuredLocations.length > 0 && (
        <section className="py-16 md:py-20">
          <div className="container mx-auto px-4">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="flex items-center justify-between mb-8"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <MapPin className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h2 className="text-2xl md:text-3xl font-bold">{t('featured.locations')}</h2>
                  <p className="text-muted-foreground text-sm">{t('featured.locationsDescription')}</p>
                </div>
              </div>
              <Button variant="ghost" asChild className="hidden sm:flex">
                <Link to={localizePath('/locations')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </motion.div>

            <div className="overflow-x-auto pb-4 -mx-4 px-4">
              <div className="flex gap-4 min-w-max lg:grid lg:grid-cols-4 lg:min-w-0">
                {featuredLocations.map((location, index) => (
                  <motion.div
                    key={location.id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.05 }}
                  >
                    <Card
                      className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50 w-[260px] lg:w-auto flex-shrink-0 h-full relative"
                      onClick={() => window.location.href = localizePath(`/locations/${location.slug}`)}
                    >
                      <div className="absolute top-3 right-3">
                        <CheckCircle className="h-4 w-4 text-primary" />
                      </div>
                      <CardHeader className="pb-2">
                        <div className="flex items-start gap-3">
                          {(claimedIds.has(location.id) || clubLogos[location.id]) && (
                            <Avatar className="h-10 w-10 shrink-0">
                              <AvatarImage src={clubLogos[location.id] || undefined} className="object-contain" />
                              <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                {getInitials(location.name)}
                              </AvatarFallback>
                            </Avatar>
                          )}
                          <CardTitle className="text-base break-words pr-6">{location.name}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="flex items-start gap-2 text-sm text-muted-foreground">
                          <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                          <span>{location.city}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {(location.indoor_courts != null && location.indoor_courts > 0) && (
                            <Badge variant="outline" className="flex items-center gap-1 text-xs">
                              <Home className="h-3 w-3" />
                              {location.indoor_courts} {t('locations.indoorCourts')}
                            </Badge>
                          )}
                          {(location.outdoor_courts != null && location.outdoor_courts > 0) && (
                            <Badge variant="outline" className="flex items-center gap-1 text-xs">
                              <Sun className="h-3 w-3" />
                              {location.outdoor_courts} {t('locations.outdoorCourts')}
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            </div>

            <div className="sm:hidden mt-4 text-center">
              <Button variant="outline" asChild>
                <Link to={localizePath('/locations')}>
                  {t('viewAll')}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function FeaturedSectionSkeleton() {
  return (
    <section className="py-16 md:py-20">
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-8">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-12 w-12 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-5 w-32 mb-2" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
