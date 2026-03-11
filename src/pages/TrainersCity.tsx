import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useLocalizedPathFn, useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Search, MapPin, Star, TrendingUp, Building2, ChevronRight, HelpCircle, Globe } from 'lucide-react';
import { FollowButton } from '@/components/trainers/FollowButton';
import { getTrainerAverageRating } from '@/lib/reviews';
import { getTrainerIdsInPaidAcademies } from '@/lib/academy';
import { getActiveLocations, getLocationTrainerCounts, getClaimedLocationIds, type Location } from '@/lib/locations';
import { LocationCard } from '@/components/locations/LocationCard';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { logger } from '@/lib/logger';
import { getCitiesWithTrainers, type CityWithTrainerCount } from '@/lib/cities';

interface TrainerWithProfile {
  id: string;
  user_id: string;
  slug: string | null;
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[] | null;
  specializations: string[] | null;
  is_verified: boolean;
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
}

type SortOption = 'rating' | 'experience';

export default function TrainersCity() {
  const { city } = useParams<{ city: string }>();
  const [trainers, setTrainers] = useState<TrainerWithProfile[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [academies, setAcademies] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [claimedLocationIds, setClaimedLocationIds] = useState<Set<string>>(new Set());
  const [nearbyCities, setNearbyCities] = useState<CityWithTrainerCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('rating');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useTranslation('marketing');
  const localizePath = useLocalizedPathFn();
  const currentLang = useCurrentLanguage();

  const displayCity = useMemo(() => {
    if (!city) return '';
    return decodeURIComponent(city)
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }, [city]);

  const plural = (count: number) => count !== 1 ? 's' : '';

  useEffect(() => {
    if (city) {
      fetchData();
    }
  }, [city]);

  const fetchData = async () => {
    setLoading(true);

    const [allLocations, allTrainerCounts, allClaimedIds, allCities] = await Promise.all([
      getActiveLocations(),
      getLocationTrainerCounts(),
      getClaimedLocationIds(),
      getCitiesWithTrainers(),
    ]);
    
    const cityLocations = allLocations.filter(
      l => l.city.toLowerCase().replace(/\s+/g, '-') === city?.toLowerCase()
    );
    setLocations(cityLocations);
    setTrainerCounts(allTrainerCounts);
    setClaimedLocationIds(allClaimedIds);

    // Nearby cities: exclude current city, take top 8 by trainer count
    const currentSlug = city?.toLowerCase();
    const nearby = allCities
      .filter(c => c.slug !== currentSlug && c.trainerCount > 0)
      .slice(0, 8);
    setNearbyCities(nearby);

    // Fetch academies linked to locations in this city
    if (cityLocations.length > 0) {
      const locationIds = cityLocations.map(l => l.id);
      const { data: academyLinks } = await supabase
        .from('academy_locations')
        .select('academy_profile_id')
        .in('location_id', locationIds)
        .eq('is_active', true);
      
      if (academyLinks && academyLinks.length > 0) {
        const academyIds = [...new Set(academyLinks.map(al => al.academy_profile_id))];
        const { data: academyProfiles } = await supabase
          .from('academy_profiles_public')
          .select('id, name, slug')
          .in('id', academyIds);
        setAcademies(academyProfiles || []);
      } else {
        setAcademies([]);
      }
    } else {
      setAcademies([]);
    }

    // Fetch all public trainers, then filter by subscription/academy
    const now = new Date().toISOString();
    const { data: allPublicTrainers, error: trainerError } = await supabase
      .from('trainer_profiles_safe')
      .select('id, user_id, slug, hourly_rate, experience_years, certifications, specializations, is_verified, is_public, subscription_status, trial_ends_at')
      .eq('is_public', true);

    if (trainerError) {
      logger.error('Error fetching trainers', trainerError as unknown as Error, { component: 'TrainersCity', action: 'fetchTrainers' });
      setLoading(false);
      return;
    }

    const allTrainerIds = allPublicTrainers.map(t => t.id);
    const paidAcademyTrainerIds = await getTrainerIdsInPaidAcademies(allTrainerIds);

    const trainerProfiles = allPublicTrainers.filter(t =>
      t.subscription_status === 'active' ||
      (t.trial_ends_at && t.trial_ends_at > now) ||
      paidAcademyTrainerIds.has(t.id)
    );

    const userIds = trainerProfiles.map(t => t.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles_public')
      .select('user_id, full_name, avatar_url, bio, location, skill_rating, rating_system')
      .in('user_id', userIds);

    if (profilesError) {
      logger.error('Error fetching profiles', profilesError as unknown as Error, { component: 'TrainersCity', action: 'fetchProfiles' });
      setLoading(false);
      return;
    }

    const locationIds = cityLocations.map(l => l.id);
    const { data: trainerLocationLinks } = await supabase
      .from('trainer_locations')
      .select('trainer_id')
      .in('location_id', locationIds);

    const trainerIdsAtLocations = new Set(trainerLocationLinks?.map(tl => tl.trainer_id) || []);

    const cityTrainerProfiles = trainerProfiles.filter(trainer => {
      const profile = profiles?.find(p => p.user_id === trainer.user_id);
      const profileLocationMatches = profile?.location?.toLowerCase().includes(displayCity.toLowerCase());
      const linkedToLocation = trainerIdsAtLocations.has(trainer.id);
      return profileLocationMatches || linkedToLocation;
    });

    const trainersWithRatings = await Promise.all(
      cityTrainerProfiles.map(async (trainer) => {
        const { average, count } = await getTrainerAverageRating(trainer.id);
        return {
          ...trainer,
          profile: profiles?.find(p => p.user_id === trainer.user_id) || null,
          averageRating: average || 0,
          reviewCount: count,
        };
      })
    );

    setTrainers(trainersWithRatings);
    setLoading(false);
  };

  const filteredAndSortedTrainers = useMemo(() => {
    let result = trainers.filter(trainer => {
      if (!searchQuery) return true;
      return (
        trainer.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.profile?.bio?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        trainer.specializations?.some(s => s.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    });

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
  }, [trainers, searchQuery, sortBy]);

  const getInitials = (name: string | null) => {
    if (!name) return 'T';
    return name.split(' ').map(n => n[0]).join('').toUpperCase();
  };


  // SEO structured data
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('cityPage.heroTitle', { city: displayCity }),
    "description": t('cityPage.description', { city: displayCity, count: trainers.length }),
    "numberOfItems": filteredAndSortedTrainers.length,
    "itemListElement": filteredAndSortedTrainers.slice(0, 10).map((trainer, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Person",
        "name": trainer.profile?.full_name || "Padel Trainer",
        "jobTitle": "Padel Trainer",
        "image": trainer.profile?.avatar_url,
        "address": {
          "@type": "PostalAddress",
          "addressLocality": displayCity
        }
      }
    }))
  };

  const faqQuestions = [
    {
      question: t('cityPage.faq1q', { city: displayCity }),
      answer: trainers.length > 0
        ? t('cityPage.faq1aWithData', { city: displayCity, min: minRate, max: maxRate })
        : t('cityPage.faq1aNoData', { city: displayCity })
    },
    {
      question: t('cityPage.faq2q', { city: displayCity }),
      answer: locations.length > 0
        ? t('cityPage.faq2aWithData', { city: displayCity, count: locations.length, plural: plural(locations.length), clubs: locations.slice(0, 4).map(l => l.name).join(', ') })
        : t('cityPage.faq2aNoData', { city: displayCity })
    },
    {
      question: t('cityPage.faq3q', { city: displayCity }),
      answer: academies.length > 0
        ? t('cityPage.faq3aWithData', { city: displayCity, count: academies.length, academyWord: academies.length === 1 ? t('cityPage.academy') : t('cityPage.academies_word'), academies: academies.map(a => a.name).join(', ') })
        : t('cityPage.faq3aNoData', { city: displayCity })
    },
    {
      question: t('cityPage.faq4q', { city: displayCity }),
      answer: t('cityPage.faq4a', { city: displayCity, count: trainers.length })
    },
    {
      question: t('cityPage.faq5q', { city: displayCity }),
      answer: t('cityPage.faq5a', { city: displayCity })
    },
    {
      question: t('cityPage.faq6q', { city: displayCity }),
      answer: t('cityPage.faq6a', { city: displayCity })
    }
  ];

  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqQuestions.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer
      }
    }))
  };

  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": t('cityPage.home'), "item": `https://padeltrainer.ai/${currentLang}` },
      { "@type": "ListItem", "position": 2, "name": t('cityPage.trainers'), "item": `https://padeltrainer.ai/${currentLang}/trainers` },
      { "@type": "ListItem", "position": 3, "name": displayCity }
    ]
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('cityPage.title', { city: displayCity })}
        description={t('cityPage.description', { city: displayCity, count: trainers.length, minRate })}
        url={`/trainers/${city}`}
        image="https://padeltrainer.ai/og-trainers.png"
        structuredData={[structuredData, faqStructuredData, breadcrumbData]}
      />

      {/* Breadcrumbs */}
      <div className="border-b bg-muted/30">
        <div className="container mx-auto px-4 py-3">
          <nav className="flex items-center gap-2 text-sm text-muted-foreground">
            <LocalizedLink to="/" className="hover:text-primary transition-colors">{t('cityPage.home')}</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <LocalizedLink to="/trainers" className="hover:text-primary transition-colors">{t('cityPage.trainers')}</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground font-medium">{displayCity}</span>
          </nav>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8">
        {/* Hero Section */}
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            {t('cityPage.heroTitle', { city: displayCity })}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {trainers.length > 0
              ? t('cityPage.heroSubtitle', { city: displayCity, count: trainers.length, plural: plural(trainers.length) })
              : t('cityPage.heroSubtitleEmpty', { city: displayCity })
            }
          </p>
        </div>

        {/* Search and Sort */}
        <div className="mb-6 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('cityPage.searchPlaceholder')}
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
              <SelectItem value="rating">{t('cityPage.sortTopRated')}</SelectItem>
              <SelectItem value="experience">{t('cityPage.sortExperience')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground mb-6">
          {t('cityPage.trainersFound', { city: displayCity, count: filteredAndSortedTrainers.length, plural: plural(filteredAndSortedTrainers.length) })}
        </p>

        {/* Trainers Grid */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : filteredAndSortedTrainers.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-muted-foreground mb-4">{t('cityPage.noTrainersFound', { city: displayCity })}</p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button variant="outline" asChild>
                  <LocalizedLink to="/trainers">{t('cityPage.viewAllTrainers')}</LocalizedLink>
                </Button>
                <Button asChild>
                  <Link to="/app/signup/trainer">{t('cityPage.becomeTrainer')}</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredAndSortedTrainers.map((trainer) => (
              <Card
                key={trainer.id}
                className="cursor-pointer hover:shadow-lg transition-all hover:border-primary/50"
                onClick={() => navigate(localizePath(`/trainer/${trainer.slug || trainer.id}`))}
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
                            {t('cityPage.verified')}
                          </Badge>
                        )}
                        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
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
                            ({trainer.reviewCount} {trainer.reviewCount !== 1 ? t('cityPage.reviews') : t('cityPage.review')})
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
                    <div className="flex items-center gap-3 text-muted-foreground">
                      {trainer.profile?.skill_rating && trainer.profile?.rating_system && (
                        <span className="font-medium text-foreground">
                          {trainer.profile.rating_system.toUpperCase()} {trainer.profile.skill_rating}
                        </span>
                      )}
                      {trainer.experience_years && (
                        <span>
                          {trainer.experience_years}{t('cityPage.yearsExp')}
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

        {/* Clubs Section */}
        {locations.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold mb-4 flex items-center gap-2">
              <Building2 className="h-6 w-6" />
              {t('cityPage.clubsTitle', { city: displayCity })}
            </h2>
            <p className="text-muted-foreground mb-6">
              {t('cityPage.clubsCount', { city: displayCity, count: locations.length, plural: plural(locations.length) })}
            </p>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {locations.map(location => (
                <LocationCard
                  key={location.id}
                  location={location}
                  trainerCount={trainerCounts[location.id] || 0}
                  isClaimed={claimedLocationIds.has(location.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* SEO Content Section */}
        <section className="mt-12">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">{t('cityPage.aboutTitle', { city: displayCity })}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-muted-foreground">
              <p>{t('cityPage.aboutIntro', { city: displayCity })}</p>
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-2">{t('cityPage.expectTitle')}</h3>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('cityPage.expect1')}</li>
                  <li>{t('cityPage.expect2')}</li>
                  <li>{t('cityPage.expect3')}</li>
                  <li>{t('cityPage.expect4')}</li>
                </ul>
              </div>
              {locations.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">{t('cityPage.popularClubsTitle', { city: displayCity })}</h3>
                  <p>
                    {t('cityPage.popularClubsIntro', { city: displayCity, count: locations.length, plural: plural(locations.length) })}{' '}
                    {locations.slice(0, 3).map((l, i) => (
                      <span key={l.id}>
                        {i > 0 && ', '}
                        {i === Math.min(locations.length - 1, 2) && i > 0 && 'and '}
                        <LocalizedLink to={`/locations/${l.slug}`} className="text-primary hover:underline">{l.name}</LocalizedLink>
                      </span>
                    ))}
                    {locations.length > 3 && ` ${t('cityPage.andMore', { count: locations.length - 3 })}`}.
                  </p>
                </div>
              )}
              {academies.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">{t('cityPage.academiesTitle', { city: displayCity })}</h3>
                  <p>
                    {academies.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ', '}
                        {i === academies.length - 1 && i > 0 && 'and '}
                        <LocalizedLink to={`/academies/${a.slug}`} className="text-primary hover:underline">{a.name}</LocalizedLink>
                      </span>
                    ))}
                    {' '}{t('cityPage.academiesOffer', { city: displayCity })}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* FAQ Section */}
        {faqQuestions.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold mb-4 flex items-center gap-2">
              <HelpCircle className="h-6 w-6" />
              {t('cityPage.faqTitle')}
            </h2>
            <Accordion type="single" collapsible className="w-full">
              {faqQuestions.map((faq, index) => (
                <AccordionItem key={index} value={`faq-${index}`}>
                  <AccordionTrigger className="text-left">{faq.question}</AccordionTrigger>
                  <AccordionContent>
                    <p className="text-muted-foreground">{faq.answer}</p>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </section>
        )}

        {/* Nearby Cities Section */}
        {nearbyCities.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold mb-2 flex items-center gap-2">
              <Globe className="h-6 w-6" />
              {t('cityPage.nearbyCitiesTitle')}
            </h2>
            <p className="text-muted-foreground mb-6">{t('cityPage.nearbyCitiesSubtitle')}</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {nearbyCities.map(nearbyCity => (
                <LocalizedLink
                  key={nearbyCity.slug}
                  to={`/trainers/${nearbyCity.slug}`}
                  className="block p-4 rounded-lg border bg-card hover:border-primary/50 hover:shadow-md transition-all"
                >
                  <div className="font-medium text-foreground">{nearbyCity.city}</div>
                  <div className="text-sm text-muted-foreground">
                    {t('cityPage.trainersCount', { count: nearbyCity.trainerCount })}
                  </div>
                </LocalizedLink>
              ))}
            </div>
          </section>
        )}
      </main>
    </MarketingLayout>
  );
}
